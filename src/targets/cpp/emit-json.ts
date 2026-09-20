import type { IrBody, IrOperand, CallOperation } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import { representationKey, type Representation } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
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
import { recordFieldsOfShape } from './records.js'
import { cppRecordFieldName, cppRecordFieldPresenceName, cppRecordStructName, cppStringLiteral, cppTypeOf } from './types.js'
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
 * Only records, arrays of a supported element, and the `number`/`boolean`
 * scalar domains are implemented -- see `jsonUnsupportedReason` below for the
 * exact, exhaustive list of what refuses and why. A `dynamic` value anywhere
 * in the shape (an unasserted `JSON.parse`, or a statically-`any` field), a
 * class instance, a callable, or a dictionary/index-signature record are all
 * refused by name here, at the call site, rather than reaching a boxed
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

/** The arm layout above, read off a `tagged-union` -- or `null` when it is a real sum this file has no JSON discriminator for. */
interface NullableUnionArms {
  readonly nullIndex: number
  readonly presentIndex: number
  /** `-1` when the union carries no `undefined` arm. Only a record FIELD reads this: an `undefined` property is omitted from the object entirely (ECMA-262 25.5.2.2), which no standalone overload has a spelling for. */
  readonly undefinedIndex: number
  readonly payload: Representation
}

/**
 * Whether `representation` is one JSON-carrying arm plus absence arms.
 *
 * Anything wider is a genuine sum with no JSON discriminator -- a document
 * says `3`, not which arm of `number | Point` produced it -- so it answers
 * `null` and the caller refuses by name. Shared by the collector and by the
 * record renderer so both read exactly one rule.
 */
const nullableUnionArmsOf = (representation: Representation): NullableUnionArms | null => {
  if (representation.kind !== 'tagged-union') return null
  const nullIndex = representation.arms.findIndex((arm) => arm.value.kind === 'null')
  const undefinedIndex = representation.arms.findIndex((arm) => arm.value.kind === 'undefined')
  const presentIndex = representation.arms.findIndex((arm) => arm.value.kind !== 'null' && arm.value.kind !== 'undefined')
  const absenceCount = (nullIndex === -1 ? 0 : 1) + (undefinedIndex === -1 ? 0 : 1)
  const payload = representation.arms[presentIndex]?.value
  if (nullIndex === -1 || presentIndex === -1 || payload === undefined) return null
  if (representation.arms.length !== absenceCount + 1) return null
  return { nullIndex, presentIndex, undefinedIndex, payload }
}

/** Every overload this program's JSON call sites require: record layouts, and the nullable-union pairs. */
interface JsonCollected {
  readonly structs: Map<string, JsonStructEntry>
  readonly nullableUnions: Map<string, JsonNullableUnionEntry>
}

/** A fresh, empty collector for one walk. */
const emptyJsonCollected = (): JsonCollected => ({ structs: new Map(), nullableUnions: new Map() })

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
  deriver: RepresentationDeriver,
  representation: Representation,
  collected: JsonCollected,
  visiting: ReadonlySet<string>,
  direction: 'write' | 'read'
): string | null => {
  switch (representation.kind) {
    case 'dynamic':
      return null
    case 'dictionary':
      return direction === 'write' && representation.key === 'string' && representation.value.kind === 'dynamic'
        ? null
        : `representation "${representationKey(representation)}" has no native JSON.stringify/parse mapping`
    case 'string':
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
      return jsonUnsupportedReason(deriver, representation.element, collected, visiting, direction)
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
        if (visiting.size > 0) {
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
        const reason = jsonUnsupportedReason(deriver, fieldRepresentation, collected, stillVisiting, direction)
        if (reason) return `field "${field.key}" of record "${structName}": ${reason}`
      }
      // Recorded only after every field resolved: a record that turns out to
      // be unsupported must not leave a partial entry another call site's
      // `collected.structs.has(structName)` short-circuit could mistake for done.
      collected.structs.set(structName, { structName, fields })
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
      const reason = jsonUnsupportedReason(deriver, arms.payload, collected, visiting, direction)
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
    default:
      // `dynamic`, `class-ref`, `record-with-index`, `dictionary`, `function`,
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
const renderJsonRecordOverloads = (entry: JsonStructEntry): string => {
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
  const anyOmittable = entry.fields.some(omittable)
  let staticFirst: boolean | null = true
  const writeLines = [`inline void gea_json_write(std::string& out, const ${entry.structName}& value) {`, `  out += '{';`]
  if (anyOmittable) writeLines.push(`  bool gea_json_first = true;`)
  // The body that reads ONE field's value, rendered once and used by both key
  // chains below.
  const readBodyOf = (field: JsonStructEntry['fields'][number], indent: string): string[] => {
    const target = cppRecordFieldName(field.key)
    const optional = field.value.kind === 'optional' && (field.value.absence === 'undefined' || field.value.absence === 'null')
    if (!optional) {
      return [
        `${indent}gea_json_read(reader, out.${target});`,
        ...(!field.required ? [`${indent}out.${cppRecordFieldPresenceName(field.key)} = true;`] : [])
      ]
    }
    const payloadType = cppTypeOf(field.value.kind === 'optional' ? field.value.payload : field.value)
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
  for (const [index, field] of entry.fields.entries()) {
    const member = cppRecordFieldName(field.key)
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
      writeLines.push(`  if (!value.${member}.is<${undefinedArmIndex}>()) {`)
      writeLines.push(`    if (!gea_json_first) out += ',';`)
      writeLines.push(`    out += ${keyLiteral};`)
      writeLines.push(`    gea_json_write(out, value.${member});`)
      writeLines.push(`    gea_json_first = false;`)
      writeLines.push(`  }`)
    } else if (isOptionalUndefined) {
      writeLines.push(`  if (value.${member}.has_value()) {`)
      writeLines.push(`    if (!gea_json_first) out += ',';`)
      writeLines.push(`    out += ${keyLiteral};`)
      writeLines.push(`    gea_json_write(out, *value.${member});`)
      writeLines.push(`    gea_json_first = false;`)
      writeLines.push(`  }`)
    } else if (field.value.kind === 'optional' && field.value.absence === 'null') {
      // ECMA-262 does not omit a `T | null` property the way it omits
      // `undefined` -- it always writes the key, with `null` when absent.
      if (!field.required) writeLines.push(`  if (!gea_json_first) out += ',';`)
      writeLines.push(`  out += ${foldedKey};`)
      writeLines.push(`  if (value.${member}.has_value()) gea_json_write(out, *value.${member}); else out += "null";`)
      if (staticFirst === null) writeLines.push(`  gea_json_first = false;`)
    } else {
      if (!field.required) writeLines.push(`  if (!gea_json_first) out += ',';`)
      writeLines.push(`  out += ${foldedKey};`)
      writeLines.push(`  gea_json_write(out, value.${member});`)
      if (staticFirst === null) writeLines.push(`  gea_json_first = false;`)
    }
    if (!field.required) writeLines.push(`  }`)
    readLines.push(`${inner}${firstKey ? 'if' : 'else if'} (gea_json_key == ${keyComparisonLiteral}) gea_json_which = ${index};`)
    firstKey = false
  }
  if (fastKeys) readLines.push(`    }`)
  readLines.push(`    switch (gea_json_which) {`)
  entry.fields.forEach((field, at) => {
    readLines.push(`      case ${at}: {`)
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
  writeLines.push(`  out += '}';`)
  writeLines.push(`}`)
  return `${writeLines.join('\n')}\n\n${readLines.join('\n')}`
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
const jsonRootsOf = (bodies: readonly IrBody[]): readonly JsonCallSite[] => {
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
          if (argument) sites.push({ member, representation: argument.representation })
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
  deriver: RepresentationDeriver
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
  for (const site of jsonRootsOf(bodies)) {
    jsonUnsupportedReason(deriver, site.representation, collected, new Set(), site.member === 'stringify' ? 'write' : 'read')
  }
  const names = [...collected.structs.keys()].sort()
  const unionNames = [...collected.nullableUnions.keys()].sort()
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
  const declarations = [
    ...forwards,
    ...names.map((name) => renderJsonRecordOverloads(collected.structs.get(name) as JsonStructEntry)),
    ...unionNames.map((name) => renderJsonNullableUnionOverloads(collected.nullableUnions.get(name) as JsonNullableUnionEntry))
  ]
  return { declarations, structNames: new Set(names) }
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
    case 'record':
      return representation.fields.every((field) => boxHoldsOnlyBoxable(ctx, field.value, seen, false))
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
  return jsonUnsupportedReason(ctx.deriver, dynamic, emptyJsonCollected(), new Set(), 'write') === null ? boxed : null
}

export const jsonCallText = (ctx: EmitContext, member: 'stringify' | 'parse', operation: CallOperation): string => {
  if (member === 'stringify') {
    if (operation.arguments.length < 1 || operation.arguments.length > 3) {
      throw createCppEmitBlockedError(
        'host-member-call:JSON.stringify',
        `JSON.stringify takes one to three arguments; this call passes ${operation.arguments.length}`
      )
    }
    const argument = operation.arguments[0] as IrOperand
    const reason = jsonUnsupportedReason(ctx.deriver, argument.representation, emptyJsonCollected(), new Set(), 'write')
    if (reason !== null) {
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
  if (operation.arguments.length !== 1) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      `JSON.parse's "reviver" parameter is not implemented (this call passes ${operation.arguments.length} argument(s); only the single-argument form is)`
    )
  }
  if (operation.result === null) {
    throw createCppEmitBlockedError(
      'host-member-call:JSON.parse',
      'this JSON.parse result is discarded; this backend only renders a parse whose value is used somewhere'
    )
  }
  const resultRepresentation = operation.result.representation
  const reason = jsonUnsupportedReason(ctx.deriver, resultRepresentation, emptyJsonCollected(), new Set(), 'read')
  if (reason !== null)
    throw createCppEmitBlockedError('host-member-call:JSON.parse', `JSON.parse cannot decode natively into this asserted type: ${reason}`)
  const textArgument = operandText(ctx, operation.arguments[0] as IrOperand)
  const resultType = cppTypeOf(resultRepresentation)
  return `[&]() { const std::string& gea_json_text = ${textArgument}; gea::json::Reader gea_json_reader(gea_json_text); ${resultType} gea_json_result{}; gea_json_read(gea_json_reader, gea_json_result); return gea_json_result; }()`
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
  const reason = jsonUnsupportedReason(ctx.deriver, argument.representation, emptyJsonCollected(), new Set(), 'write')
  if (reason !== null) {
    // The expression form serializes the boxed value instead (`jsonCallText`).
    if (boxedJsonArgumentText(ctx, argument) !== null) return null
    throw createCppEmitBlockedError('host-member-call:JSON.stringify', `JSON.stringify cannot serialize this argument natively: ${reason}`)
  }
  const cell = bindingReference(ctx, declaration, 'a JSON.stringify written in place')
  if (cell.boxed) return null
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
