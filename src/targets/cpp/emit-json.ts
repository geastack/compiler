import { nullableUnionArmsOf } from '../../representation/json-nullable.js'
import type { IrBody, IrOperand, CallOperation } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { hostTemplateFrameOf } from '../../ir/call-entry.js'
import type { DeclarationId, FunctionId, IrValueId, StructuralTypeId } from '../../identity/ids.js'
import type { ClassLayout } from '../../projection/classes.js'
import { classMemberOf, declaredRecordFieldOf } from '../../projection/fields.js'
import { symbolPropertyKeyDeclarationOf } from '../../semantics/model/structural-types.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { representationKey, type RecordAccessor, type Representation } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import { isPrivateNameKey } from '../../semantics/model/structural-types.js'
import {
  bindingReference,
  createCppEmitBlockedError,
  declareCell,
  defineValueAlias,
  operandText,
  type EmitContext
} from './emit-context.js'
import { cellValueText } from './emit-bindings.js'
import { dynamicCarrierBoxText } from './emit-narrowing.js'
import { classBoxable } from './class-layout.js'
import { readsCell } from './deferral-safety.js'
import { cppDateType } from './prototype/emit-prototype-date.js'
import { recordFieldsOfShape, tailAwareFieldWriteText, tailAwareFieldReadText } from './records.js'
import {
  cppBodyName,
  cppClassName,
  cppRecordFieldAttributesName,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppStringLiteral,
  cppTypeOf
} from './types.js'
import { armAt, armIs } from './emit-union-properties.js'

/**
 * `JSON.stringify`/`JSON.parse(...) as T`, rendered by generating one
 * `gea_json_write`/`gea_json_read` free-function overload per record shape a
 * call site actually reaches, instead of routing every call through one boxed
 * `gea_cpp_value`-shaped signature the way `Math`/`Console`/`Storage`'s fixed
 * `HostMember` templates (`host-members.ts`) do.
 *
 * `JSON` cannot be spelled that way at all: its declared signatures are
 * `stringify(value: any, ...) => string` / `parse(text: string, ...) => any`,
 * and a fixed C++ ABI for either is only reachable by boxing -- exactly the
 * `gea_cpp_value` shortcut this compiler forbids. Every call site's REAL
 * argument/asserted-result type is known statically (the checker's own type
 * at that expression), so this file generates a serializer/deserializer typed
 * to that exact call, the same way `emit-json.ts`'s prior art in v1
 * (`compiler/packages/geatsc/src/targets/cpp/runtime/json.h`/`json_reader.h`)
 * already does for its own non-boxing `__gea_json_into`/`__gea_json_read`
 * fast path -- ported here as free functions dispatched by argument-dependent
 * lookup instead of v1's member functions, so this compiler's own
 * `records.ts` struct declarations need no change at all (see citations.md
 * finding 1 and the port's patch.md).
 *
 * Typed records, nullable values, dictionaries and arrays retain their native
 * carriers. See `jsonUnsupportedReason` for the exhaustive supported shapes.
 * Unasserted JSON and explicitly dynamic fields use the dynamic JSON boundary;
 * static fields never need a boxed
 * carrier. A self-referential record TYPE is supported -- it renders a
 * recursive overload pair, forward-declared -- because a recursive type is
 * not a cyclic value; see `jsonUnsupportedReason`'s own note. `undefined` inside a record
 * property is *omitted* on write (ECMA-262 `SerializeJSONProperty`) and left
 * at its default value on read when the document never mentions the key;
 * inside an array position `undefined` -- like a hole -- writes and reads as
 * `null`, which `gea_runtime.h`'s array template owns, not this file.
 *
 * Not implemented, disclosed rather than silently wrong (this port's
 * risks.md): a `.toJSON()` override, `replacer`/`space`/`reviver`, and cycle
 * detection -- a self-referential *value* recurses until the stack overflows,
 * where node raises a `TypeError`.
 */

/** One record struct this program's JSON traffic actually reaches, by its already-sanitized C++ struct name. */
interface JsonStructEntry {
  readonly structName: string
  readonly fields: ReadonlyArray<{ readonly key: string; readonly value: Representation; readonly required: boolean }>
  /**
   * A literal's own accessors. They are own enumerable properties, so
   * SerializeJSONObject (25.5.2.6) reads each through [[Get]] -- the getter
   * runs -- in creation order among the fields (`RecordAccessor.precedingFields`).
   */
  readonly accessors: readonly RecordAccessor[]
  /**
   * The struct is a positional tuple (`RepresentationDeriver.isTupleShape`,
   * the same answer `records.ts` states as `gea_tupleLength()`). A tuple is
   * an Array exotic object, so SerializeJSONArray (25.5.2.6) writes it --
   * `[...]` in index order -- never the `{"0":..}` its index-keyed fields
   * would spell as an ordinary object.
   */
  readonly tuple: boolean
}

/**
 * A union of exactly one JSON-carrying arm plus the absence values, which IS a
 * JSON value: the grammar has a `null` literal, so `string | null` writes as a
 * string or `null` and reads back as whichever the document holds.
 *
 * Collected separately from the records because it needs its own overload pair
 * rather than a struct layout. `null` is not a third case to invent -- the
 * record renderer already writes `optional(T, null)` fields exactly this way.
 * What had no carrier is the THREE-valued `T | null | undefined` an
 * optional-AND-nullable property declares: `union.ts` cannot spend its single
 * absence tag on two distinguishable absence values, so it builds a
 * three-armed `tagged-union` (`undefined`, `null`, `present`) rather than a
 * nested `optional`. `RTCIceCandidateInit.sdpMid` (`sdpMid?: string | null`,
 * declared by the engine, so the app cannot be changed) is the shape that
 * proved it -- it refused `dialer` on both halves, stringify and parse.
 */
interface JsonNullableUnionEntry {
  readonly typeName: string
  /** The arm a document's `null` decodes into. Always present: a union with only an `undefined` absence is an `optional` carrier, never a `tagged-union`. */
  readonly nullIndex: number
  readonly presentIndex: number
  readonly payload: Representation
}

/** Every overload this program's JSON call sites require: record layouts, class writers, and the nullable-union pairs. */
interface JsonCollected {
  readonly structs: Map<string, JsonStructEntry>
  readonly classes: Map<string, JsonClassEntry>
  readonly nullableUnions: Map<string, JsonNullableUnionEntry>
}

/** A fresh, empty collector for one walk. */
const emptyJsonCollected = (): JsonCollected => ({ structs: new Map(), classes: new Map(), nullableUnions: new Map() })

/**
 * What the JSON walk may consult beyond a representation itself.
 *
 * A class instance's own properties are not in its carrier: which keys it
 * owns, in which order, is the class layout's answer (field definitions,
 * base first), so the walk carries the layouts. Both the declaration
 * renderer and every call site build this from the same two sources, so the
 * overload a call names and the overload rendered agree by construction.
 */
interface JsonWorld {
  readonly deriver: RepresentationDeriver
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout> | null
  /** The class fields a reactive plugin stores as cells -- `null` when this build spells no cell at all. */
  readonly reactiveFields: ReadonlyMap<DeclarationId, ReadonlySet<string>> | null
}

const jsonWorldOf = (ctx: EmitContext): JsonWorld => ({
  deriver: ctx.deriver,
  classes: ctx.classes,
  reactiveFields: ctx.hosts.reactive.cell === null ? null : ctx.hosts.reactive.fields
})

/** One own data property a class writer serializes: its key, the struct member holding it, and that member's carrier. */
interface JsonClassMember {
  readonly key: string
  readonly value: Representation
}

/** The write-only `gea_json_write` overload for one class struct. */
interface JsonClassEntry {
  readonly structName: string
  readonly members: readonly JsonClassMember[]
}

/** Every carrier kind whose value is a function object. SerializeJSONProperty (ECMA-262 25.5.2.2 step 10) answers `undefined` for one, so an own property holding it is left out of the object. */
const callableKinds: ReadonlySet<Representation['kind']> = new Set([
  'function',
  'function-family',
  'constructor-family',
  'constructor-value-dispatch',
  'function-and-constructor',
  'function-value-family',
  'function-value-dispatch',
  'callable-identity',
  'constructor-identity',
  'error-constructor',
  'typed-array-constructor',
  'generic-function-set'
])

/** Whether every value `representation` can hold is either a function or `undefined` -- a property JSON always omits. */
const neverSerialized = (representation: Representation): boolean => {
  if (representation.kind === 'undefined' || callableKinds.has(representation.kind)) return true
  if (representation.kind === 'optional') return representation.absence === 'undefined' && neverSerialized(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => neverSerialized(arm.value))
  return false
}

/** Whether some arm of `representation` holds a function object while another does not -- a member whose presence in the text depends on a value this writer cannot dispatch on. */
const partlyCallable = (representation: Representation): boolean => {
  if (callableKinds.has(representation.kind)) return true
  if (representation.kind === 'optional') return partlyCallable(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => partlyCallable(arm.value))
  return false
}

/**
 * The own enumerable string-keyed properties an instance of `declaration`
 * has, in the order OrdinaryOwnPropertyKeys (ECMA-262 10.1.11.1) lists them --
 * or the reason no native writer can list them.
 *
 * A class instance is created by the base's construction first, and each
 * class's field definitions run in declaration order (ECMA-262 15.7.14
 * `InitializeInstanceElements`), so the keys are the chain's fields root
 * first. A derived redeclaration of an inherited field redefines the existing
 * property in place and keeps its position. Methods and accessors live on the
 * prototype and are never own; a private name is a PrivateElement, not a
 * property; a symbol key is not a string key. Anything a program ADDS past its
 * declared fields lives in the object's expando sidecar, which the writer
 * reads after these -- a declared field exists from construction, so it
 * precedes every key the sidecar could hold.
 *
 * Refused rather than approximated: a class something extends (a carrier
 * typed as it may hold a subclass instance with more own properties, and this
 * writer is chosen by the static type), a class whose chain answers `toJSON`
 * (SerializeJSONProperty would call it -- only the top-level direct case is
 * rendered, by `classToJsonOf`), a native or reparented base (its own
 * properties are the runtime's, or its construction never runs), and a
 * reactive cell (the member is not the value).
 */
const classJsonMembersOf = (
  world: JsonWorld,
  representation: Extract<Representation, { readonly kind: 'class-ref' }>
): readonly JsonClassMember[] | string => {
  const classes = world.classes
  if (classes === null) return 'no class layouts reach this JSON walk'
  const declaration = representation.declaration
  const layout = classes.get(declaration)
  if (layout === undefined) return `class ${declaration} has no published layout`
  for (const other of classes.values()) {
    if (other.base === declaration) {
      return (
        `class ${declaration} is extended by ${other.declaration}, so a value typed as it may be a subclass instance with own ` +
        'properties this statically chosen writer does not list'
      )
    }
  }
  if (classMemberOf(classes, declaration, 'toJSON') !== null) {
    return `class ${declaration} answers toJSON, which SerializeJSONProperty calls before writing; only a direct no-argument toJSON at the top level is rendered`
  }
  const chain: ClassLayout[] = []
  const seen = new Set<DeclarationId>()
  for (let current: ClassLayout | undefined = layout; current !== undefined;) {
    if (seen.has(current.declaration)) return `class ${declaration} has a cyclic base chain`
    seen.add(current.declaration)
    if (current.nativeBase !== null)
      return `class ${current.declaration} extends a native ${current.nativeBase.protocol}, whose own properties the runtime holds`
    if (current.prototypeBase === true)
      return `class ${current.declaration} was reparented, so its base's construction -- and its fields -- never run`
    chain.unshift(current)
    current = current.base === null ? undefined : classes.get(current.base)
    if (current === undefined && chain[0]?.base !== null) return `a base of class ${declaration} has no published layout`
  }
  const members: JsonClassMember[] = []
  const listed = new Set<string>()
  for (const link of chain) {
    for (const field of link.fields) {
      if (field.syntheticSubclassMemberOverlay || listed.has(field.key)) continue
      // A private name keys its field `#name` (`class-lifecycle.ts`), the
      // spelling the layout itself uses; a symbol key is `sym(...)`.
      if (isPrivateNameKey(field.key) || symbolPropertyKeyDeclarationOf(field.key) !== null) continue
      listed.add(field.key)
      if (world.reactiveFields?.get(link.declaration)?.has(field.key) === true) {
        return `field "${field.key}" of class ${link.declaration} is a reactive cell, not the value it holds`
      }
      const storage = declaredRecordFieldOf(world.deriver, representation, field.key, classes)
      if (storage === null) return `field "${field.key}" of class ${link.declaration} has no storage in its struct`
      members.push({ key: field.key, value: storage.value })
    }
  }
  return members
}

/** The class-instance case of `jsonUnsupportedReason`: collects a write-only overload over the instance's own properties. */
const classJsonUnsupportedReason = (
  world: JsonWorld,
  representation: Extract<Representation, { readonly kind: 'class-ref' }>,
  collected: JsonCollected,
  visiting: ReadonlySet<string>,
  direction: 'write' | 'read',
  inRecordPair: boolean
): string | null => {
  if (direction === 'read') {
    return 'a JSON document decodes into plain objects, never into a class instance; `JSON.parse(text) as C` asserts a prototype the grammar cannot carry'
  }
  if (inRecordPair) {
    return (
      'a class instance inside a record has no JSON mapping here: a record renders its write and read overloads as one pair, and ' +
      'the read half would have to decode a class instance out of a document'
    )
  }
  const structName = cppClassName(representation.declaration)
  // A class reached while it is still being walked is a recursive TYPE, not a
  // cyclic value -- the record case's own reasoning, unchanged.
  if (visiting.has(structName) || collected.classes.has(structName)) return null
  const members = classJsonMembersOf(world, representation)
  if (typeof members === 'string') return members
  const stillVisiting = new Set(visiting)
  stillVisiting.add(structName)
  for (const member of members) {
    if (neverSerialized(member.value)) continue
    if (partlyCallable(member.value)) {
      return `field "${member.key}" of class ${representation.declaration} may hold a function or a value, and only the value is written`
    }
    // Both absences are spelled by the writer itself: `undefined` omits the
    // property, `null` writes the literal.
    const payload = member.value.kind === 'optional' ? member.value.payload : member.value
    const reason = jsonUnsupportedReason(world, payload, collected, stillVisiting, 'write', false)
    if (reason !== null) return `field "${member.key}" of class ${representation.declaration}: ${reason}`
  }
  collected.classes.set(structName, { structName, members })
  return null
}

/** Runtime key ordering selects a field, while its value retains its native carrier. */
const renderJsonMemberWriter = (
  structName: string,
  fields: readonly { readonly key: string; readonly value: Representation }[]
): string => {
  const lines = [
    `inline bool gea_json_write_member(std::string& out, const ${structName}& value, const gea::PropertyKey& key, bool& first) {`
  ]
  for (const field of fields) {
    const member = tailAwareFieldReadText(fields, field.key, 'value.')
    lines.push(`  if (key.text() == ${cppStringLiteral(field.key)}) {`)
    if (neverSerialized(field.value)) {
      lines.push('    return true;', '  }')
      continue
    }
    const arms = nullableUnionArmsOf(field.value)
    if (field.value.kind === 'optional' && field.value.absence === 'undefined') lines.push(`    if (!${member}.has_value()) return true;`)
    if (arms !== null && arms.undefinedIndex !== -1) lines.push(`    if (${member}.is<${arms.undefinedIndex}>()) return true;`)
    lines.push(`    if (!first) out += ',';`, `    out += ${jsonKeyLiteral(field.key)};`)
    if (field.value.kind === 'optional') lines.push(`    if (${member}.has_value()) gea_json_write(out, *${member}); else out += "null";`)
    else lines.push(`    gea_json_write(out, ${member});`)
    lines.push('    first = false;', '    return true;', '  }')
  }
  lines.push('  return false;', '}')
  return lines.join('\n')
}

/**
 * The `gea_json_write` overload for one class struct: SerializeJSONObject
 * (ECMA-262 25.5.2.5) over the own properties `classJsonMembersOf` listed.
 *
 * A declared field can still be absent (deleted) or non-enumerable
 * (`Object.defineProperty`), which is what its presence bit and attribute
 * triple record, so each is asked at run time; a member holding `undefined`
 * is omitted exactly as the record writer omits one. Write-only: nothing in a
 * document decodes into a class.
 */
const renderJsonClassOverload = (entry: JsonClassEntry): string => {
  const lines = [
    `inline void gea_json_write(std::string& out, const ${entry.structName}& value) {`,
    `  out += '{';`,
    `  bool gea_json_first = true;`
  ]
  for (const member of entry.members) {
    if (neverSerialized(member.value)) continue
    const field = tailAwareFieldReadText(entry.members, member.key, 'value.')
    const owned = `value.${cppRecordFieldPresenceName(member.key)} && value.${cppRecordFieldAttributesName(member.key)}.enumerable`
    const keyLiteral = jsonKeyLiteral(member.key)
    const arms = nullableUnionArmsOf(member.value)
    const guard =
      member.value.kind === 'optional' && member.value.absence === 'undefined'
        ? ` && ${field}.has_value()`
        : arms !== null && arms.undefinedIndex !== -1
          ? ` && !${field}.is<${arms.undefinedIndex}>()`
          : ''
    const written =
      member.value.kind === 'optional' && member.value.absence === 'undefined'
        ? `*${field}`
        : member.value.kind === 'optional'
          ? null
          : field
    lines.push(`  if (${owned}${guard}) {`)
    lines.push(`    if (!gea_json_first) out += ',';`)
    lines.push(`    out += ${keyLiteral};`)
    if (written === null) lines.push(`    if (${field}.has_value()) gea_json_write(out, *${field}); else out += "null";`)
    else lines.push(`    gea_json_write(out, ${written});`)
    lines.push(`    gea_json_first = false;`)
    lines.push(`  }`)
  }
  lines.push(`  gea::json::writeNativeExpandoMembers(out, &value, gea_json_first);`)
  lines.push(`  out += '}';`)
  lines.push(`}`)
  return `${renderJsonMemberWriter(entry.structName, entry.members)}\n\n${lines.join('\n')}`
}

/**
 * Whether `representation` has a native `gea_json_write`/`gea_json_read`
 * mapping, and -- as a side effect -- every record struct reaching that
 * mapping requires, collected into `structsByName` (keyed by C++ struct name,
 * so two call sites naming the same shape render its overload pair once).
 *
 * Returns `null` when supported; otherwise the reason, prefixed by nothing --
 * callers add their own "JSON.stringify/parse cannot ... :" framing so one
 * message reads naturally however deep the field/element nesting that
 * produced it.
 *
 * `visiting` is the self-reference guard: a record shape entered while it is
 * still on the walk's own stack is a cycle, refused by name instead of
 * recursing forever the way a genuinely cyclic *value* would at runtime (see
 * this file's own top comment).
 */
const jsonUnsupportedReason = (
  world: JsonWorld,
  representation: Representation,
  collected: JsonCollected,
  visiting: ReadonlySet<string>,
  direction: 'write' | 'read',
  /** Whether this value is a field of a generated record, whose write and read overloads render as one pair. */
  inRecordPair = false
): string | null => {
  const deriver = world.deriver
  switch (representation.kind) {
    case 'dynamic':
      return null
    case 'dictionary':
      return representation.key === 'string'
        ? jsonUnsupportedReason(world, representation.value, collected, visiting, direction, inRecordPair)
        : `representation "${representationKey(representation)}" has no native JSON.stringify/parse mapping`
    case 'optional':
      return representation.absence === 'null'
        ? jsonUnsupportedReason(world, representation.payload, collected, visiting, direction, inRecordPair)
        : `representation "${representationKey(representation)}" has no native JSON.stringify/parse mapping`
    case 'string':
      return null
    // One-valued carriers: `null` writes `null`; `undefined` writes `null` as
    // an array element (ECMA-262 25.5.2.6) and is omitted as a record member
    // (the struct writer skips it). Without them a record holding either --
    // `{ NULL: null }`, `{ b: [] }` typed `never[]` -- fell back to its box.
    case 'null':
    case 'undefined':
      return null
    case 'scalar':
      // `bigint`/`int32`/`uint32`/`float64` are narrower numeric domains this
      // backend infers for typed-array elements and similar contexts, never
      // for an ordinary interface field a JSON document would hold -- no
      // corpus call site needs them, and JSON's own grammar has no way to
      // round-trip a `bigint` losslessly through `number` anyway (ECMA-262
      // `JSON.stringify` itself throws a `TypeError` on a real `bigint`).
      return representation.domain === 'number' || representation.domain === 'boolean'
        ? null
        : `a "${representation.domain}" scalar has no JSON.stringify/parse mapping`
    case 'array-object':
      return jsonUnsupportedReason(world, representation.element, collected, visiting, direction, inRecordPair)
    case 'record':
    case 'native-record-ref': {
      // A carrier whose struct the HOST declares has no compiler-emitted
      // layout at all (`records.ts` renders none when `native` is stated), so
      // the field-by-field overload pair below would name a type that does not
      // exist -- which is a clang error rather than a refusal. Answered here,
      // ahead of the layout walk, for every such carrier.
      if (representation.kind === 'native-record-ref' && representation.native !== null) {
        if (representation.native !== cppDateType) {
          return (
            `"${representation.native}" is a struct the host declares, so this compiler emits no layout for it and cannot ` +
            'render a field-by-field JSON overload against it'
          )
        }
        // A Date is the one such carrier with a real answer, and only for a
        // value this walk reaches OUTSIDE a generated record: ECMA-262
        // 25.5.2.2 step 3 calls `toJSON`, so writing one is its ISO string
        // (or `null` for a non-finite time value), which `gea_runtime.h`
        // supplies as its own `gea_json_write` overload -- nothing to collect
        // here, because nothing is generated for it. Measured against node:
        // `JSON.stringify(new Date(0))` and `JSON.stringify([d1, d2])` both
        // match byte-for-byte.
        //
        // Three cases are refused instead, each by name:
        //
        //  - READING one. JSON has no date type, so nothing in a document
        //    decodes into a Date; `JSON.parse(text) as Date` asserts a shape
        //    the grammar cannot carry (node answers a plain string for it).
        //  - A Date as a FIELD of a record. `renderJsonRecordOverloads` emits
        //    the write AND read halves of a struct's pair together, so a
        //    record with a Date member would render a `gea_json_read(reader,
        //    out.at)` against a Date -- the read this same walk just refused,
        //    reaching clang as an error rather than as a refusal. A non-empty
        //    `visiting` is exactly "inside a generated struct"; an array
        //    element is not, because the array writer is a runtime template
        //    with no generated pair.
        if (direction === 'read') {
          return (
            'JSON has no date type, so nothing in a document decodes into a Date; `JSON.parse(text) as Date` asserts a shape the ' +
            'grammar cannot carry (node answers a string for it), and reviving one is the `reviver` parameter this backend does not implement'
          )
        }
        if (inRecordPair) {
          return (
            'a Date inside a record has no JSON mapping here: a record renders its write and read overloads as one pair, and ' +
            'the read half would have to decode a Date out of a document that has no date type. A Date serialized on its own, ' +
            'or as an array element, does render'
          )
        }
        return null
      }
      const structName = cppRecordStructName(representation.shapeId)
      // A record reached while it is still on this walk's own stack is a
      // RECURSIVE TYPE, and a recursive type is not a cyclic value. `type Node
      // = { children: Node[] }` describes every tree as well as every cycle,
      // and a tree serializes finitely -- which is what the corpus actually
      // holds: `bench/comparison`'s `json_stringify_nested` builds a depth-6
      // fan-4 tree and node prints it without complaint.
      //
      // So the answer is the overload pair, which is recursive C++ and
      // terminates on the same values the language terminates on.
      // `renderJsonStructDeclarations` forward-declares every pair before any
      // body, so a struct calling its own overload -- directly or through the
      // array template -- names one already declared.
      //
      // What this gives up is the compile-time refusal of a cyclic VALUE, and
      // it was never a sound one: the type says nothing about whether a given
      // value has a back edge. A real cycle recurses until the stack
      // overflows, which is exactly what this file's own header already
      // discloses for every other self-referential value, and what node
      // answers instead is a `TypeError` this backend does not raise.
      if (visiting.has(structName)) return null
      if (collected.structs.has(structName)) return null
      const fields = recordFieldsOfShape(deriver, representation.shapeId)
      if (fields === null) return `no record layout could be derived for shape ${representation.shapeId}`
      const stillVisiting = new Set(visiting)
      stillVisiting.add(structName)
      for (const field of fields) {
        // An actual `T | undefined` field (as opposed to a bare `?` marker,
        // which `records.ts` documents as never producing an `optional`
        // carrier at all) is the one place `optional` is legal here: ECMA-262
        // omits the whole property rather than writing `null` for it, which
        // only a record's own field position has a spelling for -- an array
        // element or a bare call argument does not, so `optional` anywhere
        // else falls through to the `default:` refusal below.
        const fieldRepresentation =
          field.value.kind === 'optional' && field.value.absence === 'undefined' ? field.value.payload : field.value
        const reason = jsonUnsupportedReason(world, fieldRepresentation, collected, stillVisiting, direction, true)
        if (reason) return `field "${field.key}" of record "${structName}": ${reason}`
      }
      // Recorded only after every field resolved: a record that turns out to
      // be unsupported must not leave a partial entry another call site's
      // `collected.structs.has(structName)` short-circuit could mistake for done.
      const layout = representation.kind === 'record' ? representation : deriver.layoutOf(representation.shapeId as StructuralTypeId)
      const accessors = layout.kind === 'record' ? layout.accessors.filter((accessor) => !cppRecordFieldKeyIsSymbol(accessor.key)) : []
      const tuple = deriver.isTupleShape(representation.shapeId as StructuralTypeId)
      collected.structs.set(structName, { structName, fields, accessors, tuple })
      return null
    }
    case 'tagged-union': {
      const arms = nullableUnionArmsOf(representation)
      if (arms === null) {
        return (
          'representation kind "tagged-union" has no native JSON.stringify/parse mapping unless its arms are one JSON-carrying type ' +
          'plus `null` (optionally with `undefined` too); a wider sum has no discriminator in the document to decode back with'
        )
      }
      const reason = jsonUnsupportedReason(world, arms.payload, collected, visiting, direction, inRecordPair)
      if (reason !== null) return reason
      const typeName = cppTypeOf(representation)
      // Keyed by the C++ type, so two shapes that lower to the same union
      // render one pair -- the same rule the records above follow.
      if (!collected.nullableUnions.has(typeName)) {
        collected.nullableUnions.set(typeName, {
          typeName,
          nullIndex: arms.nullIndex,
          presentIndex: arms.presentIndex,
          payload: arms.payload
        })
      }
      return null
    }
    case 'class-ref':
      return classJsonUnsupportedReason(world, representation, collected, visiting, direction, inRecordPair)
    default:
      // `dynamic`, `record-with-index`, `dictionary`, `function`,
      // `promise`, and everything else this switch does not name above: none
      // has a native JSON mapping, and reaching for `gea_cpp_value` to give it
      // one anyway is exactly the boxing shortcut this compiler forbids (see
      // this repo's root CLAUDE.md, "The Compiler Rule: No Boxing").
      return `representation "${representationKey(representation)}" has no native JSON.stringify/parse mapping`
  }
}

/**
 * The `gea_json_write`/`gea_json_read` pair for one nullable union.
 *
 * A standalone overload on the union type rather than a case inside the record
 * renderer, so the same shape serializes wherever it appears -- a field, an
 * array element, or the whole argument -- and so the record renderer's plain
 * field path reaches it by ordinary overload resolution. The one thing a
 * standalone overload cannot express is a record field's `undefined` arm,
 * because omitting a property is the enclosing OBJECT's spelling and not the
 * value's; `renderJsonRecordOverloads` guards that case itself, exactly as it
 * already does for an `optional(T, undefined)` field.
 *
 * The read side asks the reader for a `null` literal FIRST (`consumeNull`
 * leaves the position untouched when the next value is not one), because that
 * is the only question whose answer picks the arm; anything else is the payload
 * and is decoded by the payload's own overload.
 */
const renderJsonNullableUnionOverloads = (entry: JsonNullableUnionEntry): string => {
  const payloadType = cppTypeOf(entry.payload)
  const write = [
    `inline void gea_json_write(std::string& out, const ${entry.typeName}& value) {`,
    `  if (value.is<${entry.presentIndex}>()) { gea_json_write(out, value.get<${entry.presentIndex}>()); return; }`,
    `  out += "null";`,
    `}`
  ]
  const read = [
    `inline void gea_json_read(gea::json::Reader& reader, ${entry.typeName}& out) {`,
    `  if (reader.consumeNull()) {`,
    `    out = ${entry.typeName}::ofArm<${entry.nullIndex}>(${entry.typeName}::ArmType<${entry.nullIndex}>{});`,
    `    return;`,
    `  }`,
    `  ${payloadType} gea_json_arm{};`,
    `  gea_json_read(reader, gea_json_arm);`,
    `  out = ${entry.typeName}::ofArm<${entry.presentIndex}>(gea_json_arm);`,
    `}`
  ]
  return `${write.join('\n')}\n\n${read.join('\n')}`
}

/**
 * A record field's JS property name, JSON-escaped and wrapped as a C++ string
 * literal ending in the field's trailing colon -- e.g. `id` becomes the C++
 * literal spelling `"\"id\":"`.
 *
 * `leading` is folded into the SAME literal rather than appended separately:
 * the separator before a field the writer always emits is statically known, and
 * `out += ",\"score\":"` is one capacity check where `out += ','; out +=
 * "\"score\":";` is two.
 */
const jsonKeyLiteral = (key: string, leading = ''): string => {
  let jsonEscaped = ''
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '"') jsonEscaped += '\\"'
    else if (ch === '\\') jsonEscaped += '\\\\'
    else if (ch === '\b') jsonEscaped += '\\b'
    else if (ch === '\f') jsonEscaped += '\\f'
    else if (ch === '\n') jsonEscaped += '\\n'
    else if (ch === '\r') jsonEscaped += '\\r'
    else if (ch === '\t') jsonEscaped += '\\t'
    else if (code < 0x20) jsonEscaped += `\\u${code.toString(16).padStart(4, '0')}`
    else jsonEscaped += ch
  }
  return cppStringLiteral(`${leading}"${jsonEscaped}":`)
}

/**
 * Whether a property name can be matched against the document BYTE FOR BYTE,
 * which is what `gea::json::Reader::keyIs` does -- no scan for the key's closing
 * quote, just a length-anchored `memcmp`.
 *
 * A key needing any JSON escape (a quote, a backslash, a control character) is
 * spelled differently in the document than in the C++ literal, and a non-ASCII
 * one is a different number of bytes than characters. Both answer `false`, and
 * the generated reader then uses only its decoded chain -- the same one that
 * catches an escaped spelling of an ordinary key.
 */
const isPlainAsciiKey = (key: string): boolean => {
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code > 0x7e || ch === '"' || ch === '\\') return false
  }
  return true
}

/** The `gea_json_write(std::string&, const StructName&)` / `gea_json_read(gea::json::Reader&, StructName&)` overload pair for one record struct, walking its real fields -- never a boxed intermediate. */
/**
 * The overload pair for a positional tuple struct: an Array to JSON.
 *
 * SerializeJSONArray writes every index below `length`, and an element that is
 * `undefined` (or a function or symbol) as `null` -- the one place JSON spells
 * `undefined` -- rather than omitting it as an object property would be. A
 * tuple's `length` is its leading present slots (`gea_tupleLength()`), and
 * only a trailing optional position can be absent, so an absent slot ends the
 * array. The reader is the positional mirror: element N decodes into slot N.
 */
const renderJsonTupleOverloads = (entry: JsonStructEntry): string => {
  const writeLines = [`inline void gea_json_write(std::string& out, const ${entry.structName}& value) {`, `  out += '[';`]
  const readLines = [
    `inline void gea_json_read(gea::json::Reader& reader, ${entry.structName}& out) {`,
    `  if (!reader.consumeIf('[')) {`,
    `    reader.skipValue();`,
    `    return;`,
    `  }`,
    `  if (reader.consumeIf(']')) return;`,
    `  for (std::size_t gea_json_at = 0;; ++gea_json_at) {`,
    `    switch (gea_json_at) {`
  ]
  let closes = 0
  for (const [index, field] of entry.fields.entries()) {
    const member = tailAwareFieldReadText(entry.fields, field.key, 'value.')
    const separator = index === 0 ? '' : `  out += ',';`
    if (!field.required) {
      writeLines.push(`  if (value.${cppRecordFieldPresenceName(field.key)}) {`)
      closes += 1
    }
    if (separator) writeLines.push(separator)
    const unionArms = nullableUnionArmsOf(field.value)
    if (unionArms !== null && unionArms.undefinedIndex !== -1) {
      writeLines.push(`  if (${member}.is<${unionArms.undefinedIndex}>()) out += "null"; else gea_json_write(out, ${member});`)
    } else if (field.value.kind === 'optional' && (field.value.absence === 'undefined' || field.value.absence === 'null')) {
      writeLines.push(`  if (${member}.has_value()) gea_json_write(out, *${member}); else out += "null";`)
    } else {
      writeLines.push(`  gea_json_write(out, ${member});`)
    }
    const target = tailAwareFieldWriteText(entry.fields, field.key)
    const optional = field.value.kind === 'optional' && (field.value.absence === 'undefined' || field.value.absence === 'null')
    readLines.push(`      case ${index}: {`)
    if (optional) {
      const payloadType = cppTypeOf(field.value.kind === 'optional' ? field.value.payload : field.value)
      readLines.push(
        `        if (!reader.consumeNull()) {`,
        `          ${payloadType} gea_json_element{};`,
        `          gea_json_read(reader, gea_json_element);`,
        `          out.${target} = gea_json_element;`,
        `        }`
      )
    } else {
      readLines.push(`        gea_json_read(reader, out.${target});`)
    }
    if (!field.required) readLines.push(`        out.${cppRecordFieldPresenceName(field.key)} = true;`)
    readLines.push(`        break;`, `      }`)
  }
  for (let close = 0; close < closes; close++) writeLines.push(`  }`)
  writeLines.push(`  out += ']';`, `}`)
  readLines.push(
    `      default:`,
    `        reader.skipValue();`,
    `        break;`,
    `    }`,
    `    if (!reader.advanceArray()) break;`,
    `  }`,
    `}`
  )
  return `${writeLines.join('\n')}\n\n${readLines.join('\n')}`
}

const renderJsonRecordOverloads = (entry: JsonStructEntry): string => {
  if (entry.tuple) return renderJsonTupleOverloads(entry)
  // Whether the object's first property is known at GENERATION time. It is,
  // until a field that ECMA-262 25.5.2.2 may omit is reached -- and for a record
  // with no such field (every record in the corpus) the whole `gea_json_first`
  // bookkeeping disappears and each separator is folded into the key literal.
  const omittable = (field: JsonStructEntry['fields'][number]): boolean => {
    if (!field.required) return true
    const arms = nullableUnionArmsOf(field.value)
    if (arms !== null && arms.undefinedIndex !== -1) return true
    return field.value.kind === 'optional' && field.value.absence === 'undefined'
  }
  const anyOmittable = entry.fields.some(omittable) || entry.accessors.length > 0
  let staticFirst: boolean | null = true
  const writeLines = [`inline void gea_json_write(std::string& out, const ${entry.structName}& value) {`, `  out += '{';`]
  if (anyOmittable) writeLines.push(`  bool gea_json_first = true;`)
  // The body that reads ONE field's value, rendered once and used by both key
  // chains below.
  const readBodyOf = (field: JsonStructEntry['fields'][number], indent: string): string[] => {
    const target = tailAwareFieldWriteText(entry.fields, field.key)
    const optional = field.value.kind === 'optional' && (field.value.absence === 'undefined' || field.value.absence === 'null')
    if (!optional) {
      return [
        `${indent}gea_json_read(reader, out.${target});`,
        ...(!field.required ? [`${indent}out.${cppRecordFieldPresenceName(field.key)} = true;`] : [])
      ]
    }
    const payloadType = cppTypeOf(field.value.kind === 'optional' ? field.value.payload : field.value)
    if (field.value.kind === 'optional' && field.value.absence === 'null') {
      return [
        `${indent}gea_json_read(reader, out.${target});`,
        ...(!field.required ? [`${indent}out.${cppRecordFieldPresenceName(field.key)} = true;`] : [])
      ]
    }
    return [
      `${indent}${payloadType} gea_json_field{};`,
      `${indent}gea_json_read(reader, gea_json_field);`,
      `${indent}out.${target} = gea_json_field;`,
      ...(!field.required ? [`${indent}out.${cppRecordFieldPresenceName(field.key)} = true;`] : [])
    ]
  }
  const readLines = [
    `inline void gea_json_read(gea::json::Reader& reader, ${entry.structName}& out) {`,
    `  if (!reader.enterObject()) return;`,
    // The key is taken as a VIEW of the document rather than copied into a
    // buffer per property: an unescaped key is already a contiguous run there,
    // and the comparisons below then discriminate on length before touching a
    // byte. `gea_json_scratch` is the reader's decode buffer for the escaped
    // key that cannot be viewed -- one per object, not one per key.
    `  std::string gea_json_scratch;`,
    `  std::string_view gea_json_key;`,
    `  for (;;) {`
  ]
  // The fast chain: each candidate field name matched against the document
  // where it stands, no scan for its closing quote. `nextKey` had to find that
  // quote before it could compare anything at all, and finding it was 19% of
  // `json_parse_records`. Only reachable when every key is plain ASCII -- see
  // `isPlainAsciiKey` -- and a key the chain misses (an escaped spelling, a
  // space before the colon, a key this record does not declare) falls through
  // to the decoded chain below, which is what the reader always did.
  const fastKeys = entry.fields.length > 0 && entry.fields.every((field) => isPlainAsciiKey(field.key))
  // Both chains answer one question -- WHICH declared field this key names --
  // and the answer is an index into a single `switch` that holds each field's
  // read body exactly once. Rendering the body under every match spelled every
  // field twice, once per chain: N extra copies of a read per N-field record,
  // which the C++ compiler cannot share and which doubled the reader of every
  // store record in `examples/apps/weather`.
  readLines.push(`    int gea_json_which = -1;`)
  if (fastKeys) {
    entry.fields.forEach((field, at) => {
      readLines.push(
        `    ${at === 0 ? 'if' : 'else if'} (reader.keyIs(${cppStringLiteral(field.key)}, ${field.key.length})) gea_json_which = ${at};`
      )
    })
    readLines.push(`    else {`)
  }
  const inner = fastKeys ? '      ' : '    '
  readLines.push(`${inner}if (!reader.nextKey(gea_json_key, gea_json_scratch)) break;`)
  let firstKey = true
  // An accessor's value is known only once its getter ran, so whether it is
  // written (a getter answering `undefined` or a function is omitted) and
  // hence the separator after it are run-time facts, like an omittable
  // field's. The read goes through the struct's own-field hook, the one that
  // already runs the getter for a boxed read, so the two cannot disagree.
  const writeAccessorsAt = (position: number): void => {
    for (const accessor of entry.accessors) {
      if ((accessor.precedingFields ?? entry.fields.length) !== position) continue
      if (staticFirst !== null) {
        if (!staticFirst) writeLines.push(`  gea_json_first = false;`)
        staticFirst = null
      }
      const presence = `value.${cppRecordFieldPresenceName(accessor.key)}`
      const attributes = `value.${cppRecordFieldAttributesName(accessor.key)}`
      writeLines.push(`  if (${presence} && ${attributes}.enumerable) {`)
      writeLines.push(`    gea::Value gea_json_member;`)
      writeLines.push(
        `    if (!value.gea_readOwnField(gea::PropertyKey::string(${cppStringLiteral(accessor.key)}), gea_json_member)) ` +
          `gea::host::throwRuntimeError("TypeError", "JSON.stringify could not read the accessor ${accessor.key}");`
      )
      writeLines.push(
        `    const auto gea_json_member_tag = gea_json_member.tag();`,
        `    if (gea_json_member_tag != gea::Value::Tag::Undefined && gea_json_member_tag != gea::Value::Tag::Function && gea_json_member_tag != gea::Value::Tag::Symbol) {`,
        `      if (!gea_json_first) out += ',';`,
        `      out += ${jsonKeyLiteral(accessor.key)};`,
        `      gea_json_write(out, gea_json_member);`,
        `      gea_json_first = false;`,
        `    }`,
        `  }`
      )
    }
  }
  for (const [index, field] of entry.fields.entries()) {
    writeAccessorsAt(index)
    if (field.value.kind === 'undefined') {
      // ECMA-262 25.5.2.5 omits a property whose value is `undefined`; one
      // that can hold nothing else is never written, and is still matched
      // (and skipped) when a document names it.
      readLines.push(`${inner}${firstKey ? 'if' : 'else if'} (gea_json_key == ${cppStringLiteral(field.key)}) gea_json_which = ${index};`)
      firstKey = false
      continue
    }
    const member = tailAwareFieldReadText(entry.fields, field.key, 'value.')
    const keyLiteral = jsonKeyLiteral(field.key)
    // The read side compares the DECODED key text `nextKey` produced against
    // the field's own JS property name -- an ordinary C++ string literal, not
    // the JSON-escaped-then-quoted-with-a-colon form `jsonKeyLiteral` builds
    // for the write side's output stream.
    const keyComparisonLiteral = cppStringLiteral(field.key)
    const isOptionalUndefined = field.value.kind === 'optional' && field.value.absence === 'undefined'
    // `T | null | undefined` reaches here as a three-armed union rather than
    // an `optional`, so the omission ECMA-262 25.5.2.2 requires for the
    // `undefined` arm has to be asked of the union directly. Its `null` arm
    // and its payload are the standalone overload's business, not this one's.
    const unionArms = nullableUnionArmsOf(field.value)
    const undefinedArmIndex = unionArms !== null && unionArms.undefinedIndex !== -1 ? unionArms.undefinedIndex : null
    // An omittable field cannot answer "is this the first property?" until it
    // runs, so the first one hands the question over to `gea_json_first` -- and
    // the flag has to be told what the fields before it already decided.
    if (omittable(field) && staticFirst !== null) {
      if (!staticFirst) writeLines.push(`  gea_json_first = false;`)
      staticFirst = null
    }
    // The separator, for a field the writer always emits: nothing before the
    // first property, a comma after it, and only a record that has already
    // passed an omittable field asks at run time.
    const alwaysWritten = !omittable(field)
    const foldedKey = alwaysWritten && staticFirst !== null ? jsonKeyLiteral(field.key, staticFirst ? '' : ',') : keyLiteral
    if (alwaysWritten && staticFirst !== null) staticFirst = false
    else if (alwaysWritten) writeLines.push(`  if (!gea_json_first) out += ',';`)
    if (!field.required) writeLines.push(`  if (value.${cppRecordFieldPresenceName(field.key)}) {`)
    if (undefinedArmIndex !== null) {
      writeLines.push(`  if (!${member}.is<${undefinedArmIndex}>()) {`)
      writeLines.push(`    if (!gea_json_first) out += ',';`)
      writeLines.push(`    out += ${keyLiteral};`)
      writeLines.push(`    gea_json_write(out, ${member});`)
      writeLines.push(`    gea_json_first = false;`)
      writeLines.push(`  }`)
    } else if (isOptionalUndefined) {
      writeLines.push(`  if (${member}.has_value()) {`)
      writeLines.push(`    if (!gea_json_first) out += ',';`)
      writeLines.push(`    out += ${keyLiteral};`)
      writeLines.push(`    gea_json_write(out, *${member});`)
      writeLines.push(`    gea_json_first = false;`)
      writeLines.push(`  }`)
    } else if (field.value.kind === 'optional' && field.value.absence === 'null') {
      // ECMA-262 does not omit a `T | null` property the way it omits
      // `undefined` -- it always writes the key, with `null` when absent.
      if (!field.required) writeLines.push(`  if (!gea_json_first) out += ',';`)
      writeLines.push(`  out += ${foldedKey};`)
      writeLines.push(`  if (${member}.has_value()) gea_json_write(out, *${member}); else out += "null";`)
      if (staticFirst === null) writeLines.push(`  gea_json_first = false;`)
    } else {
      if (!field.required) writeLines.push(`  if (!gea_json_first) out += ',';`)
      writeLines.push(`  out += ${foldedKey};`)
      writeLines.push(`  gea_json_write(out, ${member});`)
      if (staticFirst === null) writeLines.push(`  gea_json_first = false;`)
    }
    if (!field.required) writeLines.push(`  }`)
    readLines.push(`${inner}${firstKey ? 'if' : 'else if'} (gea_json_key == ${keyComparisonLiteral}) gea_json_which = ${index};`)
    firstKey = false
  }
  writeAccessorsAt(entry.fields.length)
  if (fastKeys) readLines.push(`    }`)
  readLines.push(`    switch (gea_json_which) {`)
  // A document may list the fields in any order, and its order is the
  // parsed object's creation order. A field arriving after a later-declared
  // one was already read is out of layout order, and only then does the
  // record get a creation-order log (`noteNativeIndexKeyCreated`); a
  // document in layout order pays a flag test per key. A repeated key keeps
  // its first place, as 10.1.9 [[Set]] on an existing property does.
  const ordered = entry.fields.length > 1
  if (ordered) {
    const opening = readLines.indexOf(`  for (;;) {`)
    readLines.splice(opening, 0, `  bool gea_json_seen[${entry.fields.length}] = {};`, `  int gea_json_last = -1;`)
  }
  entry.fields.forEach((field, at) => {
    readLines.push(`      case ${at}: {`)
    if (ordered)
      readLines.push(
        `        if (!gea_json_seen[${at}]) { gea_json_seen[${at}] = true; if (${at} < gea_json_last) ` +
          `gea::detail::noteNativeIndexKeyCreated(&out, gea::PropertyKey::string(${cppStringLiteral(field.key)})); else gea_json_last = ${at}; }`
      )
    readLines.push(...readBodyOf(field, '        '))
    readLines.push(`        break;`)
    readLines.push(`      }`)
  })
  readLines.push(`      default:`)
  readLines.push(`        reader.skipValue();`)
  readLines.push(`        break;`)
  readLines.push(`    }`)
  readLines.push(`    if (!reader.advance()) break;`)
  readLines.push(`  }`)
  readLines.push(`}`)
  // The keys a record gains past its declared fields live in its expando
  // sidecar, and JSON reads them too -- see `writeNativeExpandoMembers`.
  const nothingWritten = staticFirst === null ? 'gea_json_first' : staticFirst ? 'true' : 'false'
  writeLines.push(`  gea::json::writeNativeExpandoMembers(out, &value, ${nothingWritten});`)
  writeLines.push(`  out += '}';`)
  writeLines.push(`}`)
  return `${renderJsonMemberWriter(entry.structName, entry.fields)}\n\n${writeLines.join('\n')}\n\n${readLines.join('\n')}`
}

/** One `JSON.stringify`/`JSON.parse` call this program's IR reaches, and the representation that names what it stringifies (the argument) or decodes into (the asserted result). */
interface JsonCallSite {
  readonly member: 'stringify' | 'parse'
  readonly representation: Representation
}

/**
 * Every `JSON.stringify`/`JSON.parse` call site in `bodies`, found by walking
 * IR directly rather than reading `EmitContext.hostMemberReads` -- that map is
 * only populated incrementally as `emit-properties.ts` renders each body's own
 * property reads, which happens *after* `translation-unit.ts` must already
 * have every struct declaration in hand (see this file's own callers there).
 *
 * A `'get'` operation is a JSON-member reference when its RECEIVER's own
 * representation is the `JSON` native handle and its key is the constant text
 * `"stringify"`/`"parse"` -- the identical two facts
 * `emit-properties.ts`'s `nativeHandleMemberText` keys its own dispatch on,
 * just read here directly off the IR instead of through that file's
 * emission-time bookkeeping. A `'call'` operation is then a JSON call when its
 * callee traces back to one such `'get'`.
 */
/**
 * What `JSON.stringify` writes for a class instance whose prototype chain
 * answers `toJSON` with one statically known body: SerializeJSONProperty
 * (ECMA-262 25.5.2.2 step 2) replaces the value with `toJSON(key)` before
 * anything else looks at it, so the text is exactly the writer of that
 * body's result. `classDirectMethodFor` declines an overridden key, so the
 * body called is the one every instance of the carrier dispatches to. A
 * `toJSON` that declares a parameter would receive the key -- `""` at the
 * top level, not the `undefined` a direct no-argument call binds -- and is
 * left to refuse.
 */
const classToJsonOf = (
  layouts: RecordLayoutPolicy | undefined,
  representation: Representation
): { readonly callable: FunctionId; readonly result: Representation } | null => {
  if (representation.kind !== 'class-ref') return null
  const direct = layouts?.classDirectMethodFor?.(representation.declaration, 'toJSON') ?? null
  if (direct === null || direct.absentParameters.length !== 0) return null
  return { callable: direct.callable, result: direct.result }
}

const jsonRootsOf = (bodies: readonly IrBody[], layouts: RecordLayoutPolicy | undefined): readonly JsonCallSite[] => {
  const sites: JsonCallSite[] = []
  for (const body of bodies) {
    const constantTextOf = new Map<IrValueId, string>()
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'constant') constantTextOf.set(operation.result.id, operation.text)
      }
    }
    const jsonMemberOf = new Map<IrValueId, 'stringify' | 'parse'>()
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'get') continue
        const receiverRepresentation = operation.receiver.representation
        if (receiverRepresentation.kind !== 'native-handle' || receiverRepresentation.protocol !== 'JSON') continue
        const keyText = constantTextOf.get(operation.key.value)
        if (keyText === 'stringify' || keyText === 'parse') jsonMemberOf.set(operation.result.id, keyText)
      }
    }
    if (jsonMemberOf.size === 0) continue
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'call') continue
        const member = jsonMemberOf.get(operation.callee.value)
        if (member === undefined) continue
        if (member === 'stringify') {
          const argument: IrOperand | undefined = operation.arguments[0]
          if (argument) {
            sites.push({ member, representation: classToJsonOf(layouts, argument.representation)?.result ?? argument.representation })
          }
        } else if (operation.result) {
          sites.push({ member, representation: operation.result.representation })
        }
      }
    }
  }
  return sites
}

/**
 * Every `gea_json_write`/`gea_json_read` record overload this program's own
 * JSON call sites require, rendered once each in deterministic (struct-name)
 * order.
 *
 * Deliberately reports no refusals of its own: a call site whose shape this
 * file cannot serialize/decode natively refuses at the SAME check,
 * independently, when `jsonCallText` (below) renders that call for real
 * during body emission -- duplicating that refusal here would either have to
 * agree with it forever by construction (in which case it is dead code) or
 * risk silently disagreeing with it (in which case one of the two is wrong).
 * A struct this function fails to collect for an unsupported call site simply
 * never gets declared; that call's own emission refuses by name, and the
 * translation unit it belongs to is discarded whole, same as any other
 * refused body (`translation-unit.ts`'s `CppTranslationUnitResult.source`).
 */
export const renderJsonStructDeclarations = (
  bodies: readonly IrBody[],
  deriver: RepresentationDeriver,
  layouts: RecordLayoutPolicy | undefined,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactive: { readonly cell: string | null; readonly fields: ReadonlyMap<DeclarationId, ReadonlySet<string>> }
): {
  readonly declarations: readonly string[]
  /**
   * The structs a JSON overload reads or writes.
   *
   * Reported because `gea_json_read(reader, out.x)` binds a REFERENCE to the
   * member and decodes into it, so this file is a second authority over that
   * member's C++ type -- and `ir/integer-storage.ts`, which would otherwise
   * narrow it to a `long long`, has to be told which structs it may not touch.
   */
  readonly structNames: ReadonlySet<string>
} => {
  const collected = emptyJsonCollected()
  const world: JsonWorld = { deriver, classes, reactiveFields: reactive.cell === null ? null : reactive.fields }
  for (const site of jsonRootsOf(bodies, layouts)) {
    jsonUnsupportedReason(world, site.representation, collected, new Set(), site.member === 'stringify' ? 'write' : 'read')
  }
  const names = [...collected.structs.keys()].sort()
  const classNames = [...collected.classes.keys()].sort()
  const unionNames = [...collected.nullableUnions.keys()].sort()
  // A class writer names every member up its chain through the derived
  // struct, so each struct of the chain is one whose member types it reads.
  const classChainStructs = new Set<string>()
  for (const layout of classes.values()) {
    if (!collected.classes.has(cppClassName(layout.declaration))) continue
    const seen = new Set<DeclarationId>()
    for (let current: ClassLayout | undefined = layout; current !== undefined && !seen.has(current.declaration);) {
      seen.add(current.declaration)
      classChainStructs.add(cppClassName(current.declaration))
      current = current.base === null ? undefined : classes.get(current.base)
    }
  }
  // Every pair is declared before any pair is defined. Required as soon as a
  // record's field reaches the record itself: the write body calls
  // `gea_json_write` on its own struct -- through `std::vector`'s template for
  // a `Node[]` field, whose dependent call resolves at instantiation -- and a
  // definition that has not been declared yet is a clang error rather than a
  // refusal. Unconditional rather than only-when-recursive because the cost is
  // two lines per struct and the alternative is a second rule deciding when
  // they are needed.
  const forwards = [...names, ...unionNames].flatMap((name) => [
    `inline void gea_json_write(std::string& out, const ${name}& value);`,
    `inline void gea_json_read(gea::json::Reader& reader, ${name}& out);`
  ])
  const classForwards = classNames.map((name) => `inline void gea_json_write(std::string& out, const ${name}& value);`)
  const declarations = [
    ...forwards,
    ...classForwards,
    ...names.map((name) => renderJsonRecordOverloads(collected.structs.get(name) as JsonStructEntry)),
    ...classNames.map((name) => renderJsonClassOverload(collected.classes.get(name) as JsonClassEntry)),
    ...unionNames.map((name) => renderJsonNullableUnionOverloads(collected.nullableUnions.get(name) as JsonNullableUnionEntry))
  ]
  return { declarations, structNames: new Set([...names, ...classChainStructs]) }
}

/**
 * One `JSON.stringify`/`JSON.parse` call, rendered as a single C++ expression
 * -- `emit-host-invoke.ts`'s `hostCallText` consumes this the same way it
 * consumes every other host call's text, spliced directly into
 * `${defineValue(ctx, operation.result)} = ${hostCall};` (`emit-callable.ts`).
 * A lambda-IIFE is what makes a multi-statement C++ sequence (allocate a
 * reader, decode into a local, return it) into one expression a plain
 * assignment can consume; there is no other rendering site in this backend
 * that needs the same trick, because every other host call already has a
 * single C++ expression to name.
 */
/**
 * Whether a box of `representation` holds nothing the dynamic JSON writer
 * cannot walk. The boxed route exists for a UNION of host objects and
 * classes (hono's `BodyInit | null`, re-stringified from its body cache):
 * what the value is at runtime is one of many arms, so serializing it is a
 * dispatch over the box either way, and a class arm is admitted when the
 * reflection census made the class boxable (`classBoxable`: its dynamic
 * protocol is emitted, so the walk has fields to read).
 *
 * A carrier that IS a class -- bare, or `Class | undefined` -- is different:
 * the layout is statically known and owned by this compiler, so its JSON is
 * a native writer over that layout (not written yet), never a walk of its
 * box, and the honest answer until then is the refusal the argument got
 * before the boxed route existed (`test/runtime/class-json-reflection-
 * refused.ts`). The walk is also WRONG for it today: with the protocol
 * emitted it printed `{"first":0,"second":""}` for `first = 1; second =
 * 'two'`, which is why the union case above is the whole of what this admits.
 */
const boxHoldsOnlyBoxable = (ctx: EmitContext, representation: Representation, seen: Set<string>, whole: boolean): boolean => {
  const key = representationKey(representation)
  if (seen.has(key)) return true
  seen.add(key)
  switch (representation.kind) {
    case 'class-ref':
      return !whole && classBoxable(ctx.classes, representation.declaration)
    case 'optional':
      return boxHoldsOnlyBoxable(ctx, representation.payload, seen, whole)
    case 'tagged-union':
      return representation.arms.every((arm) => boxHoldsOnlyBoxable(ctx, arm.value, seen, false))
    case 'array-object':
      return boxHoldsOnlyBoxable(ctx, representation.element, seen, false)
    case 'dictionary':
    case 'promise':
      return boxHoldsOnlyBoxable(ctx, representation.value, seen, false)
    // A record held BY VALUE inside what the box holds has no `DynamicCarrier`
    // rule: an array, union or field holding one boxes with no table to read
    // it through, and the walk aborts on its first read (`{ k: [1, { z: true }] }`).
    // The argument itself is `dynamicCarrierBoxText`'s to judge.
    case 'record':
      return (
        (whole || representation.ownership === 'shared-refcount') &&
        representation.fields.every((field) => boxHoldsOnlyBoxable(ctx, field.value, seen, false))
      )
    case 'record-with-index':
    case 'native-record-ref':
      return whole || representation.ownership === 'shared-refcount'
    default:
      return true
  }
}

/**
 * A value with no native serializer -- a union of host objects hono stringifies
 * as `BodyInit` -- serialized from its box, which the dynamic writer walks as
 * JSON.stringify walks any object.
 */
const boxedJsonArgumentText = (ctx: EmitContext, argument: IrOperand): string | null => {
  if (!boxHoldsOnlyBoxable(ctx, argument.representation, new Set(), true)) return null
  const boxed = dynamicCarrierBoxText(argument.representation, operandText(ctx, argument))
  if (boxed === null) return null
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  return jsonUnsupportedReason(jsonWorldOf(ctx), dynamic, emptyJsonCollected(), new Set(), 'write') === null ? boxed : null
}

/**
 * The call-frame proof (`hostTemplateFrameOf`'s `json-stringify` arm) told
 * reflection demand this argument never crosses a dynamic boundary, so its
 * records were emitted with only the field reads the program names. Boxing it
 * would serialize through those pruned hooks and silently drop keys
 * (`{"b":[]}` for `{ a: 1, b: [] }`): the proof and this writer disagreeing is
 * a defect to refuse, never one to paper over with a box.
 */
const refuseBoxingProvenDataTree = (ctx: EmitContext, operation: CallOperation, reason: string): void => {
  if (hostTemplateFrameOf(operation, undefined, ctx.deriver, ctx.classes) !== true) return
  throw createCppEmitBlockedError(
    'host-member-call:JSON.stringify',
    `JSON.stringify's argument was proven a native data tree but has no native writer: ${reason}`
  )
}

/**
 * `JSON.stringify` whose result the program holds as `string | undefined`
 * (`structural.ts`'s `json-stringify-may-be-undefined`): a top-level value
 * with no JSON form -- `undefined`, a function, a symbol -- produces
 * `undefined` rather than any text (ECMA-262 25.5.2.1), where the writer on
 * its own would print `null`, the answer only an array element or a nested
 * position gets. `null` for a call this does not cover.
 */
const absentWhenUnserializableText = (ctx: EmitContext, operation: CallOperation): string | null => {
  const result = operation.result?.representation
  if (result?.kind !== 'optional' || result.absence !== 'undefined' || result.payload.kind !== 'string') return null
  if (operation.arguments.length !== 1) return null
  const argument = operation.arguments[0] as IrOperand
  const resultType = cppTypeOf(result)
  const writeText = (value: string): string =>
    `std::string gea_json_out; gea_json_write(gea_json_out, ${value}); return ${resultType}(std::move(gea_json_out));`
  const representation = argument.representation
  const unsupported =
    representation.kind === 'dynamic'
      ? null
      : jsonUnsupportedReason(jsonWorldOf(ctx), representation, emptyJsonCollected(), new Set(), 'write')
  if (unsupported !== null) refuseBoxingProvenDataTree(ctx, operation, unsupported)
  const dynamicText =
    representation.kind === 'dynamic' ? operandText(ctx, argument) : unsupported !== null ? boxedJsonArgumentText(ctx, argument) : null
  if (dynamicText !== null) {
    return (
      `[&]() -> ${resultType} { const gea::Value& gea_json_value = ${dynamicText}; const auto gea_json_tag = gea_json_value.tag(); ` +
      `if (gea_json_tag == gea::Value::Tag::Undefined || gea_json_tag == gea::Value::Tag::Function || gea_json_tag == gea::Value::Tag::Symbol) ` +
      `return ${resultType}(); ${writeText('gea_json_value')} }()`
    )
  }
  if (representation.kind === 'optional' && representation.absence === 'undefined') {
    return `[&]() -> ${resultType} { const auto& gea_json_value = ${operandText(ctx, argument)}; if (!gea_json_value.has_value()) return ${resultType}(); ${writeText('*gea_json_value')} }()`
  }
  if (representation.kind === 'undefined') return `${resultType}()`
  return null
}

export const jsonCallText = (ctx: EmitContext, member: 'stringify' | 'parse', operation: CallOperation): string => {
  if (member === 'stringify') {
    const absentWhenUnserializable = absentWhenUnserializableText(ctx, operation)
    if (absentWhenUnserializable !== null) return absentWhenUnserializable
    if (operation.arguments.length < 1 || operation.arguments.length > 3) {
      throw createCppEmitBlockedError(
        'host-member-call:JSON.stringify',
        `JSON.stringify takes one to three arguments; this call passes ${operation.arguments.length}`
      )
    }
    const argument = operation.arguments[0] as IrOperand
    const toJson = operation.arguments.length === 1 ? classToJsonOf(ctx.layouts, argument.representation) : null
    if (toJson !== null) {
      const reason = jsonUnsupportedReason(jsonWorldOf(ctx), toJson.result, emptyJsonCollected(), new Set(), 'write')
      if (reason !== null) {
        throw createCppEmitBlockedError(
          'host-member-call:JSON.stringify',
          `JSON.stringify of a class instance writes its toJSON() result, which cannot be serialized natively: ${reason}`
        )
      }
      const replaced = `${cppBodyName(toJson.callable)}(${operandText(ctx, argument)})`
      return `[&]() { std::string gea_json_out; gea_json_write(gea_json_out, ${replaced}); return gea_json_out; }()`
    }
    const reason = jsonUnsupportedReason(jsonWorldOf(ctx), argument.representation, emptyJsonCollected(), new Set(), 'write')
    if (reason !== null) {
      refuseBoxingProvenDataTree(ctx, operation, reason)
      const boxed = operation.arguments.length === 1 ? boxedJsonArgumentText(ctx, argument) : null
      if (boxed !== null) return `[&]() { std::string gea_json_out; gea_json_write(gea_json_out, ${boxed}); return gea_json_out; }()`
      throw createCppEmitBlockedError(
        'host-member-call:JSON.stringify',
        `JSON.stringify cannot serialize this argument natively: ${reason}`
      )
    }
    const valueText = operandText(ctx, argument)
    if (operation.arguments.length > 1) {
      if (argument.representation.kind !== 'string' && argument.representation.kind !== 'dynamic') {
        throw createCppEmitBlockedError(
          'host-member-call:JSON.stringify',
          `JSON.stringify replacer support requires a string or genuinely dynamic input and this call carries "${representationKey(argument.representation)}"`
        )
      }
      const replacer = operation.arguments[1] as IrOperand
      const leaves: Array<{ readonly condition: string; readonly text: string; readonly representation: Representation }> = []
      const collect = (representation: Representation, text: string, conditions: readonly string[]): void => {
        if (representation.kind === 'optional') {
          collect(representation.payload, `(*(${text}))`, [...conditions, `(${text}).has_value()`])
          return
        }
        if (representation.kind === 'tagged-union') {
          representation.arms.forEach((arm, index) => collect(arm.value, armAt(text, index), [...conditions, armIs(text, index)]))
          return
        }
        leaves.push({ condition: conditions.length === 0 ? 'true' : conditions.join(' && '), text, representation })
      }
      collect(replacer.representation, '__gea_replacer', [])
      const callable = leaves.filter((leaf) => leaf.representation.kind === 'function-value-dispatch')
      const invalid = leaves.filter(
        (leaf) =>
          leaf.representation.kind !== 'function-value-dispatch' &&
          leaf.representation.kind !== 'array-object' &&
          leaf.representation.kind !== 'null' &&
          leaf.representation.kind !== 'undefined'
      )
      if (callable.length > 1 || invalid.length !== 0) {
        throw createCppEmitBlockedError(
          'host-member-call:JSON.stringify',
          `JSON.stringify replacer carries "${representationKey(replacer.representation)}"; expected null, undefined, a property-list array, or one callable arm`
        )
      }
      if (callable.length === 0) {
        return `[&]() { std::string gea_json_out; gea_json_write(gea_json_out, ${valueText}); return gea_json_out; }()`
      }
      const space = operation.arguments[2]
      const gapText = (representation: Representation, text: string): string => {
        if (representation.kind === 'undefined' || representation.kind === 'null') return 'std::string()'
        if (representation.kind === 'string' || (representation.kind === 'scalar' && representation.domain === 'number')) {
          return `gea::json::indentGap(${text})`
        }
        if (representation.kind === 'optional') {
          return `((${text}).has_value() ? ${gapText(representation.payload, `(*(${text}))`)} : std::string())`
        }
        if (representation.kind === 'tagged-union') {
          const arms = representation.arms.map((arm, index) => gapText(arm.value, armAt(text, index)))
          return arms.reduceRight((rest, arm, index) => `${armIs(text, index)} ? ${arm} : (${rest})`)
        }
        throw createCppEmitBlockedError(
          'host-member-call:JSON.stringify',
          `JSON.stringify space carries unsupported "${representationKey(representation)}"`
        )
      }
      const gap = space === undefined ? 'std::string()' : gapText(space.representation, '__gea_space')
      const selected = callable[0] as (typeof callable)[number]
      const callableRepresentation = selected.representation as Extract<Representation, { readonly kind: 'function-value-dispatch' }>
      const spaceBinding = space === undefined ? '' : `const auto& __gea_space = ${operandText(ctx, space)};`
      // A statically known string is the original specialized path. A
      // genuinely dynamic value already IS the boxed boundary JSON's callback
      // contract requires, so pass it through untouched. Extending this to a
      // typed record would be the forbidden shortcut: that record must keep
      // its native carrier, and needs a generated typed replacer traversal of
      // its own before it can be admitted here.
      const root =
        argument.representation.kind === 'string' ? 'gea::Value::box(gea::Value::Tag::String, std::string(__gea_value))' : '__gea_value'
      const receiver = callableRepresentation.abi.receiver
      if (receiver !== null && receiver.kind !== 'dynamic') {
        throw createCppEmitBlockedError(
          'host-member-call:JSON.stringify',
          `JSON.stringify replacer receiver carries "${representationKey(receiver)}"; only the declared dynamic this-value is supported`
        )
      }
      const invoke =
        receiver === null ? '__gea_callable.call(__gea_key, __gea_member)' : '__gea_callable.call(__gea_holder, __gea_key, __gea_member)'
      return (
        `([&]() { const auto& __gea_value = ${valueText}; const auto& __gea_replacer = ${operandText(ctx, replacer)}; ${spaceBinding} ` +
        `const std::string __gea_gap = ${gap}; if (${selected.condition}) { const auto& __gea_callable = ${selected.text}; ` +
        `return gea::json::stringifyWithReplacer(${root}, ` +
        `[&](const gea::Value& __gea_holder, const std::string& __gea_key, const gea::Value& __gea_member) { ` +
        `return ${invoke}; }, __gea_gap); } ` +
        `std::string gea_json_out; gea_json_write(gea_json_out, __gea_value); return gea_json_out; })()`
      )
    }
    return `[&]() { std::string gea_json_out; gea_json_write(gea_json_out, ${valueText}); return gea_json_out; }()`
  }
  if (operation.arguments.length === 2) return jsonParseWithReviverText(ctx, operation)
  if (operation.arguments.length !== 1) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse takes one or two arguments; this call passes ${operation.arguments.length}`
    )
  }
  if (operation.result === null) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      'this JSON.parse result is discarded; this backend only renders a parse whose value is used somewhere'
    )
  }
  const resultRepresentation = operation.result.representation
  const reason = jsonUnsupportedReason(jsonWorldOf(ctx), resultRepresentation, emptyJsonCollected(), new Set(), 'read')
  if (reason !== null)
    throw createCppEmitBlockedError('host-member-call:JSON.parse', `JSON.parse cannot decode natively into this asserted type: ${reason}`)
  const textOperand = operation.arguments[0] as IrOperand
  const textArgument = operandText(ctx, textOperand)
  const resultType = cppTypeOf(resultRepresentation)
  // `JSON.stringify(x)` is typed `string` and answers `undefined` for a value
  // JSON cannot represent, so its carrier here is `optional(string)`. Feeding
  // that to `JSON.parse` is ToString(undefined) = "undefined", which is not
  // JSON: the parse throws its SyntaxError, as it does for any other
  // malformed text.
  if (textOperand.representation.kind === 'optional' && textOperand.representation.payload.kind === 'string') {
    const text = 'gea_json_arg.has_value() ? std::string(*gea_json_arg) : std::string("undefined")'
    return (
      `[&]() { const auto& gea_json_arg = ${textArgument}; const std::string gea_json_text = ${text}; ` +
      `gea::json::Reader gea_json_reader(gea_json_text); ${resultType} gea_json_result{}; ` +
      `gea_json_read(gea_json_reader, gea_json_result); gea_json_reader.finish(); return gea_json_result; }()`
    )
  }
  return `[&]() { const std::string& gea_json_text = ${textArgument}; gea::json::Reader gea_json_reader(gea_json_text); ${resultType} gea_json_result{}; gea_json_read(gea_json_reader, gea_json_result); gea_json_reader.finish(); return gea_json_result; }()`
}

/**
 * `JSON.parse(text, reviver)`, ECMA-262 25.5.1 with InternalizeJSONProperty
 * (`gea::json::parseWithReviver`).
 *
 * The reviver sees and answers every value of the parsed tree, so the tree it
 * walks is the parse's own dynamic one and the call's result is that dynamic
 * value: admitted only where the program reads the result as the genuinely
 * dynamic carrier (`any`). A typed decode (`JSON.parse(t, r) as T`) would need
 * the revived tree converted to `T`, which this does not do -- refused by name.
 *
 * The reviver must be ONE callable arm (a nullish arm parses without reviving,
 * as the language does for a non-callable reviver) whose convention takes the
 * key as a string and the value, and answers, as the dynamic carrier: the
 * declared `(this: any, key: string, value: any) => any`. A reviver whose
 * parameters or result the program narrowed to a static type would need a
 * checked conversion at each call; that is not rendered here.
 */
const jsonParseWithReviverText = (ctx: EmitContext, operation: CallOperation): string => {
  if (operation.result === null) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      'this JSON.parse result is discarded; this backend only renders a parse whose value is used somewhere'
    )
  }
  if (operation.result.representation.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse with a reviver answers the revived dynamic tree, and this call's result carries "${representationKey(operation.result.representation)}"`
    )
  }
  const text = operation.arguments[0] as IrOperand
  const reviver = operation.arguments[1] as IrOperand
  if (text.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse's text carries "${representationKey(text.representation)}"; only a string is rendered with a reviver`
    )
  }
  const leaves: Array<{ readonly condition: string; readonly text: string; readonly representation: Representation }> = []
  const collect = (representation: Representation, at: string, conditions: readonly string[]): void => {
    if (representation.kind === 'optional') {
      collect(representation.payload, `(*(${at}))`, [...conditions, `(${at}).has_value()`])
      return
    }
    if (representation.kind === 'tagged-union') {
      representation.arms.forEach((arm, index) => collect(arm.value, armAt(at, index), [...conditions, armIs(at, index)]))
      return
    }
    leaves.push({ condition: conditions.length === 0 ? 'true' : conditions.join(' && '), text: at, representation })
  }
  collect(reviver.representation, '__gea_reviver', [])
  const callable = leaves.filter((leaf) => leaf.representation.kind === 'function-value-dispatch')
  const invalid = leaves.filter(
    (leaf) =>
      leaf.representation.kind !== 'function-value-dispatch' &&
      leaf.representation.kind !== 'null' &&
      leaf.representation.kind !== 'undefined'
  )
  if (callable.length !== 1 || invalid.length !== 0) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse reviver carries "${representationKey(reviver.representation)}"; expected one callable arm, optionally beside null or undefined`
    )
  }
  const selected = callable[0] as (typeof callable)[number]
  const abi = (selected.representation as Extract<Representation, { readonly kind: 'function-value-dispatch' }>).abi
  const parameterKinds = abi.parameters.map((parameter) => parameter.value.kind)
  // The answer lands in the dynamic tree: lib declares it `any`, so a reviver
  // whose body the checker typed narrower (`(k, v) => \`${k}:${v}\``) widens
  // into the dynamic carrier exactly as any store of that type into `any` does.
  const invoked = (text: string): string | null => (abi.result.kind === 'dynamic' ? text : dynamicCarrierBoxText(abi.result, text))
  const conventional =
    abi.restFrom === null &&
    invoked('__gea_answer') !== null &&
    (abi.receiver === null || abi.receiver.kind === 'dynamic') &&
    parameterKinds.length <= 2 &&
    (parameterKinds[0] === undefined || parameterKinds[0] === 'string') &&
    (parameterKinds[1] === undefined || parameterKinds[1] === 'dynamic')
  if (!conventional) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse reviver's convention "${representationKey(selected.representation)}" is not (this: any, key: string, value: any) => any`
    )
  }
  const argumentsText = ['__gea_key', '__gea_member'].slice(0, parameterKinds.length)
  const invoke = `__gea_callable.call(${[...(abi.receiver === null ? [] : ['__gea_holder']), ...argumentsText].join(', ')})`
  const answer =
    abi.result.kind === 'dynamic' ? `return ${invoke};` : `const auto __gea_answer = ${invoke}; return ${invoked('__gea_answer')};`
  const plain = `[&]() { gea::json::Reader gea_json_reader(__gea_text); gea::Value gea_json_result = gea_json_reader.readDynamicValue(); gea_json_reader.finish(); return gea_json_result; }()`
  return (
    `([&]() -> gea::Value { const std::string& __gea_text = ${operandText(ctx, text)}; const auto& __gea_reviver = ${operandText(ctx, reviver)}; ` +
    `if (${selected.condition}) { const auto& __gea_callable = ${selected.text}; ` +
    `return gea::json::parseWithReviver(__gea_text, ` +
    `[&](const gea::Value& __gea_holder, const std::string& __gea_key, const gea::Value& __gea_member) -> gea::Value { ` +
    `(void)__gea_holder; (void)__gea_key; (void)__gea_member; ${answer} }); } ` +
    `return ${plain}; })()`
  )
}

/**
 * `JSON.stringify(v)` written straight into the cell that receives it, as
 * whole statements, instead of into a temporary the following write copies out
 * of. `null` whenever any condition that would make the two observably
 * different fails, in which case the ordinary expression form renders.
 *
 * The conditions are each a way the cell and the temporary are not the same
 * storage:
 *  - the cell must HOLD a plain `std::string`. A union, an optional, a
 *    `Signal`, a shared box, an integer-narrowed cell: none of those is a
 *    buffer `gea_json_write` can append into, and a reactive cell additionally
 *    owes a notify the direct write would skip.
 *  - the cell must be this frame's own local or a file-scope cell it may name.
 *  - the write must not be one that renders nothing on its own
 *    (`formalCells`), which would leave the fill duplicating a value the
 *    formal already holds under another name.
 *  - the argument must not READ the cell, DIRECTLY OR THROUGH ANYTHING IT IS
 *    DERIVED FROM. `s = JSON.stringify(s)` reads the very buffer the `clear()`
 *    empties and would serialize `""`; so does `s = JSON.stringify({ s })`,
 *    whose argument is a record one of whose fields was loaded from that same
 *    buffer. Asked of the IR -- `ctx.valueCellReads`, the transitive closure of
 *    what each value's operands read -- rather than of the argument's rendered
 *    C++ text.
 *
 *    Both halves of that matter, and they fail in opposite directions. A text
 *    scan misses a read of the same declaration reached through a
 *    differently-spelled reference (a reactive accessor, an environment
 *    indirection), because the cell's own name is not in the rendered text.
 *    Asking `bindingReadDeclarations` -- whether the argument IS that read --
 *    fixes that but narrows the question to one value, and a derived argument
 *    walks straight past it. The closure is the only form of the question that
 *    holds in both directions.
 *
 * One difference is real and deliberate: if the serializer throws part-way --
 * which it can only do by failing to allocate -- the cell holds a partial
 * document where the temporary form would have left the previous value. The
 * hand-written baselines this is measured against (`text.clear(); ser(text,
 * tree);`) have the same property, and a program that catches `bad_alloc` and
 * then reads the half-written buffer is not a shape this compiler serves.
 */
export const jsonStringifyFillLines = (ctx: EmitContext, operation: CallOperation): readonly string[] | null => {
  if (operation.result === null || operation.arguments.length !== 1) return null
  const read = ctx.hostMemberReads.get(operation.callee.value)
  if (!read || read.protocol !== 'JSON' || read.member !== 'stringify') return null
  const declaration = ctx.directBindingSinks.get(operation.result.id)
  if (declaration === undefined) return null
  if (ctx.formalCells.has(declaration) || ctx.integerBindings.has(declaration) || ctx.captures.isBoxed(declaration)) return null
  const placement = ctx.placements.get(declaration)
  if (!placement || placement.representation?.kind !== 'string') return null
  // A cell, and one this frame may assign. `local` owned elsewhere is another
  // frame's storage reached through a capture; every other storage kind --
  // a host singleton, a class object, an `extern` -- is not a buffer at all.
  if (placement.storage.kind === 'local' && placement.storage.owner !== ctx.owner) return null
  if (placement.storage.kind !== 'local' && placement.storage.kind !== 'region') return null
  const argument = operation.arguments[0] as IrOperand
  const reason = jsonUnsupportedReason(jsonWorldOf(ctx), argument.representation, emptyJsonCollected(), new Set(), 'write')
  if (reason !== null) {
    // The expression form serializes the boxed value instead (`jsonCallText`).
    if (boxedJsonArgumentText(ctx, argument) !== null) return null
    throw createCppEmitBlockedError('host-member-call:JSON.stringify', `JSON.stringify cannot serialize this argument natively: ${reason}`)
  }
  const cell = bindingReference(ctx, declaration, 'a JSON.stringify written in place')
  if (cell.boxed || cell.frame === true) return null
  const target = cellValueText(cell)
  if (readsCell(ctx, argument.value, declaration)) return null
  const valueText = operandText(ctx, argument)
  const lines: string[] = []
  // The cell's own declaration, if this write is the one that would have made
  // it: hoisted to the top of the frame exactly as `emit-bindings.ts` hoists
  // it, so the fill has somewhere to append into and the write it replaces
  // does not declare a second one.
  if (cell.owned && !ctx.declaredBindings.has(declaration)) {
    declareCell(ctx, cell.name, cppTypeOf(placement.representation))
    ctx.declaredBindings.add(declaration)
  }
  lines.push(`${target}.clear();`)
  lines.push(`gea_json_write(${target}, ${valueText});`)
  // The result IS the cell now, so the write that follows recognizes its own
  // storage on both sides and renders nothing (`emit-bindings.ts`).
  defineValueAlias(ctx, operation.result, target)
  return lines
}
