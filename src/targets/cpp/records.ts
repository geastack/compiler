import type { DeclarationId, FunctionId, StructuralTypeId } from '../../identity/ids.js'
import type { ClassLayout } from '../../projection/classes.js'
import {
  declaredFieldRepresentationOf,
  declaredRecordFieldOf,
  nativeBaseFieldOf,
  recordAccessorBodiesOf,
  recordAccessorsOfShape,
  recordFieldsOfShape
} from '../../projection/fields.js'
export {
  declaredFieldRepresentationOf,
  declaredRecordFieldOf,
  nativeBaseFieldOf,
  recordAccessorBodiesOf,
  recordAccessorsOfShape,
  recordFieldsOfShape
}
import type { ClassStaticFieldStorage, LazyArrowFieldPlan } from './class-layout.js'
import { lazyArrowFieldPlansForClass } from './class-layout.js'
import type { ReactiveCellPlan } from './host/host-members.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import type { RecordAccessor, RecordField, RecordIndexSidecar, Representation, CallableAbi } from '../../representation/model.js'
import { representationKey, walkRepresentation } from '../../representation/model.js'
import { dynamicFieldAbsencePolicy } from '../../representation/field-descriptor-policy.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import { integerStorageSlot } from '../../ir/integer-storage.js'
import { recordIndexDomainContainsKey } from '../../ir/native-record-index.js'
import type { ReflectionExposure, ReflectionFieldOperations } from '../../ir/reflection-demand.js'
import {
  cppBodyName,
  cppClassName,
  cppNarrowedIntegerType,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldAttributesName,
  cppRecordFieldName,
  cppRecordAccessorEnvironmentName,
  cppRecordFieldPresenceName,
  cppArrayExtensionStructName,
  cppRecordStructName,
  cppStringLiteral,
  cppTypeOf
} from './types.js'
import { storedEnvironmentText } from './emit-context.js'
import { boxedText, dynamicCarrierBoxText, dynamicTagFor } from './emit-narrowing.js'

/**
 * The value carrier of a struct's dynamic-property sidecar, plus its key
 * domain. The representation model owns this pair; this module only re-exports
 * the type alongside the layout helpers that consume it.
 */
export type { RecordIndexSidecar } from '../../representation/model.js'

/**
 * The physical Optional carrier does not remember whether its empty state is
 * JavaScript null or undefined. NativeFieldWrite therefore carries the
 * representation's absence policy at every optional and union node.
 */
const nativeFieldPolicyType = (representation: Representation): string => {
  switch (representation.kind) {
    case 'optional':
      return `gea::NativeFieldOptionalPolicy<${representation.absence === 'null' ? 'true' : 'false'}, ${nativeFieldPolicyType(representation.payload)}>`
    case 'tagged-union':
      return `gea::NativeFieldUnionPolicy<${representation.arms.map((arm) => nativeFieldPolicyType(arm.value)).join(', ')}>`
    default:
      return 'gea::NativeFieldLeafPolicy'
  }
}

const nativeFieldPolicyValue = (representation: Representation): string => `${nativeFieldPolicyType(representation)}{}`
const nativeFieldPolicyArgument = (representation: Representation): string =>
  representation.kind === 'optional' || representation.kind === 'tagged-union' ? `, ${nativeFieldPolicyValue(representation)}` : ''
const nativeFieldPolicyTemplate = (representation: Representation): string =>
  representation.kind === 'optional' || representation.kind === 'tagged-union' ? `<${nativeFieldPolicyType(representation)}>` : ''

/**
 * The physical layout one struct renders: its named fields, plus the value
 * carrier of its dynamic-property sidecar when it has one.
 *
 * `indexes` is empty for a plain record and contains one entry per disjoint
 * native key domain for `record-with-index`. The named and open halves are
 * members of the same struct, never separately-spelled types.
 */
interface RecordLayout {
  readonly fields: readonly RecordField[]
  readonly indexes: readonly RecordIndexSidecar[]
  /**
   * The shape's accessor-backed members. They occupy no struct member -- see
   * `RecordAccessor` -- but they ARE own properties, so the boxed own-field
   * protocol below has to answer for them or a boxed read of one silently
   * reads `undefined` instead of running the getter.
   */
  readonly accessors: readonly RecordAccessor[]
}

/**
 * What one class struct derives from: the struct C++ names as its base, and the
 * shape whose fields that base already declares.
 *
 * Both halves are needed and neither substitutes for the other. The name is
 * what `struct D : B` spells; the shape is what says which of `D`'s fields `B`
 * already has, and therefore which ones `D` may declare without shadowing them.
 * The checker's structural type of a derived class is *flattened* -- it lists
 * every inherited member as if the class declared it -- so without the base's
 * own shape to subtract, `D` would redeclare each inherited field and the two
 * copies would then disagree the moment a base body wrote through the base's.
 */
interface ClassBaseLink {
  readonly structName: string
  readonly shapeId: string
  readonly native: boolean
}

/** One struct whose layout could not be rendered, named by the struct rather than by a semantic owner it has none of. */
export interface CppRecordRefusal {
  readonly structName: string
  readonly reason: string
}

/**
 * Every class struct's base link, keyed by the struct name that derives.
 *
 * The base's shape is read off its *instance carrier* rather than re-derived
 * from a declaration, because that carrier is what the class's own construction
 * publishes as the thing it returns -- the same value `constructDefinitionsOf`
 * spells as the construct's result. A class that states a base whose instance
 * carrier is absent or is not a class reference names no shape to subtract; the
 * reason is recorded rather than dropped, so the struct refuses by name instead
 * of silently emitting flat and colliding with a base body later.
 */
const classBaseLinks = (
  classes: ReadonlyMap<DeclarationId, Pick<ClassLayout, 'declaration' | 'base' | 'nativeBase' | 'instance'>>
): { readonly links: ReadonlyMap<string, ClassBaseLink>; readonly unlinkable: ReadonlyMap<string, string> } => {
  const links = new Map<string, ClassBaseLink>()
  const unlinkable = new Map<string, string>()
  for (const layout of classes.values()) {
    if (layout.nativeBase !== null) {
      const structName = cppClassName(layout.declaration)
      if (layout.nativeBase.instance.native === null) {
        unlinkable.set(structName, `its native base ${layout.nativeBase.protocol} published no native C++ layout`)
        continue
      }
      links.set(structName, {
        structName: layout.nativeBase.instance.native,
        shapeId: layout.nativeBase.instance.shapeId,
        native: true
      })
      continue
    }
    if (layout.base === null) continue
    const structName = cppClassName(layout.declaration)
    const instance = classes.get(layout.base)?.instance
    if (!instance || instance.kind !== 'class-ref') {
      unlinkable.set(structName, `its base ${layout.base} published no class-reference instance carrier to take a layout from`)
      continue
    }
    links.set(structName, { structName: cppClassName(layout.base), shapeId: instance.shapeId, native: false })
  }
  return { links, unlinkable }
}

/**
 * The one shape a class's struct is built from, by struct name.
 *
 * A class's C++ struct is named by its DECLARATION (`cppClassName`), and the
 * projection collapses a generic class's copies onto one declaration
 * (`projection/classes.ts`'s `collapseSpecializations`). Its `class-ref`
 * carriers, however, still name whichever instance SHAPE the site that built
 * them derived -- an uninstantiated root's `Context<E>` and a monomorphized
 * copy's `Context<{ ... }>` are two shapes under one struct name.
 *
 * `collectRequiredStructs`'s cycle guard then rendered the struct from
 * whichever of them the plan happened to walk first, and every operation typed
 * against the other one compiled against members that were not there: hono's
 * `Context.env` was declared `gea::Value` from the unbound root while its own
 * constructor stored an `Optional<Ref<...>>` into it, and clang rejected the
 * assignment. Silently, from the compiler's side -- both halves certified.
 *
 * `ClassLayout.instance` is already the authority for the OTHER half of this
 * question: `classBaseLinks` above subtracts a base's members using the base
 * class's instance shape, not whatever shape a `class-ref` to it carried. This
 * makes the struct itself, and every field lookup against it, read the same
 * one, so a class has exactly one layout everywhere.
 */
export const classInstanceShapes = (
  classes: ReadonlyMap<DeclarationId, Pick<ClassLayout, 'declaration' | 'instance'>>
): ReadonlyMap<string, string> => {
  const byStruct = new Map<string, string>()
  for (const layout of classes.values()) {
    const instance = layout.instance
    if (instance && instance.kind === 'class-ref') byStruct.set(cppClassName(layout.declaration), instance.shapeId)
  }
  return byStruct
}

const visitAbi = (abi: CallableAbi, visitStruct: (structName: string, shapeId: string, layout: RecordLayout | null) => void): void => {
  for (const parameter of abi.parameters) visitRepresentation(parameter.value, visitStruct)
  visitRepresentation(abi.result, visitStruct)
  if (abi.receiver !== null) visitRepresentation(abi.receiver, visitStruct)
}

/**
 * Walks one representation for every nested `record`/`record-with-index`/
 * `native-record-ref`, reporting each to `visitStruct` with its layout when it
 * carries one (a `record` or `record-with-index`) or `null` when it does not
 * (a `native-record-ref`, which only ever names a shape -- see the model
 * comment on that variant).
 *
 * Exhaustive over `Representation['kind']` with no `default`, matching
 * `cppTypeOf` and `representationIsRenderable` (document.ts): a new carrier
 * kind that can hold a record must be taught to this walk, not silently
 * skipped by falling through a catch-all.
 */
const visitRepresentation = (
  representation: Representation,
  visitStruct: (structName: string, shapeId: string, layout: RecordLayout | null) => void
): void => {
  switch (representation.kind) {
    case 'unresolved':
    case 'void':
    case 'string':
    case 'null':
    case 'undefined':
    case 'scalar':
    case 'native-handle':
    case 'typed-array':
    // No struct to visit: an ArrayBuffer is a byte block the runtime owns
    // whole, exactly as a typed array view is.
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'dynamic':
      return
    case 'class-ref':
      visitStruct(cppClassName(representation.declaration), representation.shapeId, null)
      return
    case 'record':
      visitStruct(cppRecordStructName(representation.shapeId), representation.shapeId, {
        fields: representation.fields,
        indexes: [],
        accessors: representation.accessors
      })
      return
    case 'record-with-index':
      visitStruct(cppRecordStructName(representation.shapeId), representation.shapeId, {
        fields: representation.fields,
        indexes: representation.indexes,
        accessors: []
      })
      return
    case 'native-record-ref':
      // A stated-native record is defined by the engine header, so this
      // backend must not emit a struct of its own for it -- two definitions of
      // one type is an ODR violation, and the compiler's would be the wrong
      // one. Its members are still reached by name, which is what makes clang
      // the check on any name the host type does not actually have.
      if (representation.native) return
      visitStruct(cppRecordStructName(representation.shapeId), representation.shapeId, null)
      return
    case 'proxy-object':
      visitRepresentation(representation.target, visitStruct)
      visitRepresentation(representation.handler, visitStruct)
      return
    case 'borrowed-ref':
      visitRepresentation(representation.referent, visitStruct)
      return
    case 'array-object':
    case 'dense-buffer':
    case 'native-sequence':
      visitRepresentation(representation.element, visitStruct)
      return
    case 'iterator':
      visitRepresentation(representation.element, visitStruct)
      visitRepresentation(representation.resume, visitStruct)
      visitRepresentation(representation.completion, visitStruct)
      return
    case 'promise':
      visitRepresentation(representation.value, visitStruct)
      return
    case 'keyed-collection':
      // Both positions, and the value position especially: a `Map<string,
      // Entry>` whose value is a `record` needs that struct DEFINED, and a
      // walk that stopped at the collection would leave the emitted
      // `gea::Map<std::string, gea_record_type_7>` naming a struct no
      // translation unit declares.
      visitRepresentation(representation.key, visitStruct)
      if (representation.value) visitRepresentation(representation.value, visitStruct)
      return
    case 'dictionary':
      visitRepresentation(representation.value, visitStruct)
      return
    case 'function-and-constructor':
      visitAbi(representation.call, visitStruct)
      visitAbi(representation.construct, visitStruct)
      return
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      visitAbi(representation.abi, visitStruct)
      return
    case 'generic-function-set':
      return
    case 'optional':
      visitRepresentation(representation.payload, visitStruct)
      return
    case 'tagged-union':
      for (const arm of representation.arms) visitRepresentation(arm.value, visitStruct)
      return
  }
}

/**
 * Whether a representation names any struct this compilation mints --
 * `gea_record_*` or `gea_class_*`, from `cppRecordStructName`/`cppClassName`
 * above -- anywhere in its type, including nested inside a callable ABI, a
 * collection element, or an optional/union payload.
 *
 * `translation-unit.ts` asks this of a cell's `extern`/absent declaration to
 * decide whether the declaration can be hoisted ahead of the unnamed
 * namespace an isolated unit wraps its definitions in: a struct minted by
 * this compilation is defined INSIDE that namespace, so a declaration naming
 * one cannot be placed ahead of it. The question is answered by walking the
 * representation `visitRepresentation` already walks for struct dependency
 * ordering -- the same one, not a second one -- rather than by searching the
 * declaration's own rendered C++ text for the name prefixes, which is a
 * source-shaped approximation of a fact this compilation already knows from
 * the representation it rendered that text from. A `native-record-ref` with a
 * stated `.native` name is excluded by `visitRepresentation` itself (it never
 * calls back for one), which is correct here too: that struct is the host's,
 * declared in a header already included, not one this compilation defines.
 */
export const representationNamesMintedStruct = (representation: Representation): boolean => {
  let found = false
  visitRepresentation(representation, () => {
    found = true
  })
  return found
}

/**
 * Every distinct struct name the plan's carriers require, and the layout to
 * render for it where a `record`/`record-with-index` supplied one.
 *
 * `fieldsByStruct` is also this walk's cycle guard: a struct is only expanded
 * -- its fields recursed into -- the first time a layout for it is seen. A
 * layout is set into the map *before* that recursion runs, so a
 * self-referential shape that reaches its own struct name again (directly, or
 * through a field that is itself a `record`/`record-with-index` rather than
 * the usual `native-record-ref`) finds the entry already present and stops
 * instead of looping. A recursive type is expected to break the cycle with
 * `native-record-ref` (model.ts), which carries no fields to recurse into at
 * all, but the guard does not depend on that discipline being honoured.
 */
const collectRequiredStructs = (
  representations: readonly Representation[],
  deriver: RepresentationDeriver,
  bases: ReadonlyMap<string, ClassBaseLink>,
  unlinkable: ReadonlyMap<string, string>,
  classShapes: ReadonlyMap<string, string>,
  classFields: ReadonlyMap<string, readonly RecordField[]>
): {
  readonly requiredStructs: ReadonlySet<string>
  readonly fieldsByStruct: ReadonlyMap<string, RecordLayout>
  readonly unlayoutable: ReadonlyMap<string, string>
} => {
  const requiredStructs = new Set<string>()
  const fieldsByStruct = new Map<string, RecordLayout>()
  // Why a struct has no layout, kept per struct name so the refusal can name
  // the gap instead of only the symptom.
  const unlayoutable = new Map<string, string>(unlinkable)

  const visitStruct = (structName: string, requestedShapeId: string, layout: RecordLayout | null): void => {
    // See `classInstanceShapes`: a class has one struct, so it has one layout,
    // and which one is the projection's answer rather than the walk order's.
    const shapeId = classShapes.get(structName) ?? requestedShapeId
    requiredStructs.add(structName)
    if (fieldsByStruct.has(structName)) return
    if (unlayoutable.has(structName)) return
    // A nominal reference carries no layout of its own: a declared type is
    // carried by name precisely so `interface Node { next: Node }` has a finite
    // carrier. The layout is not missing, it is in the sealed structural table,
    // and deriving the shape the reference names is how it is read back. Nothing
    // in `plan.selected` can substitute: no producer ever publishes a result
    // whose carrier is a declared type's own body, so waiting for one to appear
    // means never emitting a struct for an ordinary named interface.
    const raw = layout ?? recordLayoutOfShape(deriver, shapeId)
    const nativeFields = classFields.get(structName)
    const resolved = typeof raw === 'string' || nativeFields === undefined ? raw : { ...raw, fields: nativeFields }
    if (typeof resolved === 'string') {
      unlayoutable.set(structName, `${shapeId} carries ${resolved}`)
      return
    }
    // A field or sidecar derived here is invisible to every guard that ran
    // before this point. `verify.ts` walks `plan.selected`, and no producer
    // ever publishes a result whose carrier is a declared type's own body --
    // so a nominal reference can be perfectly resolved while the layout
    // behind its name is not. Letting that through renders
    // `cppTypeOf(unresolved)`, which is a throw from the type layer with no
    // program context attached; naming the field here is the same refusal
    // one stage earlier, where the shape and the field are both still in
    // hand.
    const bottom = resolved.fields.find((field) => field.value.kind === 'unresolved')
    if (bottom && bottom.value.kind === 'unresolved') {
      unlayoutable.set(structName, `${shapeId} field "${bottom.key}" carries unresolved(${bottom.value.reason})`)
      return
    }
    const unresolvedIndex = resolved.indexes.find((index) => index.value.kind === 'unresolved')
    if (unresolvedIndex?.value.kind === 'unresolved') {
      unlayoutable.set(structName, `${shapeId} ${unresolvedIndex.key} index sidecar carries unresolved(${unresolvedIndex.value.reason})`)
      return
    }
    // A derived struct declares only what its base does not already have. The
    // shape resolved above is the checker's flattened view -- it lists every
    // inherited member -- so declaring it verbatim under a `: Base` clause
    // would give the object two `name` members, and a base method writing
    // through its own would be invisible to a derived reader. Which fields the
    // base has is the base *shape's* answer, taken from the deriver exactly as
    // this struct's own was, so the two are never two opinions.
    const base = bases.get(structName)
    const own = base ? ownFieldsOf(deriver, resolved, base, classFields.get(base.structName)) : resolved
    if (typeof own === 'string') {
      unlayoutable.set(structName, own)
      return
    }
    fieldsByStruct.set(structName, own)
    // Every field the shape has, inherited ones included: the carriers they name
    // still have to be required here, and the base struct's own expansion is not
    // guaranteed to reach a nested shape this one holds by a different route.
    for (const field of resolved.fields) visitRepresentation(field.value, visitStruct)
    for (const index of resolved.indexes) visitRepresentation(index.value, visitStruct)
    if (base && !base.native) visitStruct(base.structName, base.shapeId, null)
  }

  for (const representation of representations) visitRepresentation(representation, visitStruct)

  return { requiredStructs, fieldsByStruct, unlayoutable }
}

/**
 * The half of a derived class's layout that it declares itself, or the reason
 * the subtraction could not be made.
 *
 * A key the base already declares is dropped, and dropped whatever carrier the
 * derived's own shape gave it. An object has ONE property per key (ECMA-262
 * 10.1: an ordinary object's [[OwnPropertyKeys]] is a set, and a derived
 * constructor writes into the very same slot the base's does), so a key both
 * shapes carry is one storage member and the base is where it lives -- a
 * derived member of the same name would be a second slot C++ would happily let
 * shadow the first, leaving a base body writing one copy while a derived reader
 * saw the other.
 *
 * This used to refuse when the two carriers DIFFERED, on the theory that a
 * difference meant a real override. It does not. The common cause is one
 * INHERITED member interned twice: `class Hono<E, S, P> extends HonoBase<E, S,
 * P>` gives the two classes distinct type-parameter symbols, so `HonoBase`'s
 * own `readonly getPath: GetPath<E>` derives one record for `E`-as-declared-in-
 * `HonoBase` and another for `E`-as-declared-in-`Hono`, and the structural view
 * of the derived class lists the inherited member under the second. Neither
 * class declared anything twice -- `Hono` declares no fields at all -- so
 * refusing here reported a conflict that does not exist in the program.
 *
 * A genuine TypeScript override that narrows a field's declared type is not a
 * second slot either: it is a type-level claim about the one slot, and a
 * derived read that wants the narrower carrier narrows at the read, which
 * `narrowedFieldReadText` (emit-properties.ts) already does and still refuses
 * by name when it cannot.
 */
const ownFieldsOf = (
  deriver: RepresentationDeriver,
  derived: RecordLayout,
  base: ClassBaseLink,
  nativeFields?: readonly RecordField[]
): RecordLayout | string => {
  const baseLayout = recordLayoutOfShape(deriver, base.shapeId)
  if (typeof baseLayout === 'string') return `its base struct ${base.structName} (${base.shapeId}) carries ${baseLayout}`
  const inherited = new Map((nativeFields ?? baseLayout.fields).map((field) => [field.key, field]))
  const inheritedAccessors = new Set(baseLayout.accessors.map((accessor) => accessor.key))
  return {
    fields: derived.fields.filter((field) => !inherited.has(field.key)),
    indexes: derived.indexes,
    accessors: derived.accessors.filter((accessor) => !inheritedAccessors.has(accessor.key))
  }
}

/**
 * The struct name a carrier IS, when holding one by value embeds it.
 *
 * `native-record-ref` with a stated `native` name is the host's own struct and
 * this module emits no definition for it, so it can never be a name this order
 * has to place.
 */
export const cppStructNameOf = (representation: Representation): string | null => {
  if (representation.kind === 'record' || representation.kind === 'record-with-index') return cppRecordStructName(representation.shapeId)
  if (representation.kind === 'native-record-ref')
    return representation.native === null ? cppRecordStructName(representation.shapeId) : null
  if (representation.kind === 'class-ref') return cppClassName(representation.declaration)
  return null
}

const isRepresentationNode = (value: unknown): value is Representation =>
  typeof value === 'object' && value !== null && typeof (value as { readonly kind?: unknown }).kind === 'string'

/**
 * The struct names a carrier requires the COMPLETE definition of.
 *
 * Two stopping rules, and they are the whole correctness argument. A carrier
 * whose `ownership` is not `owned` is a pointer or a reference
 * (`cppOwnershipWrap`, types.ts), which a forward declaration satisfies -- so
 * it is not a dependency, and descending past it would manufacture a cycle out
 * of two structs that legitimately point at each other. A callable -- spelled
 * by carrying an `abi` -- never requires its parameter or result types to be
 * complete either, for the same reason and with the same cycle risk.
 *
 * Everything else is walked STRUCTURALLY rather than by enumerating the thirty
 * representation kinds: a kind added to `model.ts` tomorrow is then ordered by
 * this walk automatically instead of silently falling out of it, which is the
 * failure mode a `switch` over kinds would have. The walk stops at each struct
 * it names -- that struct's own dependencies are placed when IT is ordered.
 */
const valueHeldStructNames = (representation: Representation, into: Set<string>, seen: Set<object>): void => {
  if (seen.has(representation)) return
  seen.add(representation)
  const node = representation as unknown as Readonly<Record<string, unknown>>
  const ownership = node['ownership']
  if (typeof ownership === 'string' && ownership !== 'owned') return
  if (node['abi'] !== undefined) {
    // A bare record in a function-pointer signature may remain incomplete,
    // but a by-value carrier BUILT AROUND that record may not. In
    // `CallableObject<TaggedUnion<Record, Ref<T>>()>`, naming the callable
    // instantiates `TaggedUnion`, whose inline storage immediately asks for
    // `sizeof(Record)`. Walk those composite parameter/result/receiver
    // carriers while continuing to skip a record named directly by the ABI.
    const abi = node['abi'] as CallableAbi
    const nested = [...abi.parameters.map((parameter) => parameter.value), abi.result, ...(abi.receiver ? [abi.receiver] : [])]
    for (const value of nested) {
      if (cppStructNameOf(value) === null) valueHeldStructNames(value, into, seen)
    }
    return
  }
  const named = cppStructNameOf(representation)
  if (named !== null) {
    into.add(named)
    return
  }
  const descend = (value: unknown): void => {
    if (isRepresentationNode(value)) {
      valueHeldStructNames(value, into, seen)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) descend(entry)
      return
    }
    // A plain carrier-holding record -- `RecordField`, a tagged-union arm --
    // is not itself a representation, so reaching the carriers inside it is
    // what keeps a struct nested one level down from being missed.
    if (typeof value === 'object' && value !== null && !seen.has(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) descend(nested)
    }
  }
  for (const value of Object.values(node)) descend(value)
}

/** Every struct one struct's own storage embeds by value. */
const structValueDependencies = (layout: RecordLayout): ReadonlySet<string> => {
  const into = new Set<string>()
  const seen = new Set<object>()
  for (const field of layout.fields) valueHeldStructNames(field.value, into, seen)
  for (const index of layout.indexes) valueHeldStructNames(index.value, into, seen)
  return into
}

/**
 * Struct names ordered so every struct a definition needs COMPLETE is defined
 * before it.
 *
 * Two dependencies need completeness and a forward declaration cannot supply
 * either. A base: `struct D : B` names `B` in a position that has to be a
 * complete type. And a field held by value: `struct A { gea::Optional<B> b; }`
 * embeds a `B`, so `B`'s definition -- not its declaration -- has to precede
 * `A`'s. The second one used to be left to a sort by NAME, which is not an
 * order at all: `gea_record_type_1173` sorts before `gea_record_type_695`
 * because `'1' < '6'`, so an app whose struct numbering fell that way emitted a
 * struct with an incomplete member and failed to compile (`sky-hop`,
 * `sky-hop-jsx`) while every other app happened to be numbered the lucky way.
 *
 * The walk is depth-first and emits each name once. A name reached twice within
 * one chain is a cycle -- a class extending itself, or two structs embedding
 * each other by value, neither of which any well-formed C++ program has -- and
 * stopping there emits the enclosing struct first, leaving the C++ compiler to
 * name the incomplete type rather than this walk running forever. That is
 * exactly what the previous name sort did for every struct, so a cycle is no
 * worse than before and everything else is now right.
 */
const definitionOrder = (
  structNames: readonly string[],
  bases: ReadonlyMap<string, ClassBaseLink>,
  valueDependencies: ReadonlyMap<string, ReadonlySet<string>>
): readonly string[] => {
  const ordered: string[] = []
  const emitted = new Set<string>()
  const placeable = new Set(structNames)
  const visit = (structName: string, chain: ReadonlySet<string>): void => {
    if (emitted.has(structName) || chain.has(structName)) return
    const deeper = new Set([...chain, structName])
    const base = bases.get(structName)
    if (base && placeable.has(base.structName)) visit(base.structName, deeper)
    for (const dependency of valueDependencies.get(structName) ?? []) {
      // A name this run emits no definition for -- a host struct, or a carrier
      // naming a shape outside `requiredStructs` -- is not this order's to place.
      if (placeable.has(dependency)) visit(dependency, deeper)
    }
    if (emitted.has(structName)) return
    emitted.add(structName)
    ordered.push(structName)
  }
  for (const structName of structNames) visit(structName, new Set())
  return ordered
}

/**
 * The layout of the shape a nominal record reference names.
 *
 * The deriver is the one authority on what a structural type physically is, so
 * this asks it rather than reading the table's shapes directly -- a second
 * reading would be a second opinion about layout, and the two would eventually
 * disagree about exactly the types that are hardest to check by eye.
 *
 * When the shape has no record layout the *carrier it does have* is what says
 * why, so it is returned rather than discarded: "the shape derives
 * `unresolved(no primitive for a record carrier with a symbol-keyed index
 * signature)`" names a gap someone can close, where "no reachable record
 * carrier defines their fields" names a search that failed and points at the
 * wrong stage entirely.
 */
const recordLayoutOfShape = (deriver: RepresentationDeriver, shapeId: string): RecordLayout | string => {
  const carrier = deriver.layoutOf(shapeId as StructuralTypeId)
  if (carrier.kind === 'record') return { fields: carrier.fields, indexes: [], accessors: carrier.accessors }
  if (carrier.kind === 'record-with-index') return { fields: carrier.fields, indexes: carrier.indexes, accessors: [] }
  return representationKey(carrier)
}

/**
 * A shape's own dynamic-property sidecars, or an empty list when its layout
 * has none.
 *
 * `native-record-ref` (model.ts) names a shape rather than carrying its own
 * `indexes` inline the way `record-with-index` does -- it is a
 * reference, resolved by `recordLayoutOfShape` exactly as
 * `recordFieldsOfShape` already resolves the named half. A computed-key
 * `[[Get]]`/`[[Set]]` on a `native-record-ref` receiver (`emit-properties.ts`)
 * needs this to find the identical sidecar members `renderStructDefinition`
 * gives the struct when its shape has index
 * signatures -- an `ArrayLike<number>`-shaped interface (`{ length: number;
 * [index: number]: number }`) derives `native-record-ref` here the same way
 * any other named interface does, and its computed reads have nowhere else to
 * go. An empty result is not a gap to fill: there is no sidecar member to route
 * to, and `preflight/run.ts` checks this same
 * question per site before certifying one (see its own comment for why an
 * unconditional claim would over-claim).
 */
export const recordIndexesOfShape = (deriver: RepresentationDeriver, shapeId: string): readonly RecordIndexSidecar[] => {
  const layout = recordLayoutOfShape(deriver, shapeId)
  return typeof layout === 'string' ? [] : layout.indexes
}

/**
 * The reserved member name for a record's dynamic-property sidecar.
 *
 * `cppRecordFieldName` (types.ts) throws for any source key inside the
 * `gea_` prefix, so no field a program actually declares can collide with
 * this name -- the sidecar and an ordinary field are drawn from disjoint
 * namespaces by construction, not by hoping no one names a property this.
 */
export const cppRecordIndexSidecarName = 'gea_dynamic'

/** Domain-specific name when a record carries both text and symbol tables. */
export const cppRecordIndexSidecarNameFor = (index: RecordIndexSidecar, indexes: readonly RecordIndexSidecar[]): string =>
  indexes.length > 1 && index.key === 'symbol' ? 'gea_symbol_dynamic' : cppRecordIndexSidecarName

/**
 * Attribute state for entries in `gea_dynamic`.
 *
 * The index dictionary deliberately remains typed: this companion table holds
 * only the three data-property bits that an ordinary assignment cannot carry.
 * It is therefore not a second value store and cannot turn an indexed record
 * into a boxed object merely because one entry is non-enumerable or sealed.
 */
export const cppRecordIndexAttributesName = 'gea_dynamic_attributes'

export const cppRecordIndexAttributesNameFor = (index: RecordIndexSidecar, indexes: readonly RecordIndexSidecar[]): string =>
  indexes.length > 1 && index.key === 'symbol' ? 'gea_symbol_dynamic_attributes' : cppRecordIndexAttributesName

/**
 * The C++ type each `gea::Value::Tag` pins down exactly.
 *
 * `Value::as<T>()` is an unchecked `static_pointer_cast`: the tag says which
 * alternative was written, and the reader has to name the same C++ type the
 * writer boxed. For an object or a function the payload type travels with the
 * box (`nativeFieldOpsFor` is instantiated from the payload's static type at
 * the `box` call site), so a read is always type-correct. For a PRIMITIVE it
 * does not: `Tag::Number` is boxed from whatever numeric C++ type the source
 * carrier had, and this header's own `toBoolean` already reads every such box
 * back as `double`. So the three primitive tags are addressable only when the
 * field's own C++ type is the canonical one -- an `int32_t` field would box a
 * payload no reader could name, and that field refuses instead.
 */
const canonicalDynamicPayloads: ReadonlyMap<string, string> = new Map([
  ['Boolean', 'bool'],
  ['Number', 'double'],
  ['String', 'std::string']
])

/** One field, as the dynamic path can (or cannot) address it. */
interface DynamicFieldAccess {
  readonly key: string
  readonly member: string
  readonly tag: string
  readonly type: string
  readonly readable: boolean
  readonly writable: boolean
  /**
   * The member is itself a `gea::Value`, so the dynamic path neither boxes nor
   * unboxes -- it moves the box. No tag names it, because a box carries its own.
   */
  readonly boxed: boolean
  readonly dynamicCarrier?: boolean
}

/**
 * The accessors this renderer answers for.
 *
 * Symbol-keyed accessors are excluded, not forgotten: a unique symbol's id
 * only exists once the program runs, so the string-keyed dispatcher below has
 * nothing to compare against, and the well-known-symbol path
 * (`symbolBranchFor`) reads its bodies out of the per-key maps a FIELD fills.
 * Wiring accessors into that is a separate step; excluding them here keeps the
 * bits and the branches agreeing about which keys exist, which is the property
 * everything else in this file depends on.
 */
const renderableAccessors = (layout: RecordLayout): readonly RecordAccessor[] =>
  layout.accessors.filter((accessor) => !cppRecordFieldKeyIsSymbol(accessor.key))

/**
 * The boxed spelling of one accessor's value, or `null` when no static tag
 * names its carrier.
 *
 * The same two questions `dynamicFieldAccessOf` asks of a field's carrier,
 * asked of the accessor's -- `RecordAccessor.value`, derived by the identical
 * `deriveStored` call. `null` here means the dispatcher emits no read arm, so
 * a boxed read answers `undefined`: exactly what an unaddressable FIELD
 * already does, rather than a new refusal for a shape that compiles today.
 */
const accessorBoxedText = (accessor: RecordAccessor, call: string): string | null => {
  if (accessor.value.kind === 'dynamic') return call
  // A member the checker types `undefined` (a getter that only ever throws
  // reaches here as one) is compiled with a `void` ABI, so there is no value to
  // cast -- but the CALL still has to happen, because running the body is the
  // whole observable effect of reading the member.
  if (accessor.value.kind === 'undefined') return `((void)(${call}), gea::Value())`
  // The three carriers a FIELD reaches through the runtime's typed adapter
  // rather than through a box (`dynamicFieldAccessOf`'s `dynamicCarrier` arm).
  // `boxedText` would `static_cast` them into a payload no reader can name, so
  // this refuses instead and the dispatcher emits a named runtime refusal.
  if (accessor.value.kind === 'optional' || accessor.value.kind === 'tagged-union' || accessor.value.kind === 'dictionary') return null
  const tag = dynamicTagFor(accessor.value)
  if (tag === null) return null
  const canonical = canonicalDynamicPayloads.get(tag)
  if (canonical !== undefined && canonical !== cppTypeOf(accessor.value)) return null
  return boxedText(accessor.value, tag, call)
}

/** The other direction: what a boxed write hands the setter body, or `null` when no static tag names the carrier. */
const accessorUnboxText = (accessor: RecordAccessor, structName: string, text: string): string | null => {
  if (accessor.value.kind === 'dynamic') return text
  if (accessor.value.kind === 'optional' || accessor.value.kind === 'tagged-union' || accessor.value.kind === 'dictionary') return null
  const tag = dynamicTagFor(accessor.value)
  if (tag === null) return null
  const type = cppTypeOf(accessor.value)
  const canonical = canonicalDynamicPayloads.get(tag)
  if (canonical !== undefined && canonical !== type) return null
  return `gea::detail::unboxField<${type}>(${text}, gea::Value::Tag::${tag}, ${cppStringLiteral(structName)}, ${cppStringLiteral(accessor.key)})`
}

const dynamicFieldAccessOf = (field: RecordField, storageType: string): DynamicFieldAccess | null => {
  // Whether this field can be reached dynamically is a question about its
  // VALUE's carrier, not about whether the key that names it is a string or a
  // symbol -- a `[Symbol.iterator]() {}` method boxes exactly the way a
  // same-shaped `next() {}` method does. This function used to refuse every
  // symbol-keyed field outright, which is what `renderFieldDispatcher` relied
  // on to justify treating EVERY symbol key as unaddressable; that conflated
  // "the key is a symbol" with "the id is unknowable", which is false for the
  // fifteen well-known symbols (`Symbol.iterator` and its siblings are minted
  // once, before any user `Symbol()` call, at a fixed low id --
  // `gea::wellKnownSymbol`). The dispatcher now decides addressability by
  // symbol identity itself, so this function computes the same access facts
  // for every field regardless of its key's shape.
  // A field whose own carrier is the box is the one case that needs no tag at
  // all: `dynamicTagFor` answers `null` for `dynamic` because no STATIC tag
  // describes it, and reading that as "unaddressable" refused a member the
  // dynamic path can reach more directly than any other -- by copying the
  // `gea::Value` it already is. hono's `HonoBase` is the case: `this[method] =
  // handler` over `allMethods` writes nine such fields, and every one of them
  // aborted the program on the first route registration.
  if (field.value.kind === 'dynamic' && storageType === 'gea::Value') {
    return { key: field.key, member: cppRecordFieldName(field.key), tag: '', type: '', readable: true, writable: true, boxed: true }
  }
  // Optional callable traps and union fields carry their own live tag. An open
  // dictionary likewise keeps one exact native reference type on both sides of
  // a dynamic property operation: its values are already the declared dynamic
  // boundary, while the dictionary object itself retains identity. Let the
  // runtime's typed adapter move these carriers across the transient Value
  // without replacing the field's native storage with a box.
  if (field.value.kind === 'optional' || field.value.kind === 'tagged-union' || field.value.kind === 'dictionary') {
    return {
      key: field.key,
      member: cppRecordFieldName(field.key),
      tag: '',
      type: storageType,
      readable: true,
      writable: true,
      boxed: false,
      dynamicCarrier: true
    }
  }
  const tag = dynamicTagFor(field.value)
  if (tag === null) {
    return { key: field.key, member: cppRecordFieldName(field.key), tag: '', type: '', readable: false, writable: false, boxed: false }
  }
  // The type the MEMBER is declared with, not the one its representation would
  // spell: a narrowed `number` member is a `long long`, and boxing one under
  // `Tag::Number` would hand every reader a payload it names `double`. That is
  // precisely the case the canonical table below exists to refuse, so it is
  // shown the storage and refuses -- loudly -- rather than punning.
  const type = storageType
  const canonical = canonicalDynamicPayloads.get(tag)
  const readable = canonical === undefined || canonical === type
  return {
    key: field.key,
    member: cppRecordFieldName(field.key),
    tag,
    type,
    readable,
    writable: readable && canonical !== undefined,
    boxed: false
  }
}

const refuseFieldText = (structName: string, key: string): string =>
  `gea::detail::refuseUnaddressableField(${cppStringLiteral(structName)}, ${cppStringLiteral(key)});`

/**
 * The `gea::detail::WellKnownSymbol` enum member a symbol-keyed record
 * field's declaration denotes, or `null` when the field's key names a
 * genuinely unique symbol (`Symbol()`/`Symbol('x')`) whose id only exists
 * once the program runs and can never be compared against here.
 *
 * `key` is the `sym(<declaration>)` marker `derive.ts`'s `recordFieldKeyOf`
 * mints for the field; `wellKnownSymbols` is the frontend's own
 * declaration-identity census of `SymbolConstructor`'s members
 * (`host-protocols.ts`'s `wellKnownSymbolDeclarationsOf`) -- the SAME
 * authority `emit-context.ts`'s `wellKnownSymbolMemberOf` asks for a static
 * key read off an `IrOperand`, restated here because a record field's key
 * arrives as plain text, never as an operand. The member name TypeScript
 * reports (`iterator`, `asyncIterator`, ...) and the runtime's enum member
 * spelling (`Iterator`, `AsyncIterator`, ...) differ only by their first
 * letter's case -- `gea_runtime.h`'s `enum class WellKnownSymbol` is
 * generated to match `SymbolConstructor`'s own member names one for one.
 */
const wellKnownSymbolEnumNameOf = (wellKnownSymbols: ReadonlyMap<DeclarationId, string>, key: string): string | null => {
  for (const [declaration, member] of wellKnownSymbols) {
    if (key === `sym(${declaration})`) return member.charAt(0).toUpperCase() + member.slice(1)
  }
  return null
}

/**
 * The field dispatcher every emitted struct carries: how a `gea::Value` that
 * boxes this struct reads, writes and enumerates the members C++ declares.
 *
 * This is the native answer to "a statically typed object is used
 * dynamically". The forbidden shortcut is to box the receiver and let its
 * declared fields disappear into an opaque payload; the answer here is that
 * the struct keeps its native layout and *states* how to reach it, so
 * `obj[key] = v` through an `any` writes the real member and every native read
 * of that member sees it. `gea::Value::box` finds these three by concept
 * (`detail::NativeFieldTable`) and stores a table of function pointers, so a
 * struct that is never boxed pays nothing and none of this changes any
 * struct's layout, size or triviality.
 *
 * A field the dispatcher cannot address REFUSES OUT LOUD rather than
 * answering `false`. The distinction is load-bearing: `false` means "this
 * struct does not declare that key", which is what routes a key to the box's
 * expando table, and a declared field answering `false` would let the expando
 * shadow it -- a write landing in a side table while every native read still
 * saw the old value. That is the silently-wrong answer, so it is spelled as a
 * loud one instead.
 */
/**
 * ECMA-262 10.1.11.1 OrdinaryOwnPropertyKeys: array-index keys first in
 * ascending numeric order, then the rest in creation order. Observable, not a
 * layout preference -- `Object.keys`, `for...in`, `Object.entries` and
 * `JSON.stringify` all read it. Source order answered `b,10,a,2` for
 * `{ b: 1, 10: 2, a: 3, 2: 4 }` where the specification says `2,10,b,a`.
 *
 * A stable partition, not one sort: non-index keys keep creation order. A
 * leading zero disqualifies a key (7.1.21 wants `ToString(ToUint32(P)) === P`).
 * Scoped to one struct's OWN keys -- a derived struct delegates to its base
 * first, so an array-index field on a DERIVED class does not hoist; not fixed.
 */
const isArrayIndexKey = (key: string): boolean => {
  if (key.length === 0 || key.length > 10) return false
  if (key.length > 1 && key.charCodeAt(0) === 48) return false
  for (let at = 0; at < key.length; at += 1) {
    const code = key.charCodeAt(at)
    if (code < 48 || code > 57) return false
  }
  return Number(key) < 4294967295
}

export const enumerationOrdered = <T>(entries: readonly T[], keyOf: (entry: T) => string): readonly T[] => [
  ...entries.filter((entry) => isArrayIndexKey(keyOf(entry))).sort((left, right) => Number(keyOf(left)) - Number(keyOf(right))),
  ...entries.filter((entry) => !isArrayIndexKey(keyOf(entry)))
]

/** Whether `text` contains `name` as a whole identifier rather than inside a longer one. */
const mentionsIdentifier = (text: string, name: string): boolean => {
  const isIdentifierCharacter = (character: string): boolean =>
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === '_'
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at === 0 ? '' : (text[at - 1] ?? '')
    const after = text[at + name.length] ?? ''
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true
  }
  return false
}

/** One parameter list split on the commas that separate parameters, never on one inside a template argument or a function type. */
const parameterListOf = (text: string): readonly string[] => {
  const parameters: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]
    if (character === '<' || character === '(') depth += 1
    else if (character === '>' || character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      parameters.push(text.slice(start, at))
      start = at + 1
    }
  }
  if (text.trim().length > 0) parameters.push(text.slice(start))
  return parameters
}

/**
 * The same hook declaration with every parameter its body never reads left
 * UNNAMED.
 *
 * A protocol hook ignores its parameters entirely or reads them all, according
 * to what the record declares -- a struct with no index properties reads none
 * of `gea_ownIndexPresent`'s. Both the declaration and the body are generated
 * side by side here, so the body's own text is the only authority on which
 * names it reads: there is no earlier fact to consult, because the body is
 * already rendered C++ by the time the two meet. C++ spells "deliberately
 * unused" by omitting the name, which is the same reason `nameOf` above
 * withholds `gea_name` from a hook with no fields.
 *
 * Only the emitter's own `gea_`-prefixed names are touched, so a parameter
 * this file did not name is left exactly as written.
 */
export const withUnreadParametersUnnamed = (declaration: string, body: readonly string[]): string => {
  const close = declaration.lastIndexOf(')')
  // A callable return type has its own parenthesized ABI before the body's
  // formals. Match the final list from its closing delimiter so its parameter
  // types cannot be mistaken for unused names in this function.
  let open = close
  let depth = 0
  for (; open >= 0; open -= 1) {
    if (declaration[open] === ')') depth += 1
    else if (declaration[open] === '(' && --depth === 0) break
  }
  if (open < 0 || close < open) return declaration
  const text = body.join('\n')
  const rewritten = parameterListOf(declaration.slice(open + 1, close)).map((parameter) => {
    const defaulted = parameter.indexOf('=')
    const head = defaulted < 0 ? parameter : parameter.slice(0, defaulted)
    const tail = defaulted < 0 ? '' : parameter.slice(defaulted)
    const trimmed = head.trimEnd()
    let start = trimmed.length
    while (start > 0) {
      const character = trimmed[start - 1] ?? ''
      if (!(
        (character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9') ||
        character === '_'
      ))
        break
      start -= 1
    }
    const name = trimmed.slice(start)
    if (trimmed.slice(0, start).trim().length === 0 || !name.startsWith('gea_') || mentionsIdentifier(text, name)) return parameter
    return trimmed.slice(0, start) + tail
  })
  return declaration.slice(0, open + 1) + rewritten.join(',') + declaration.slice(close)
}

const renderFieldDispatcher = (
  structName: string,
  layout: RecordLayout,
  base: ClassBaseLink | undefined,
  classDispatch: boolean,
  storageTypeOf: (field: RecordField) => string,
  wellKnownSymbols: ReadonlyMap<DeclarationId, string>,
  definitions?: string[],
  dynamicProtocol = true,
  fieldOperations: ReflectionFieldOperations | undefined = undefined,
  accessorCarriesEnvironment: (body: FunctionId) => boolean = () => false,
  /**
   * Whether the class is a root nothing derives from. Its protocol members
   * then dispatch statically: the only concrete type a handle to it can hold
   * is itself, so `virtual` would buy a vptr in every instance and nothing
   * else. (`gea::Ref` destroys through its own operations table, never a
   * virtual destructor.)
   */
  leafRoot = false,
  /**
   * This class's own lazily-materialized arrow fields, by key
   * (`class-layout.ts`'s `censusLazyArrowFields`) -- `undefined` for a
   * structural record, which cannot declare one (the design is per-class,
   * keyed on the declaring class's identity).
   */
  lazyArrowFields: ReadonlyMap<string, LazyArrowFieldPlan> | undefined = undefined
): readonly string[] => {
  const accesses = layout.fields.map((field) => ({ field, access: dynamicFieldAccessOf(field, storageTypeOf(field)) }))
  const symbolKeys = layout.fields.filter((field) => cppRecordFieldKeyIsSymbol(field.key))
  const baseRead = base ? [`    if (this->${base.structName}::gea_readOwnField(gea_key, gea_out)) return true;`] : []
  const baseWrite = base ? [`    if (this->${base.structName}::gea_writeOwnField(gea_key, gea_value, gea_extensible)) return true;`] : []
  const baseDelete =
    base && !base.native
      ? [`    if (this->${base.structName}::gea_matchesOwnField(gea_key)) return this->${base.structName}::gea_deleteOwnField(gea_key);`]
      : []
  const baseMatches = base && !base.native ? [`    if (this->${base.structName}::gea_matchesOwnField(gea_key)) return true;`] : []
  const baseFreezeFields = base && !base.native ? [`    this->${base.structName}::gea_freezeOwnFields();`] : []
  const baseSealFields = base && !base.native ? [`    this->${base.structName}::gea_sealOwnFields();`] : []
  const baseFrozenFields = base && !base.native ? [`    if (!this->${base.structName}::gea_ownFieldsFrozen()) return false;`] : []
  const baseSealedFields = base && !base.native ? [`    if (!this->${base.structName}::gea_ownFieldsSealed()) return false;`] : []
  // Native host bases have no generated index-sidecar hook. A generated class
  // base does, and its sidecar must remain visible through the derived view
  // without being confused with the derived class's fixed fields.
  const baseIndexRead = base && !base.native ? [`    if (this->${base.structName}::gea_readOwnIndex(gea_key, gea_out)) return true;`] : []
  const baseIndexWrite =
    base && !base.native
      ? [
          `    if (this->${base.structName}::gea_matchesOwnIndex(gea_key)) return this->${base.structName}::gea_writeOwnIndex(gea_key, gea_value, gea_extensible);`
        ]
      : []
  const baseIndexDelete =
    base && !base.native
      ? [`    if (this->${base.structName}::gea_matchesOwnIndex(gea_key)) return this->${base.structName}::gea_deleteOwnIndex(gea_key);`]
      : []
  const baseIndexDescriptor =
    base && !base.native
      ? [
          `    if (this->${base.structName}::gea_matchesOwnIndex(gea_key)) return this->${base.structName}::gea_ownIndexDescriptor(gea_key, gea_out);`
        ]
      : []
  const baseIndexDefine =
    base && !base.native
      ? [
          `    if (this->${base.structName}::gea_matchesOwnIndex(gea_key)) return this->${base.structName}::gea_defineOwnIndex(gea_key, gea_descriptor, gea_extensible);`
        ]
      : []
  const baseIndexMatches = base && !base.native ? [`    if (this->${base.structName}::gea_matchesOwnIndex(gea_key)) return true;`] : []
  const baseIndexFreeze = base && !base.native ? [`    this->${base.structName}::gea_freezeOwnIndex();`] : []
  const baseKeys = base ? [`    this->${base.structName}::gea_ownFieldKeys(gea_declared);`] : []

  const hasSymbolIndex = layout.indexes.some((index) => index.key === 'symbol')
  // A symbol-keyed field splits into two cases that look identical from the
  // field's OWN declaration but are not: a well-known symbol (`Symbol.iterator`
  // and its fourteen siblings) is minted once, before any user `Symbol()` call,
  // at a fixed low id (`gea::wellKnownSymbol`), so its identity is exactly as
  // knowable at compile time as a string key's spelling is. A genuinely unique
  // symbol (`Symbol()`/`Symbol('x')`) is not: its id exists only once the
  // program runs. Refusing every symbol key alike conflated the two -- the
  // fixture this was written against was `{ [Symbol.iterator]() {...} }`, an
  // object literal exposing exactly the iterator protocol every `for...of` and
  // destructuring source needs to invoke DYNAMICALLY (`source: any`) through
  // `gea::Value::getProperty(PropertyKey::symbol(...))`, and the blanket
  // refusal made every dynamic iteration over such a value abort at runtime --
  // `gea::runtime::iterator::getIterator`'s own `source.getProperty(key)`
  // could never reach a method that was RIGHT THERE, natively stored.
  //
  // `bodyOf` below reuses the exact per-field statement the string-keyed path
  // already renders for `gea_name == "<the field's own sym(...) marker>"` --
  // built once, by key, alongside `reads`/`writes`/`descriptors`/`defines`/
  // `matches`/`deletes` further down -- so there is exactly one place that
  // decides how one field is read, written or described, asked from two
  // different guards (a name equality and a symbol-id equality) rather than a
  // second opinion that could drift from the first.
  const symbolBranchFor = (hook: string, generatedOnly = false): readonly string[] => {
    // An open symbol index is the runtime answer for a symbol key the checker
    // did not resolve to one declared member. It has to reach the typed
    // sidecar below before the field dispatcher considers text names; routing
    // it into DynamicObject would box the index value and create a second
    // store invisible to native indexed reads.
    if (hasSymbolIndex) return []
    if (symbolKeys.length === 0) {
      if (base && (!generatedOnly || !base.native)) return [`    if (gea_key.isSymbol()) return this->${base.structName}::${hook};`]
      return ['    if (gea_key.isSymbol()) return false;']
    }
    const bodyOf = hookBodyByKey(hook)
    const resolved = symbolKeys.map((field) => ({ field, wellKnown: wellKnownSymbolEnumNameOf(wellKnownSymbols, field.key) }))
    const unresolved = resolved.filter((entry) => entry.wellKnown === null)
    const matchedBranches = resolved.flatMap((entry) => {
      if (entry.wellKnown === null) return []
      const body = bodyOf?.get(entry.field.key)
      // No entry means this exact field has no dynamic access at all (an
      // uninhabited or otherwise unboxable value) -- refuse it by name rather
      // than silently falling through to "not this field".
      const action = body ?? refuseFieldText(structName, `[symbol] ${entry.field.key}`)
      return [
        `      if (gea_key.symbolId() == static_cast<std::uint32_t>(gea::detail::WellKnownSymbol::${entry.wellKnown})) { ` +
          `const std::string& gea_name = ${cppStringLiteral(entry.field.key)}; (void)gea_name; ${action} }`
      ]
    })
    // A program's own symbol is compared by the id its cell registered
    // (`gea::detail::registerDeclaredSymbol`); a key matching none of them is
    // not this struct's, so it continues exactly as a struct with no symbol
    // fields would.
    const declaredBranches = unresolved.map((entry) => {
      const body = bodyOf?.get(entry.field.key)
      const action = body ?? refuseFieldText(structName, `[symbol] ${entry.field.key}`)
      return (
        `      if (gea_key.symbolId() == gea::detail::declaredSymbolId(${cppStringLiteral(entry.field.key)})) { ` +
        `const std::string& gea_name = ${cppStringLiteral(entry.field.key)}; (void)gea_name; ${action} }`
      )
    })
    const fallback = [
      ...declaredBranches,
      ...(base && (!generatedOnly || !base.native) ? [`      return this->${base.structName}::${hook};`] : ['      return false;'])
    ]
    return ['    if (gea_key.isSymbol()) {', ...matchedBranches, ...fallback, '    }']
  }

  // An index signature accepts every key of its domain, so its sidecar is the
  // struct's own answer for keys the named fields do not claim -- and reaching
  // it here is what keeps a dynamic write and a native indexed read looking at
  // the same storage. Number keys retain their original numeric source and
  // accept only a reflected string that is that number's canonical ECMAScript
  // spelling; every other text key remains an expando rather than becoming an
  // invisible second numeric store. Symbol sidecars are reachable directly:
  // PropertyKey carries the symbol id without passing through text.
  const sidecarRead: string[] = []
  const sidecarWrite: string[] = []
  const sidecarDelete: string[] = []
  const sidecarDescriptor: string[] = []
  const sidecarDefine: string[] = []
  const sidecarMatches: string[] = []
  const sidecarFreeze: string[] = []
  const sidecarSeal: string[] = []
  const sidecarFrozen: string[] = []
  const sidecarSealed: string[] = []
  const sidecarNativeWrites = new Map<string, string[]>()
  const sidecarKeys: string[] = []
  const sidecarPresent: string[] = []
  const sidecarEnumerable: string[] = []
  // Key discovery does not depend on whether the sidecar's VALUE can cross a
  // dynamic `gea::Value` boundary. `Reflect.ownKeys` needs to retain a symbol
  // property even when its payload is optional or another fully-native type
  // with no box recipe; string-only consumers filter the resulting
  // `PropertyKey` list in the runtime. Conflating discovery with readability
  // made such properties disappear from the object's own-key semantics.
  for (const index of layout.indexes) {
    const member = cppRecordIndexSidecarNameFor(index, layout.indexes)
    const attributes = cppRecordIndexAttributesNameFor(index, layout.indexes)
    const sidecarTag = dynamicTagFor(index.value)
    const sidecarValueType = cppTypeOf(index.value)
    const sidecarCanonical = sidecarTag === null ? undefined : canonicalDynamicPayloads.get(sidecarTag)
    // Optional and tagged sidecar values carry their own live dynamic tag.
    // Treat them exactly as a fixed field of the same carrier: an absent
    // Optional is a PRESENT property whose value is `undefined`, not a missing
    // sidecar entry.
    const sidecarDynamicCarrier =
      index.value.kind === 'dynamic' ||
      index.value.kind === 'optional' ||
      index.value.kind === 'tagged-union' ||
      index.value.kind === 'dictionary'
    const sidecarReadable =
      sidecarDynamicCarrier || (sidecarTag !== null && (sidecarCanonical === undefined || sidecarCanonical === sidecarValueType))
    const sidecarWritable = sidecarDynamicCarrier || (sidecarReadable && sidecarCanonical !== undefined)
    const sidecarPropertyKey =
      index.key === 'symbol'
        ? 'gea::PropertyKey::symbol(gea_entry.first)'
        : index.key === 'number'
          ? 'gea::PropertyKey::string(gea_entry.first)'
          : 'gea::PropertyKey::string(gea_entry.first)'
    sidecarKeys.push(`    for (const auto& gea_entry : ${member}) gea_declared.push_back(${sidecarPropertyKey});`)
    const sidecarKey =
      index.key === 'symbol'
        ? 'gea::Symbol(static_cast<std::uint32_t>(gea_key.symbolId()))'
        : index.key === 'number'
          ? 'gea_key.text()'
          : 'gea_key.text()'
    const sidecarGuard =
      index.key === 'symbol' ? 'gea_key.isSymbol()' : index.key === 'number' ? 'gea_key.isCanonicalNumberKey()' : '!gea_key.isSymbol()'
    sidecarPresent.push(`    if (${sidecarGuard}) { gea_out = ${member}.has(${sidecarKey}); return true; }`)
    sidecarEnumerable.push(
      `    if (${sidecarGuard}) { gea_out = ${member}.has(${sidecarKey}) && ${attributes}.attributes(${sidecarKey}).enumerable; return true; }`
    )
    if (sidecarReadable) {
      const sidecarReadValue = sidecarDynamicCarrier
        ? `gea::detail::readDynamicField<${sidecarValueType}>(${member}.read(${sidecarKey}), ${cppStringLiteral(structName)}, ${cppStringLiteral(`[${index.key} index]`)})`
        : `gea::Value::box(gea::Value::Tag::${sidecarTag}, static_cast<${sidecarValueType}>(${member}.read(${sidecarKey})))`
      sidecarRead.push(`    if (${sidecarGuard} && ${member}.has(${sidecarKey})) { gea_out = ${sidecarReadValue}; return true; }`)
      sidecarDescriptor.push(
        `    if (${sidecarGuard} && ${member}.has(${sidecarKey})) { ` +
          `gea_out = gea::PropertyDescriptor::assignment(${sidecarReadValue}); ` +
          `const gea::NativeIndexAttributes gea_attributes = ${attributes}.attributes(${sidecarKey}); ` +
          `gea_out.writable = gea_attributes.writable; gea_out.enumerable = gea_attributes.enumerable; gea_out.configurable = gea_attributes.configurable; return true; }`
      )
    }
    if (!sidecarReadable) {
      sidecarRead.push(`    if (${sidecarGuard}) ${refuseFieldText(structName, `[${index.key} index]`)}`)
      sidecarDescriptor.push(`    if (${sidecarGuard}) ${refuseFieldText(structName, `[${index.key} index]`)}`)
    }
    if (sidecarWritable) {
      const sidecarWriteValue = sidecarDynamicCarrier
        ? `gea::detail::writeDynamicField<${sidecarValueType}>(${member}[${sidecarKey}], gea_value, ${cppStringLiteral(structName)}, ${cppStringLiteral(`[${index.key} index]`)})`
        : `${member}[${sidecarKey}] = gea::detail::unboxField<${sidecarValueType}>(gea_value, gea::Value::Tag::${sidecarTag}, ${cppStringLiteral(structName)}, ${cppStringLiteral(`[${index.key} index]`)})`
      const sidecarAccepts = sidecarDynamicCarrier
        ? `gea::detail::dynamicFieldAccepts<${sidecarValueType}>(gea_value)`
        : `gea_value.tag() == gea::Value::Tag::${sidecarTag} && gea_value.payloadType() == gea::detail::payloadTypeTagFor<${sidecarValueType}>()`
      sidecarWrite.push(
        `    if (${sidecarGuard}) { const bool gea_exists = ${member}.has(${sidecarKey}); ` +
          `if ((!gea_exists && !gea_extensible) || (gea_exists && !${attributes}.attributes(${sidecarKey}).writable) || !(${sidecarAccepts})) return false; ` +
          `${sidecarWriteValue}; return true; }`
      )
      const appliedWrite = sidecarDynamicCarrier
        ? `gea::detail::writeDynamicField<${sidecarValueType}>(${member}[${sidecarKey}], gea_applied.value, ${cppStringLiteral(structName)}, ${cppStringLiteral(`[${index.key} index]`)})`
        : `${member}[${sidecarKey}] = gea_applied.value.as<${sidecarValueType}>()`
      sidecarDefine.push(
        `    if (${sidecarGuard}) { const bool gea_exists = ${member}.has(${sidecarKey}); gea::PropertyDescriptor gea_current; ` +
          `if (gea_exists && !gea_ownIndexDescriptor(gea_key, gea_current)) return false; gea::PropertyDescriptor gea_applied; ` +
          `if (!gea::applyNativeIndexDataDescriptor(gea_exists, gea_extensible, gea_current, gea_descriptor, gea_applied)) return false; ` +
          `if (!(${sidecarAccepts.replaceAll('gea_value', 'gea_applied.value')})) return false; ${appliedWrite}; ` +
          `${attributes}.set(${sidecarKey}, gea::NativeIndexAttributes{gea_applied.writable, gea_applied.enumerable, gea_applied.configurable}); return true; }`
      )
    } else {
      sidecarWrite.push(`    if (${sidecarGuard}) ${refuseFieldText(structName, `[${index.key} index]`)}`)
      sidecarDefine.push(`    if (${sidecarGuard}) ${refuseFieldText(structName, `[${index.key} index]`)}`)
    }
    sidecarMatches.push(`    if (${sidecarGuard}) return true;`)
    sidecarDelete.push(
      `    if (${sidecarGuard}) { if (${member}.has(${sidecarKey}) && !${attributes}.deleteAllowed(${sidecarKey})) return false; ` +
        `${member}.erase(${sidecarKey}); ${attributes}.erase(${sidecarKey}); return true; }`
    )
    sidecarFreeze.push(`    for (const auto& gea_entry : ${member}) ${attributes}.freeze(gea_entry.first);`)
    sidecarSeal.push(
      `    for (const auto& gea_entry : ${member}) { auto gea_attributes = ${attributes}.attributes(gea_entry.first); gea_attributes.configurable = false; ${attributes}.set(gea_entry.first, gea_attributes); }`
    )
    sidecarFrozen.push(
      `    for (const auto& gea_entry : ${member}) { const auto gea_attributes = ${attributes}.attributes(gea_entry.first); if (gea_attributes.configurable || gea_attributes.writable) return false; }`
    )
    sidecarSealed.push(
      `    for (const auto& gea_entry : ${member}) if (${attributes}.attributes(gea_entry.first).configurable) return false;`
    )
    const nativeWrites = sidecarNativeWrites.get(sidecarValueType) ?? []
    const mayAddressFixed = base !== null || layout.fields.some((field) => recordIndexDomainContainsKey(index.key, field.key))
    const fixedNativeWrite = !mayAddressFixed
      ? ''
      : index.value.kind === 'dynamic'
        ? `if (gea_matchesOwnField(gea_key)) return gea_writeOwnField(gea_key, gea_value, gea_extensible);`
        : `if (gea_matchesOwnField(gea_key)) return gea_writeOwnFieldNative(gea_key, gea::NativeFieldWrite(gea_value${nativeFieldPolicyArgument(index.value)}), gea_extensible);`
    // A `gea::Value` sidecar has no native caller (`nativeRecordIndexTransportOf`
    // refuses a dynamic value), and its fixed-field routing names
    // `gea_writeOwnField`, which only the dynamic protocol declares.
    if (index.value.kind !== 'dynamic' || dynamicProtocol)
      nativeWrites.push(
        `    if (${sidecarGuard}) { ${fixedNativeWrite} const bool gea_exists = ${member}.has(${sidecarKey}); ` +
          `if ((!gea_exists && !gea_extensible) || (gea_exists && !${attributes}.attributes(${sidecarKey}).writable)) return false; ` +
          `${member}[${sidecarKey}] = gea_value; return true; }`
      )
    sidecarNativeWrites.set(sidecarValueType, nativeWrites)
  }

  const reads: string[] = []
  const nativeReads: string[] = []
  const nativeReadsByKey = new Map<string, string>()
  const nativeFieldWrites: string[] = []
  const nativeFieldWritesByKey = new Map<string, string>()
  const writes: string[] = []
  const descriptors: string[] = []
  // The same fields' descriptor answers, minus the VALUE: presence and the
  // three attribute bits, which are plain bools. `gea_ownFieldDescriptor` used
  // to render one boxing expression per field -- the identical expression
  // `gea_readOwnField` already renders for that field -- so every fixed field
  // of every unrestricted carrier was boxed exactly twice, and the descriptor
  // half was half of all reflection boxing in the program. It is composed from
  // the read hook instead: this chain decides presence and attributes without
  // boxing anything, and one `gea::Value` per STRUCT carries the value.
  const descriptorAttributes: string[] = []
  /**
   * The plain data fields' reads, grouped by the CARRIER they box into.
   *
   * Every one of them renders `gea::Value::box(Tag::X, static_cast<T>(member))`
   * -- the same two-token recipe, differing only in which member it names. So a
   * struct with 341 numeric constants emitted 341 `gea::Value` construction
   * sites to do one thing. Grouped, each `(tag, type)` pair needs exactly one:
   * the key chain selects a member into a local, and the group boxes once.
   *
   * This is a code-size and template-instantiation win, and deliberately not
   * claimed as more: a dynamic read still boxes exactly one value at run time,
   * the same as before. What goes away is the emitted duplication.
   */
  const readGroups = new Map<
    string,
    { readonly type: string; readonly box: string; readonly keys: string[]; readonly branches: string[] }
  >()
  const dataReadKeys: string[] = []
  const defines: string[] = []
  // Keyed the same way `matches`/`deletes` already read one field's statement
  // back below: by the field's own key text. `symbolBranchFor` (above) reads
  // these to run the identical per-field body a matched well-known symbol
  // needs, so a symbol-keyed field's read/write/descriptor/define is decided
  // in exactly the one place a string-keyed field's already is -- never a
  // second, symbol-shaped copy of the same logic that could drift from it.
  const readsByKey = new Map<string, string>()
  const writesByKey = new Map<string, string>()
  const descriptorsByKey = new Map<string, string>()
  const definesByKey = new Map<string, string>()
  // Every reader of a lazy field's storage that OBSERVES its current value
  // (rather than only its presence/attributes, which the empty sentinel
  // answers identically to a real one) must materialize first -- the same
  // requirement `emit-properties.ts`'s static choke point and this file's own
  // `gea_readOwnField`/`gea_ownFieldDescriptor` arms (below, sharing `boxed`)
  // already meet. `access.member` is a bare field name, valid as an lvalue
  // only where `this` is non-const -- every one of these hooks is `const`
  // (`renderableAccessors`'s `selfText`, further below, needs the identical
  // `const_cast` for the same reason). Reading the member back afterward
  // needs no cast: only the write does.
  const materializeText = (plan: LazyArrowFieldPlan, member: string): string =>
    `void(${member}.invoke == nullptr ? void(const_cast<${structName}*>(this)->${member} = ${cppBodyName(plan.initializer)}(gea::Ref<${structName}>::adopt(const_cast<${structName}*>(this), true))) : void(0))`
  for (const { field, access } of accesses) {
    if (access === null) continue
    const literal = cppStringLiteral(access.key)
    // Required is a checker fact, not a claim that the ECMAScript own
    // property can never be removed. Every fixed slot therefore carries the
    // same physical presence bit; construction starts required slots present,
    // while delete can clear either kind when its descriptor permits it.
    const presence = cppRecordFieldPresenceName(field.key)
    // `censusLazyArrowFields` only ever selects a field whose carrier is a
    // plain callable representation (an arrow/function-expression literal),
    // so this is `undefined` for every OTHER access shape below (`boxed`,
    // `dynamicCarrier`, and the generic non-`Function` tag) -- they never
    // consult it.
    const lazyPlan = lazyArrowFields?.get(field.key)
    // A typed NATIVE read (`gea_readOwnFieldNative`, a host-interop path
    // distinct from the ordinary boxed `gea_readOwnField` below) reads
    // `access.member` just as directly, so it gets the same guard.
    const nativeRead =
      lazyPlan !== undefined
        ? `    if (gea_name == ${literal}) { if (!${presence}) return false; ${materializeText(lazyPlan, access.member)}; return gea_out.assign(${access.member}); }`
        : `    if (gea_name == ${literal}) return ${presence} && gea_out.assign(${access.member});`
    if (
      fieldOperations === undefined ||
      fieldOperations.get(field.key)?.has('read') ||
      fieldOperations.get(field.key)?.has('native-read')
    ) {
      nativeReads.push(nativeRead)
      nativeReadsByKey.set(field.key, nativeRead)
    }
    const attributes = cppRecordFieldAttributesName(field.key)
    if (
      fieldOperations === undefined ||
      fieldOperations.get(field.key)?.has('write') ||
      fieldOperations.get(field.key)?.has('native-write')
    ) {
      const nativeWrite =
        `    if (gea_name == ${literal}) { if (${presence} ? !${attributes}.writable : !gea_extensible) return false; ` +
        `if (!gea_value.assign${nativeFieldPolicyTemplate(field.value)}(${access.member})) return false; if (!${presence}) ${attributes} = gea::NativeIndexAttributes{}; ${presence} = true; return true; }`
      nativeFieldWrites.push(nativeWrite)
      nativeFieldWritesByKey.set(field.key, nativeWrite)
    }
    const descriptorAttributeText = (): string =>
      `    if (gea_name == ${literal}) { if (!${presence}) return false; ` +
      `gea_descriptor_writable = ${attributes}.writable; gea_descriptor_enumerable = ${attributes}.enumerable; ` +
      `gea_descriptor_configurable = ${attributes}.configurable; gea_descriptor_own = true; }`
    const descriptorText = (value: string): string =>
      `    if (gea_name == ${literal}) { if (!${presence}) return false; ` +
      `gea_out = gea::PropertyDescriptor::assignment(${value}); gea_out.writable = ${attributes}.writable; ` +
      `gea_out.enumerable = ${attributes}.enumerable; gea_out.configurable = ${attributes}.configurable; return true; }`
    const defineText = (value: string, accepts: string, write: string): string =>
      `    if (gea_name == ${literal}) { const bool gea_exists = ${presence}; gea::PropertyDescriptor gea_current; ` +
      `if (gea_exists) { gea_current = gea::PropertyDescriptor::assignment(${value}); gea_current.writable = ${attributes}.writable; ` +
      `gea_current.enumerable = ${attributes}.enumerable; gea_current.configurable = ${attributes}.configurable; } ` +
      `gea::PropertyDescriptor gea_applied; if (!gea::applyNativeIndexDataDescriptor(gea_exists, gea_extensible, gea_current, gea_descriptor, gea_applied)) return false; ` +
      `if (!(${accepts.replaceAll('gea_value', 'gea_applied.value')})) return false; ${write}; ` +
      `${attributes} = gea::NativeIndexAttributes{gea_applied.writable, gea_applied.enumerable, gea_applied.configurable}; ${presence} = true; return true; }`
    const record = (into: string[], byKey: Map<string, string>, statement: string): void => {
      const operation =
        byKey === readsByKey ? 'read' : byKey === writesByKey ? 'write' : byKey === descriptorsByKey ? 'descriptor' : 'define'
      if (fieldOperations !== undefined && !fieldOperations.get(field.key)?.has(operation)) return
      into.push(statement)
      byKey.set(field.key, statement)
      // `descriptorsByKey` keeps the per-field body regardless: the symbol
      // branch inlines it BY KEY, and a well-known symbol field has no name to
      // match in a text chain. What composition replaces is the text chain, and
      // it mirrors that chain exactly -- symbol-keyed fields included, because
      // `symbolBranchFor` returns nothing when the layout has an open symbol
      // index, and a symbol key then falls through to the text compare like any
      // other. Dropping them here would answer differently in exactly that case.
      if (byKey === descriptorsByKey) descriptorAttributes.push(descriptorAttributeText())
      // Index-aligned with the data-field half of `reads`, so the emitted chain
      // can drop exactly the fields a group already answers for.
      if (byKey === readsByKey) dataReadKeys.push(field.key)
    }
    if (!access.readable) {
      record(reads, readsByKey, `    if (gea_name == ${literal}) ${refuseFieldText(structName, access.key)}`)
      record(writes, writesByKey, `    if (gea_name == ${literal}) ${refuseFieldText(structName, access.key)}`)
      record(defines, definesByKey, `    if (gea_name == ${literal}) ${refuseFieldText(structName, access.key)}`)
      continue
    }
    if (access.dynamicCarrier) {
      const boxed =
        dynamicCarrierBoxText(field.value, access.member) ??
        `gea::detail::readDynamicField(${access.member}, ${cppStringLiteral(structName)}, ${literal})`
      // An optional or union carrier boxes through a CONDITIONAL over its live
      // arms -- one `gea::Value` construction per arm, so a `Texture | null |
      // undefined` field spends three and an optional `number` spends two.
      // `dynamicCarrierBoxText` is a pure function of the representation and
      // the text naming the storage, so asking it about a SLOT rather than a
      // member yields the identical conditional for every field that spells
      // the same carrier: the key chain selects the storage into the slot and
      // the arms are rendered once. The fallback route is deliberately not
      // grouped -- `readDynamicField` names the struct and the field key, so
      // its text is not a function of the storage alone.
      const groupedBox = dynamicCarrierBoxText(field.value, '(*gea_slot)')
      if (groupedBox !== null && (fieldOperations === undefined || fieldOperations.get(field.key)?.has('read'))) {
        const groupKey = `carrier|${representationKey(field.value)}`
        const group = readGroups.get(groupKey) ?? { type: access.type, box: groupedBox, keys: [], branches: [] }
        group.keys.push(field.key)
        group.branches.push(`      if (gea_name == ${literal}) { if (!${presence}) return false; gea_slot = ${access.member}; }`)
        readGroups.set(groupKey, group)
      }
      record(reads, readsByKey, `    if (gea_name == ${literal}) { if (!${presence}) return false; gea_out = ${boxed}; return true; }`)
      record(
        writes,
        writesByKey,
        `    if (gea_name == ${literal}) { if (${presence} ? !${attributes}.writable : !gea_extensible) return false; ` +
          `gea::detail::writeDynamicField(${access.member}, gea_value, ${cppStringLiteral(structName)}, ${literal}); if (!${presence}) ${attributes} = gea::NativeIndexAttributes{}; ${presence} = true; return true; }`
      )
      record(descriptors, descriptorsByKey, descriptorText(boxed))
      const absencePolicy = dynamicFieldAbsencePolicy(field.value)
      record(
        defines,
        definesByKey,
        absencePolicy === null
          ? defineText(
              boxed,
              `gea::detail::dynamicFieldAccepts<${access.type}>(gea_value)`,
              `gea::detail::writeDynamicField(${access.member}, gea_applied.value, ${cppStringLiteral(structName)}, ${literal})`
            )
          : `    if (gea_name == ${literal}) return gea::detail::applyNativeDynamicFieldDescriptor(` +
              `${access.member}, ${attributes}, ${presence}, gea_descriptor, gea_extensible, ${absencePolicy.allowsUndefined}, ${absencePolicy.allowsNull}, ${cppStringLiteral(structName)}, ${literal});`
      )
      continue
    }
    if (access.boxed) {
      record(
        reads,
        readsByKey,
        `    if (gea_name == ${literal}) { if (!${presence}) return false; gea_out = ${access.member}; return true; }`
      )
      record(
        writes,
        writesByKey,
        `    if (gea_name == ${literal}) { if (${presence} ? !${attributes}.writable : !gea_extensible) return false; ${access.member} = gea_value; if (!${presence}) ${attributes} = gea::NativeIndexAttributes{}; ${presence} = true; return true; }`
      )
      record(descriptors, descriptorsByKey, descriptorText(access.member))
      record(defines, definesByKey, defineText(access.member, 'true', `${access.member} = gea_applied.value`))
      continue
    }
    // This dispatcher is the SAME `gea_readOwnField` the design's "dynamic
    // (`any`) read" requirement names, reached independently of
    // `emit-properties.ts`'s own choke point (a plain `c.json` never lowers
    // to a dynamic operation at all). Materializing here, before `boxedText`
    // reads the member, is what makes a lazy field safe to expose through the
    // SAME dynamic protocol every other field already answers through -- see
    // `selfText` below, this file's own precedent for recovering a retained
    // `this` handle inside one of these `const` dispatch methods.
    const boxed =
      access.tag === 'Function'
        ? lazyPlan !== undefined
          ? `(${materializeText(lazyPlan, access.member)}, ${boxedText(field.value, access.tag, access.member)})`
          : boxedText(field.value, access.tag, access.member)
        : `gea::Value::box(gea::Value::Tag::${access.tag}, static_cast<${access.type}>(${access.member}))`
    // A `Function` tag boxes through `boxedText`, whose recipe is not a tag and
    // a cast but a choice among three `gea::Value` constructors made from the
    // field's own REPRESENTATION -- a method thunk, a rest-aware callable, or
    // the plain box. So a callable field groups by that representation rather
    // than by the `(tag, type)` pair, and the group states the chosen recipe
    // once over its own slot. Two fields spelling the same representation
    // spell the same recipe by construction: `boxedText` reads nothing else.
    // A lazy field never joins the group: the shared box function takes only a
    // slot pointer, with no room for the per-field initializer call the
    // materialize step above needs, so it keeps its own individual arm instead.
    if (lazyPlan === undefined && (fieldOperations === undefined || fieldOperations.get(field.key)?.has('read'))) {
      const callable = access.tag === 'Function'
      const slotType = callable ? cppTypeOf(field.value) : access.type
      const groupKey = callable ? `Function|${representationKey(field.value)}` : `${access.tag}|${access.type}`
      const group = readGroups.get(groupKey) ?? {
        type: slotType,
        box: callable ? boxedText(field.value, access.tag, '*gea_slot') : `gea::Value::box(gea::Value::Tag::${access.tag}, *gea_slot)`,
        keys: [],
        branches: []
      }
      group.keys.push(field.key)
      group.branches.push(
        `      if (gea_name == ${literal}) { if (!${presence}) return false; gea_slot = static_cast<${slotType}>(${access.member}); }`
      )
      readGroups.set(groupKey, group)
    }
    record(reads, readsByKey, `    if (gea_name == ${literal}) { if (!${presence}) return false; gea_out = ${boxed}; return true; }`)
    record(descriptors, descriptorsByKey, descriptorText(boxed))
    if (access.writable) {
      record(
        writes,
        writesByKey,
        `    if (gea_name == ${literal}) { if (${presence} ? !${attributes}.writable : !gea_extensible) return false; ` +
          `${access.member} = gea::detail::unboxField<${access.type}>(gea_value, gea::Value::Tag::${access.tag}, ${cppStringLiteral(structName)}, ${literal}); if (!${presence}) ${attributes} = gea::NativeIndexAttributes{}; ${presence} = true; return true; }`
      )
      // `applyNativeFieldDescriptor` reads the CURRENT value through this
      // same `access.member` reference when the field is present,
      // non-configurable and non-writable (a SameValue check against the
      // incoming descriptor's value) -- an un-materialized lazy field would
      // hand it the empty sentinel there instead of the real callable, so it
      // materializes first, unconditionally, the same as every other reader
      // in this file that observes rather than replaces the current value.
      record(
        defines,
        definesByKey,
        lazyPlan !== undefined
          ? `    if (gea_name == ${literal}) { ${materializeText(lazyPlan, access.member)}; return gea::applyNativeFieldDescriptor(` +
            `${access.member}, ${attributes}, ${presence}, gea_descriptor, gea_extensible, gea::Value::Tag::${access.tag}); }`
          : `    if (gea_name == ${literal}) return gea::applyNativeFieldDescriptor(` +
            `${access.member}, ${attributes}, ${presence}, gea_descriptor, gea_extensible, gea::Value::Tag::${access.tag});`
      )
    } else {
      record(writes, writesByKey, `    if (gea_name == ${literal}) ${refuseFieldText(structName, access.key)}`)
      record(defines, definesByKey, `    if (gea_name == ${literal}) ${refuseFieldText(structName, access.key)}`)
    }
  }

  // An accessor is an own property with NO storage, so the boxed protocol has
  // to call its body where a field's arm reads a member. The body called is the
  // same free function `emit-properties.ts` calls for a native read -- one
  // authority for "what answers this member", reached from the two places that
  // can ask it. Its receiver is rebuilt from `this`: these hooks are only ever
  // reached through a `gea::Value` whose payload IS this object, and
  // `Ref::adopt(pointer, true)` takes the retained handle the body's parameter
  // is declared with.
  //
  // Before this, the dispatcher knew only `layout.fields`, so a boxed read of
  // `{ get g() { ... } }` found no arm, fell through to `return false`, and the
  // box answered `undefined` -- a silently wrong answer that also made every
  // `for...of` over a dynamic iterator whose `next` is an accessor loop forever
  // (`test/runtime/dynamic-iterator-header-close.ts`).
  // Everything pushed into `descriptors` from here on is an ACCESSOR's, and an
  // accessor descriptor is a pair of callable halves rather than a stored value
  // -- it has no read-hook answer to compose from and stays exactly as it was.
  const dataDescriptorCount = descriptors.length
  const dataReadCount = reads.length
  const accessors = renderableAccessors(layout)
  const selfText = `gea::Ref<${structName}>::adopt(const_cast<${structName}*>(this), true)`
  for (const accessor of accessors) {
    const literal = cppStringLiteral(accessor.key)
    const presence = cppRecordFieldPresenceName(accessor.key)
    const attributes = cppRecordFieldAttributesName(accessor.key)
    // A capturing accessor's environment travels on the object, so the boxed
    // protocol unpacks it exactly where the native read does -- one helper,
    // both callers, so the two spellings of one call cannot come apart. Read
    // off whichever spelling of the object is in scope: the hooks run as
    // member functions, while a descriptor's `get`/`set` runs inside a lambda
    // that captured the handle and has no `this` at all.
    const environmentOf = (half: 'getter' | 'setter', body: FunctionId | null, holder: string): string =>
      body === null || !accessorCarriesEnvironment(body)
        ? ''
        : `${storedEnvironmentText(body, `${holder}${cppRecordAccessorEnvironmentName(accessor.key, half)}`)}, `
    const getEnvironment = environmentOf('getter', accessor.getter, '')
    const setEnvironment = environmentOf('setter', accessor.setter, '')
    const descriptorGetEnvironment = environmentOf('getter', accessor.getter, 'gea_self->')
    const descriptorSetEnvironment = environmentOf('setter', accessor.setter, 'gea_self->')
    const getText = (receiver: string, environment: string): string | null =>
      accessor.getter === null ? 'gea::Value()' : accessorBoxedText(accessor, `${cppBodyName(accessor.getter)}(${environment}${receiver})`)
    const setText = (receiver: string, written: string, environment: string): string | null => {
      if (accessor.setter === null) return null
      const unboxed = accessorUnboxText(accessor, structName, written)
      return unboxed === null ? null : `${cppBodyName(accessor.setter)}(${environment}${receiver}, ${unboxed})`
    }
    const read = getText(selfText, getEnvironment)
    reads.push(
      read === null
        ? `    if (gea_name == ${literal}) ${refuseFieldText(structName, accessor.key)}`
        : `    if (gea_name == ${literal}) { if (!${presence}) return false; gea_out = ${read}; return true; }`
    )
    // A `[[Set]]` on a getter-only accessor FAILS -- `false` here, never a
    // fallthrough, which would let the box grow an expando that shadows the
    // getter from then on.
    const write = setText(selfText, 'gea_value', setEnvironment)
    writes.push(
      accessor.setter === null
        ? `    if (gea_name == ${literal}) return false;`
        : write === null
          ? `    if (gea_name == ${literal}) ${refuseFieldText(structName, accessor.key)}`
          : `    if (gea_name == ${literal}) { if (!${presence}) return false; ${write}; return true; }`
    )
    const descriptorGet = getText('gea_self', descriptorGetEnvironment)
    const descriptorSet = setText('gea_self', 'gea_written', descriptorSetEnvironment)
    const halves = [
      ...(accessor.getter !== null && descriptorGet !== null
        ? [`gea_out.hasGet = true; gea_out.get = [gea_self = ${selfText}](const gea::Value&) { return ${descriptorGet}; };`]
        : []),
      ...(accessor.setter !== null && descriptorSet !== null
        ? [
            `gea_out.hasSet = true; gea_out.set = [gea_self = ${selfText}](const gea::Value&, const gea::Value& gea_written) { ${descriptorSet}; };`
          ]
        : [])
    ]
    descriptors.push(
      halves.length === 0
        ? `    if (gea_name == ${literal}) ${refuseFieldText(structName, accessor.key)}`
        : `    if (gea_name == ${literal}) { if (!${presence}) return false; gea_out = gea::PropertyDescriptor{}; ${halves.join(' ')} ` +
            `gea_out.hasEnumerable = true; gea_out.enumerable = ${attributes}.enumerable; ` +
            `gea_out.hasConfigurable = true; gea_out.configurable = ${attributes}.configurable; return true; }`
    )
    // Redefining an accessor-backed member would have to replace the BODY that
    // answers it, and a struct has no slot to put another one in. Failing the
    // define is the honest answer -- `Object.defineProperty` throws on it --
    // where returning `false` from `gea_matchesOwnField` instead would let the
    // definition land in the expando table and shadow the accessor silently.
    defines.push(`    if (gea_name == ${literal}) return false;`)
  }

  // Enumeration order is the specification's, not the declaration's, and is a
  // property of the whole key set rather than of any one access.
  // Enumeration does not read a property's value. A field whose carrier has
  // no dynamic box recipe is still an own enumerable key, so filtering this
  // list through `dynamicFieldAccessOf` would make Object.keys lose exactly
  // those fields. Symbol fields are excluded because this hook supplies the
  // string-key list consumed by Object.keys/for-in; their runtime identity is
  // not a string the dispatcher can reconstruct.
  // Accessor keys follow the fields rather than interleaving with them. The two
  // lists come from one `shape.members` walk and each keeps its order, but the
  // split does not record where one sat relative to the other, so a literal
  // mixing `get g()` with `plain` enumerates `plain,g` where the engine says
  // `g,plain`. That is a narrower divergence than the one it replaces -- an
  // accessor used to be absent from `Object.keys` entirely -- and closing it
  // means carrying a member ordinal, not reordering here.
  const ownKeys = [...layout.fields.map((field) => field.key), ...accessors.map((accessor) => accessor.key)]
  const keys = ownKeys.flatMap((key) => {
    if (!cppRecordFieldKeyIsSymbol(key))
      return [`    if (${cppRecordFieldPresenceName(key)}) gea_declared.push_back(gea::PropertyKey::string(${cppStringLiteral(key)}));`]
    const wellKnown = wellKnownSymbolEnumNameOf(wellKnownSymbols, key)
    if (wellKnown === null) return []
    return [
      `    if (${cppRecordFieldPresenceName(key)}) gea_declared.push_back(gea::PropertyKey::symbol(gea::wellKnownSymbol(gea::detail::WellKnownSymbol::${wellKnown})));`
    ]
  })
  const matches = ownKeys.map((key) => `    if (gea_name == ${cppStringLiteral(key)}) return true;`)
  const matchesByKey = new Map(layout.fields.map((field, index) => [field.key, matches[index] as string]))
  const presentFields = ownKeys.map(
    (key) => `    if (gea_name == ${cppStringLiteral(key)}) { gea_out = ${cppRecordFieldPresenceName(key)}; return true; }`
  )
  const enumerableFields = ownKeys.map(
    (key) =>
      `    if (gea_name == ${cppStringLiteral(key)}) { gea_out = ${cppRecordFieldPresenceName(key)} && ${cppRecordFieldAttributesName(key)}.enumerable; return true; }`
  )
  const presentByKey = new Map(layout.fields.map((field, index) => [field.key, presentFields[index] as string]))
  const enumerableByKey = new Map(layout.fields.map((field, index) => [field.key, enumerableFields[index] as string]))
  const deletes = ownKeys.map((key) => {
    const presence = cppRecordFieldPresenceName(key)
    const attributes = cppRecordFieldAttributesName(key)
    return `    if (gea_name == ${cppStringLiteral(key)}) { if (!${presence}) return true; if (!${attributes}.configurable) return false; ${presence} = false; return true; }`
  })
  const deletesByKey = new Map(layout.fields.map((field, index) => [field.key, deletes[index] as string]))
  // The one place `symbolBranchFor` (above) reads a matched field's
  // already-rendered body from, by hook signature -- so the symbol path and
  // the string path share one statement per field per hook, never two.
  const hooksByBodyKey: Readonly<Record<string, ReadonlyMap<string, string>>> = {
    'gea_readOwnFieldNative(gea_key, gea_out)': nativeReadsByKey,
    'gea_writeOwnFieldNative(gea_key, gea_value, gea_extensible)': nativeFieldWritesByKey,
    'gea_readOwnField(gea_key, gea_out)': readsByKey,
    'gea_writeOwnField(gea_key, gea_value, gea_extensible)': writesByKey,
    'gea_ownFieldDescriptor(gea_key, gea_out)': descriptorsByKey,
    'gea_defineOwnField(gea_key, gea_descriptor, gea_extensible)': definesByKey,
    'gea_matchesOwnField(gea_key)': matchesByKey,
    'gea_deleteOwnField(gea_key)': deletesByKey,
    'gea_ownFieldPresent(gea_key, gea_out)': presentByKey,
    'gea_ownFieldEnumerable(gea_key, gea_out)': enumerableByKey
  }
  const hookBodyByKey = (hook: string): ReadonlyMap<string, string> | undefined => hooksByBodyKey[hook]
  const freezeFields = ownKeys.map((key) => {
    const presence = cppRecordFieldPresenceName(key)
    const attributes = cppRecordFieldAttributesName(key)
    return `    if (${presence}) ${attributes} = gea::NativeIndexAttributes{false, ${attributes}.enumerable, false};`
  })
  const sealFields = ownKeys.map((key) => {
    const presence = cppRecordFieldPresenceName(key)
    const attributes = cppRecordFieldAttributesName(key)
    return `    if (${presence}) ${attributes}.configurable = false;`
  })
  const frozenFields = ownKeys.map((key) => {
    const presence = cppRecordFieldPresenceName(key)
    const attributes = cppRecordFieldAttributesName(key)
    return `    if (${presence} && (${attributes}.configurable || ${attributes}.writable)) return false;`
  })
  const sealedFields = ownKeys.map((key) => {
    const presence = cppRecordFieldPresenceName(key)
    const attributes = cppRecordFieldAttributesName(key)
    return `    if (${presence} && ${attributes}.configurable) return false;`
  })

  // A struct with no addressable field of its own never reads `gea_name`, and
  // an unused reference is a warning in every build that enables one.
  const nameOf = (body: readonly string[]): readonly string[] =>
    body.length > 0 ? ['    const std::string& gea_name = gea_key.text();'] : []

  const accessorDescriptors = descriptors.slice(dataDescriptorCount)
  const accessorReads = reads.slice(dataReadCount)
  // A group of ONE is not a group: its block spends a slot declaration and a
  // presence test to save nothing, so the lone field keeps the site it had and
  // only shared carriers are hoisted.
  const emittedReadGroups = [...readGroups.values()].filter((group) => group.branches.length > 1)
  const groupedReadKeys = new Set(emittedReadGroups.flatMap((group) => group.keys))
  // The fields no group answers for: an already-boxed slot, a dynamic carrier,
  // a refused one, and any carrier only one field on this layout spells.
  const ungroupedDataReads = reads.slice(0, dataReadCount).filter((_, index) => !groupedReadKeys.has(dataReadKeys[index] ?? ''))
  const readGroupBlocks = emittedReadGroups.flatMap((group) => [
    '    {',
    `      std::optional<${group.type}> gea_slot;`,
    ...group.branches,
    // `std::optional`'s own emptiness, never a sentinel value: a `bool` field
    // holding `false` and an absent field must not be the same answer.
    `      if (gea_slot) { gea_out = ${group.box}; return true; }`,
    '    }'
  ])
  /**
   * Whether the descriptor hook may compose its VALUE from the read hook.
   *
   * It may exactly when every data field this hook answers for is a field the
   * read hook also answers for, which an unrestricted carrier satisfies by
   * construction: both cover the whole layout. A SEALED per-field demand can
   * name a field for `descriptor` and not for `read`, and composing there would
   * answer `false` for a field that has a descriptor -- so those keep the
   * per-field rendering they already had. That is also where there is nothing
   * to win: the boxes are on the unrestricted carriers.
   */
  const descriptorsComposed = fieldOperations === undefined

  // A dynamic property operation retains the receiver's static `Ref<T>` type,
  // but JavaScript property lookup observes the concrete object. A call through
  // `Ref<Base>` must therefore enter the most-derived field table before that
  // table explicitly walks its bases. Records have no subtype identity and keep
  // these hooks non-virtual, preserving their plain aggregate layout.
  const classMember = (stated: string, body: readonly string[]): readonly string[] => {
    const declaration = withUnreadParametersUnnamed(stated, body)
    const prefix = classDispatch && !leafRoot && (base === undefined || base.native) ? 'virtual ' : ''
    const suffix = classDispatch && base !== undefined && !base.native ? ' override' : ''
    const signature = `  ${prefix}${declaration}${suffix}`
    if (definitions === undefined) return [`${signature} {`, ...body, '  }']
    // The definition's qualified name and omitted default argument are C++
    // placement syntax. Its body is the identical field-table recipe above.
    const returnTypeEnd = declaration.indexOf(' ') + 1
    const qualified = declaration.slice(0, returnTypeEnd) + structName + '::' + declaration.slice(returnTypeEnd)
    definitions.push([`${qualified.split(' = true').join('')} {`, ...body, '}'].join('\n'))
    return [`${signature};`]
  }

  const dynamicMember = (declaration: string, body: readonly string[]): readonly string[] =>
    dynamicProtocol ? classMember(declaration, body) : []

  // A store through an index sidecar is TYPED transport, not reflection:
  // `emit-carrier-members.ts`'s `emitRecordIndexSidecarStore` calls
  // `gea_writeOwnIndexNative` for every `m[k] = v` a record with an index
  // signature receives, and `reflection-demand.ts` correctly counts that store
  // as no reflection demand at all (`nativeRecordIndexTransportOf`). So these
  // members cannot hang off `dynamicProtocol`: a keys-only struct with an
  // index sidecar still has to carry the index write, and the fixed-field
  // routing inside it (`gea_writeOwnFieldNative`, for a key the sidecar's
  // domain shares with a declared field). Gating both behind the protocol is
  // how record-index-sidecar.ts's own `m[2] = 'two'` named a member its struct
  // never declared.
  // `gea_matchesOwnField` is one third of the runtime's native own-field
  // protocol (`nativeOwnFieldProtocolIsWhole`: predicate, definition and
  // deletion are stated together or not at all), and the sidecar's
  // fixed-field routing needs the predicate. So an index sidecar states the
  // whole trio; the definition and deletion bodies are the same demand-gated
  // recipes the dynamic protocol would emit, unreachable until reflection
  // demand turns the protocol on. Stating only the predicate tripped the
  // fail-closed static_assert in native-symbol-property-identity.
  const nativeIndexMember = sidecarNativeWrites.size > 0 ? classMember : dynamicMember
  const nativeWriteMethods = [...sidecarNativeWrites].flatMap(([valueType, writes]) => [
    ...classMember(
      `bool gea_writeOwnIndexNative(const gea::PropertyKey& gea_key, const ${valueType}& gea_value, bool gea_extensible = true)`,
      [...writes, '    return false;']
    )
  ])

  return [
    "  /** This struct's declared fields, as a boxed `gea::Value` reads them. `false` means the struct does not declare the key, which sends it to the box's expando table. */",
    ...classMember('bool gea_ownFieldPresent(const gea::PropertyKey& gea_key, bool& gea_out) const', [
      ...symbolBranchFor('gea_ownFieldPresent(gea_key, gea_out)', true),
      ...nameOf(presentFields),
      ...presentFields,
      ...(base && !base.native ? [`    if (this->${base.structName}::gea_ownFieldPresent(gea_key, gea_out)) return true;`] : []),
      '    return false;'
    ]),
    ...classMember('bool gea_ownFieldEnumerable(const gea::PropertyKey& gea_key, bool& gea_out) const', [
      ...symbolBranchFor('gea_ownFieldEnumerable(gea_key, gea_out)', true),
      ...nameOf(enumerableFields),
      ...enumerableFields,
      ...(base && !base.native ? [`    if (this->${base.structName}::gea_ownFieldEnumerable(gea_key, gea_out)) return true;`] : []),
      '    return false;'
    ]),
    ...classMember('bool gea_ownIndexPresent(const gea::PropertyKey& gea_key, bool& gea_out) const', [
      ...(base && !base.native ? [`    if (this->${base.structName}::gea_ownIndexPresent(gea_key, gea_out)) return true;`] : []),
      ...sidecarPresent,
      '    return false;'
    ]),
    ...classMember('bool gea_ownIndexEnumerable(const gea::PropertyKey& gea_key, bool& gea_out) const', [
      ...(base && !base.native ? [`    if (this->${base.structName}::gea_ownIndexEnumerable(gea_key, gea_out)) return true;`] : []),
      ...sidecarEnumerable,
      '    return false;'
    ]),
    ...dynamicMember('bool gea_readOwnField(const gea::PropertyKey& gea_key, gea::Value& gea_out) const', [
      ...symbolBranchFor('gea_readOwnField(gea_key, gea_out)'),
      ...nameOf(reads),
      ...readGroupBlocks,
      ...ungroupedDataReads,
      ...accessorReads,
      ...baseRead,
      '    return false;'
    ]),
    ...dynamicMember('bool gea_readOwnFieldNative(const gea::PropertyKey& gea_key, gea::NativeFieldRead& gea_out) const', [
      ...symbolBranchFor('gea_readOwnFieldNative(gea_key, gea_out)', true),
      ...nameOf([...nativeReads, ...accessors.map((accessor) => accessor.key)]),
      ...nativeReads,
      // Accessors must run exactly once through the existing getter path.
      // A derived accessor also shadows a base data field of the same name.
      ...accessors.map((accessor) => `    if (gea_name == ${cppStringLiteral(accessor.key)}) return false;`),
      ...(base && !base.native ? [`    return this->${base.structName}::gea_readOwnFieldNative(gea_key, gea_out);`] : ['    return false;'])
    ]),
    ...nativeIndexMember(
      'bool gea_writeOwnFieldNative(const gea::PropertyKey& gea_key, const gea::NativeFieldWrite& gea_value, bool gea_extensible = true)',
      [
        ...symbolBranchFor('gea_writeOwnFieldNative(gea_key, gea_value, gea_extensible)', true),
        ...nameOf([...nativeFieldWrites, ...accessors.map((accessor) => accessor.key)]),
        ...nativeFieldWrites,
        ...accessors.map((accessor) => `    if (gea_name == ${cppStringLiteral(accessor.key)}) return false;`),
        ...(base && !base.native
          ? [`    return this->${base.structName}::gea_writeOwnFieldNative(gea_key, gea_value, gea_extensible);`]
          : ['    return false;'])
      ]
    ),
    '  /** The complete data descriptor for one present fixed field. */',
    ...dynamicMember('bool gea_ownFieldDescriptor(const gea::PropertyKey& gea_key, gea::PropertyDescriptor& gea_out) const', [
      // Descriptor hooks belong to generated bases, just like the text-key chain
      // below. A native base's field reader is not a descriptor hook.
      ...symbolBranchFor('gea_ownFieldDescriptor(gea_key, gea_out)', true),
      ...nameOf(descriptorsComposed ? [...descriptorAttributes, ...accessorDescriptors] : descriptors),
      ...(descriptorsComposed
        ? [
            ...(descriptorAttributes.length === 0
              ? []
              : [
                  '    bool gea_descriptor_own = false;',
                  '    bool gea_descriptor_writable = false;',
                  '    bool gea_descriptor_enumerable = false;',
                  '    bool gea_descriptor_configurable = false;'
                ]),
            ...descriptorAttributes,
            ...(descriptorAttributes.length === 0
              ? []
              : [
                  '    if (gea_descriptor_own) {',
                  '      gea::Value gea_descriptor_value;',
                  '      if (!this->gea_readOwnField(gea_key, gea_descriptor_value)) return false;',
                  '      gea_out = gea::PropertyDescriptor::assignment(gea_descriptor_value);',
                  '      gea_out.writable = gea_descriptor_writable; gea_out.enumerable = gea_descriptor_enumerable;',
                  '      gea_out.configurable = gea_descriptor_configurable;',
                  '      return true;',
                  '    }'
                ]),
            ...accessorDescriptors
          ]
        : descriptors),
      ...(base && !base.native ? [`    if (this->${base.structName}::gea_ownFieldDescriptor(gea_key, gea_out)) return true;`] : []),
      '    return false;'
    ]),
    '  /** The same, for a write. A declared field is written IN PLACE, so every native read of it sees the change. */',
    ...dynamicMember('bool gea_writeOwnField(const gea::PropertyKey& gea_key, const gea::Value& gea_value, bool gea_extensible = true)', [
      ...symbolBranchFor('gea_writeOwnField(gea_key, gea_value, gea_extensible)'),
      ...nameOf(writes),
      ...writes,
      ...baseWrite,
      '    return false;'
    ]),
    '  /** ValidateAndApplyPropertyDescriptor for a fixed native data property. */',
    ...nativeIndexMember(
      'bool gea_defineOwnField(const gea::PropertyKey& gea_key, const gea::PropertyDescriptor& gea_descriptor, bool gea_extensible = true)',
      [
        ...symbolBranchFor('gea_defineOwnField(gea_key, gea_descriptor, gea_extensible)', true),
        ...nameOf(defines),
        ...defines,
        ...(base && !base.native
          ? [
              `    if (this->${base.structName}::gea_matchesOwnField(gea_key)) ` +
                `return this->${base.structName}::gea_defineOwnField(gea_key, gea_descriptor, gea_extensible);`
            ]
          : []),
        '    return false;'
      ]
    ),
    '  /** A field may be declared by the native layout but currently absent after delete. */',
    ...nativeIndexMember('bool gea_matchesOwnField(const gea::PropertyKey& gea_key) const', [
      ...symbolBranchFor('gea_matchesOwnField(gea_key)', true),
      ...nameOf(matches),
      ...matches,
      ...baseMatches,
      '    return false;'
    ]),
    '  /** OrdinaryDelete for one declared data property; false preserves a non-configurable field. */',
    ...nativeIndexMember('bool gea_deleteOwnField(const gea::PropertyKey& gea_key)', [
      ...symbolBranchFor('gea_deleteOwnField(gea_key)', true),
      ...nameOf(deletes),
      ...deletes,
      ...baseDelete,
      '    return false;'
    ]),
    "  /** SetIntegrityLevel(frozen) changes descriptors, never the fixed fields' native carriers. */",
    ...classMember('void gea_freezeOwnFields()', [...baseFreezeFields, ...freezeFields]),
    '  /** SetIntegrityLevel(sealed) retains writability while making present fields non-configurable. */',
    ...classMember('void gea_sealOwnFields()', [...baseSealFields, ...sealFields]),
    '  /** TestIntegrityLevel(frozen) over present fixed data properties. */',
    ...classMember('bool gea_ownFieldsFrozen() const', [...baseFrozenFields, ...frozenFields, '    return true;']),
    '  /** TestIntegrityLevel(sealed) over present fixed data properties. */',
    ...classMember('bool gea_ownFieldsSealed() const', [...baseSealedFields, ...sealedFields, '    return true;']),
    "  /** A present entry of this record's index-signature sidecar. It is deliberately separate from fixed C++ fields: the former is configurable, the latter is not. */",
    ...dynamicMember('bool gea_readOwnIndex(const gea::PropertyKey& gea_key, gea::Value& gea_out) const', [
      ...baseIndexRead,
      ...sidecarRead,
      '    return false;'
    ]),
    '  /** Whether a key belongs to this typed index domain, even when no entry is present. */',
    ...dynamicMember('bool gea_matchesOwnIndex(const gea::PropertyKey& gea_key) const', [
      ...baseIndexMatches,
      ...sidecarMatches,
      '    return false;'
    ]),
    '  /** Store one index-signature entry without making it masquerade as a fixed field. */',
    ...dynamicMember('bool gea_writeOwnIndex(const gea::PropertyKey& gea_key, const gea::Value& gea_value, bool gea_extensible = true)', [
      ...baseIndexWrite,
      ...sidecarWrite,
      '    return false;'
    ]),
    '  /** Complete descriptor reflection for one present typed index entry. */',
    ...dynamicMember('bool gea_ownIndexDescriptor(const gea::PropertyKey& gea_key, gea::PropertyDescriptor& gea_out) const', [
      ...baseIndexDescriptor,
      ...sidecarDescriptor,
      '    return false;'
    ]),
    '  /** Data-descriptor-only ValidateAndApplyPropertyDescriptor for the typed index store. */',
    ...dynamicMember(
      'bool gea_defineOwnIndex(const gea::PropertyKey& gea_key, const gea::PropertyDescriptor& gea_descriptor, bool gea_extensible)',
      [...baseIndexDefine, ...sidecarDefine, '    return false;']
    ),
    '  /** Typed indexed assignment keeps its value native while honoring the same descriptor bits. */',
    ...nativeWriteMethods,
    '  /** Delete an index-signature entry. Fixed fields intentionally never reach this hook. */',
    ...dynamicMember('bool gea_deleteOwnIndex(const gea::PropertyKey& gea_key)', [
      ...baseIndexDelete,
      ...sidecarDelete,
      '    return false;'
    ]),
    '  /** Freeze the sidecar entries without changing their native value carrier. */',
    ...classMember('void gea_freezeOwnIndex()', [...baseIndexFreeze, ...sidecarFreeze]),
    '  /** Seal keeps typed index values writable while making their present entries non-configurable. */',
    ...classMember('void gea_sealOwnIndex()', [
      ...(base && !base.native ? [`    this->${base.structName}::gea_sealOwnIndex();`] : []),
      ...sidecarSeal
    ]),
    '  /** TestIntegrityLevel(frozen) over present typed index entries. */',
    ...classMember('bool gea_ownIndexFrozen() const', [
      ...(base && !base.native ? [`    if (!this->${base.structName}::gea_ownIndexFrozen()) return false;`] : []),
      ...sidecarFrozen,
      '    return true;'
    ]),
    '  /** TestIntegrityLevel(sealed) over present typed index entries. */',
    ...classMember('bool gea_ownIndexSealed() const', [
      ...(base && !base.native ? [`    if (!this->${base.structName}::gea_ownIndexSealed()) return false;`] : []),
      ...sidecarSealed,
      '    return true;'
    ]),
    '  /** The full string-and-symbol own-key list for this native struct. String-only consumers filter symbols; reflective consumers retain them. */',
    ...classMember('void gea_ownFieldKeys(std::vector<gea::PropertyKey>& gea_out) const', [
      '    std::vector<gea::PropertyKey> gea_declared;',
      ...baseKeys,
      ...keys,
      ...sidecarKeys,
      '    std::vector<gea::PropertyKey> gea_indices;',
      '    std::vector<gea::PropertyKey> gea_strings;',
      '    std::vector<gea::PropertyKey> gea_symbols;',
      '    for (const auto& gea_key : gea_declared) {',
      '      if (gea_key.isSymbol()) gea_symbols.push_back(gea_key);',
      '      else if (gea::DynamicObject::arrayIndexOf(gea_key.text()) != gea::DynamicObject::kNotAnArrayIndex) gea_indices.push_back(gea_key);',
      '      else gea_strings.push_back(gea_key);',
      '    }',
      '    std::stable_sort(gea_indices.begin(), gea_indices.end(), [](const gea::PropertyKey& gea_left, const gea::PropertyKey& gea_right) {',
      '      return gea::DynamicObject::arrayIndexOf(gea_left.text()) < gea::DynamicObject::arrayIndexOf(gea_right.text());',
      '    });',
      '    gea_out.insert(gea_out.end(), gea_indices.begin(), gea_indices.end());',
      '    gea_out.insert(gea_out.end(), gea_strings.begin(), gea_strings.end());',
      '    gea_out.insert(gea_out.end(), gea_symbols.begin(), gea_symbols.end());'
    ])
  ]
}

/**
 * The C++ storage one field of this struct occupies.
 *
 * Ordinarily that is exactly the carrier's own type. A field the installed
 * plugin marked reactive is instead held in that plugin's cell, wrapping the
 * SAME carrier -- `Signal<double>` for a `double`, never a box. The cell is
 * storage and nothing else: it converts to `const T&` on read and assigns on
 * write, so every read and write this emitter renders keeps the spelling it
 * had, and no value in the program becomes dynamic. That is the whole reason a
 * cell is admissible under the no-boxing rule where a `gea::Value` would not
 * be.
 *
 * Only three carriers are celled, and the restriction is the cell's own
 * requirements rather than a policy: it default-constructs its value, copy-
 * assigns it, and compares it with `==` to skip a no-op write. A number, a
 * boolean and a string all satisfy that. An array, a record, a handle or a
 * class reference may not -- a `std::shared_ptr` compares by identity, so a
 * mutation through it would compare EQUAL to itself and notify nobody, which
 * is a silent failure to re-render rather than a loud one. Those fields stay
 * plain members here; a template that reads one is refused by name at the JSX
 * site (`emit-jsx.ts`) rather than being wired to a cell that cannot tell it
 * changed.
 */
export const representationCanCell = (representation: Representation): boolean =>
  representation.kind === 'scalar' || representation.kind === 'string'

/**
 * The companion revision cell a reactive field gets when its own carrier
 * cannot be a cell.
 *
 * `count = 0` becomes `Signal<double> count` and every write notifies through
 * the cell itself. `cells = [...]` cannot: the cell compares with `==` to skip
 * unchanged writes, and a `shared_ptr` to a vector compares equal to itself
 * after the vector is mutated, so it would notify nobody. v1 hit this and
 * answered it by leaving the vector a plain member and declaring a companion
 * `<field>__rev` Signal beside it that mutations tick
 * (`cpp-reactive-component.ts`'s `arrayRevFieldName`); this is that answer,
 * emitted rather than spliced into generated text.
 *
 * `cppRecordFieldName` throws for any source key in the `gea_` prefix, and a
 * TypeScript identifier cannot contain `__rev` as a suffix without being a
 * different key -- but a program CAN declare both `cells` and `cells__rev`, so
 * the two would collide. That is a real, narrow collision and it is left
 * visible rather than papered over with a mangled name nothing else can spell:
 * the emitter names this member from this one function, so a future guard has
 * exactly one place to check.
 */
export const cppReactiveRevisionFieldName = (key: string): string => `${cppRecordFieldName(key)}__rev`

/**
 * The C++ type one member is declared with -- the ONE spelling of a field's
 * storage, which is why the integer census reaches the struct through here.
 *
 * `narrowed` is the whole-program answer from `ir/integer-storage.ts`: a
 * `number` member every write proves integral and bounded is declared
 * `long long`, exactly as the hand-written baselines declare theirs. The
 * member's REPRESENTATION is untouched -- it stays `scalar('number')`, so
 * nothing outside this file's own readers sees a carrier that disagrees with
 * the plan -- and every other spelling of the same member (`dynamicFieldAccessOf`
 * below) is passed this answer rather than re-deriving one.
 */
const fieldStorageType = (field: RecordField, reactive: ReactiveCellPlan, celled: ReadonlySet<string>, narrowed: boolean): string => {
  const inner = narrowed ? cppNarrowedIntegerType : cppTypeOf(field.value)
  if (reactive.cell === null || !celled.has(field.key)) return inner
  if (!representationCanCell(field.value)) return inner
  return `${reactive.cell}<${inner}>`
}

/**
 * Which of a struct's fields this compilation holds in a cell, by struct name.
 *
 * The plugin states the answer per CLASS DECLARATION, and this renderer works
 * in struct names, so the two are joined here -- once, against the same
 * `cppClassName` that `classBaseLinks` uses, so a struct and its base link can
 * never disagree about which name a declaration has.
 *
 * Own fields only, and that is the correct scope rather than a limitation: a
 * derived struct really does inherit its base's members (`ClassBaseLink`
 * subtracts them), so a base's reactive field has its storage -- and therefore
 * its cell -- declared once, in the base's own struct, which is where the
 * plugin recorded it.
 */
const reactiveFieldsByStruct = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactive: ReactiveCellPlan,
  fieldsByStruct: ReadonlyMap<string, RecordLayout>,
  bound: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byStruct = new Map<string, ReadonlySet<string>>()
  if (reactive.cell === null) return byStruct
  for (const layout of classes.values()) {
    const owned = reactive.fields.get(layout.declaration)
    if (!owned || owned.size === 0) continue
    const structName = cppClassName(layout.declaration)
    byStruct.set(structName, owned)
    // The ELEMENTS of a reactive array are reactive too.
    //
    // `cells = [{ left, top, color, filled }]` is one reactive field, but what
    // a program writes is `cell.filled = 1` -- through a reference to one
    // element, never through the array. Celling the array itself cannot see
    // that write (a `shared_ptr` compares equal to itself after its pointee
    // changes), and rebuilding the whole list on it is both wasteful and the
    // wrong granularity: one cell changed, one row's props should change.
    //
    // Celling the ELEMENT's own fields makes the write notify exactly the
    // props that read it, through the same `Signal<T>` storage every reactive
    // scalar already uses -- so `cell.filled = 1` needs no notify emitted
    // beside it at all, and the row is never rebuilt.
    for (const field of fieldsByStruct.get(structName)?.fields ?? []) {
      if (!owned.has(field.key) || field.value.kind !== 'array-object') continue
      const element = field.value.element
      if (element.kind !== 'record' && element.kind !== 'native-record-ref') continue
      //
      // Only the members a JSX slot actually BINDS, never every cellable one.
      // `Signal<T>` is not the field's declared carrier, so celling a member
      // nothing renders can stop the struct compiling for its other readers:
      // `gea-bench` holds `rows` (rendered) beside `items` (parsed out of
      // JSON), and celling `Item.id` made `gea_json_read(reader, out.id)` an
      // error. `reactiveBoundRecordFields` answers which members are bound.
      const elementStruct = cppRecordStructName(element.shapeId)
      const renders = bound.get(elementStruct)
      if (renders === undefined) continue
      const cellable =
        fieldsByStruct.get(elementStruct)?.fields.filter((member) => renders.has(member.key) && representationCanCell(member.value)) ?? []
      if (cellable.length > 0) byStruct.set(elementStruct, new Set(cellable.map((member) => member.key)))
    }
  }
  return byStruct
}

const renderStructDefinition = (
  structName: string,
  layout: RecordLayout,
  base: ClassBaseLink | undefined,
  reactive: ReactiveCellPlan,
  celled: ReadonlySet<string>,
  /** The members `ir/integer-storage.ts` proved may be held in a `long long`, by slot. */
  narrowedSlots: ReadonlySet<string>,
  /** Dispatch members for the keys this class's family overrides -- see `virtual-methods.ts`. */
  virtualMembers: readonly string[],
  /** Whether this struct is a class whose dynamic property table must dispatch through its concrete runtime type. */
  classDispatch: boolean,
  /** Whether a descendant introduces virtual dispatch, requiring this base to own the hierarchy's primary vptr so every `Ref` upcast preserves the allocation address. */
  stabilizeRefAddress: boolean,
  /**
   * Whether nothing in this unit derives from the struct.
   *
   * Stated in the C++ because `gea::Ref<T>::release` reads it: a handle to a
   * FINAL type is already the exact type, so it destroys and frees directly
   * instead of through the operations table two indirect calls away. Nothing
   * else consults it -- `final` is a fact about the hierarchy this renderer
   * already knows, written down where the runtime can act on it.
   */
  isFinal: boolean,
  /** The frontend's declaration-identity census of `SymbolConstructor`'s own members -- see `wellKnownSymbolEnumNameOf`. */
  wellKnownSymbols: ReadonlyMap<DeclarationId, string>,
  definitions?: string[],
  dynamicProtocol = true,
  fieldOperations: ReflectionFieldOperations | undefined = undefined,
  accessorCarriesEnvironment: (body: FunctionId) => boolean = () => false,
  /**
   * Whether presence bits and attribute triples are program-wide constants
   * (`program-facts.ts`'s `fixedFieldStateConstant`: nothing freezes, seals,
   * redefines or deletes a declared field). They are then `static` members --
   * the same names every reader and writer already spells, stated once per
   * struct instead of carried by every instance. An OPTIONAL field's presence
   * is still per instance: it starts absent and each instance's first store
   * makes it present.
   */
  fixedFieldStateConstant = false,
  /**
   * Whether the class's method state is one object for the whole program
   * (`ir/class-evaluation.ts`: the class is evaluated once, and it is a root
   * nothing derives from, so no other class's instances share the member).
   * The handle is then a `static` member the construct function fills in,
   * not eight bytes of every instance.
   */
  staticMethodState = false,
  /** This class's own lazily-materialized arrow fields, by key -- see `renderFieldDispatcher`'s parameter of the same name. */
  lazyArrowFields: ReadonlyMap<string, LazyArrowFieldPlan> | undefined = undefined
): string => {
  const isNarrowed = (field: RecordField): boolean => narrowedSlots.has(integerStorageSlot(structName, field.key))
  const lines = [`struct ${structName}${isFinal ? ' final' : ''}${base ? ` : ${base.structName}` : ''} {`]
  const ownsMethodState = classDispatch && (!base || base.native)
  if (ownsMethodState) lines.push(`  ${staticMethodState ? 'static inline ' : ''}gea::Ref<gea::NativeClassMethodState> gea_method_state;`)
  if (stabilizeRefAddress && virtualMembers.length === 0 && !classDispatch) {
    // A derived class that is the first polymorphic class in a hierarchy may
    // place its vptr before a non-polymorphic base subobject. That moves the
    // base away from the allocation address and breaks `gea::Ref`'s one-pointer
    // header lookup on an ordinary derived-to-base conversion. Give every
    // ancestor of an emitted virtual family one harmless virtual member, so
    // the hierarchy has a primary vptr from its root and every single base
    // subobject remains at offset zero under the target C++ ABI.
    lines.push('  virtual void gea_ref_address_anchor() {}')
  }
  // NO `gea_ref_standalone` marker. `final && !base` is NOT the condition that
  // licenses it, and asserting it here was a silent miscompile.
  //
  // `refStandalone`'s contract is that EVERY `gea::Ref` naming the object names
  // its exact allocated type -- and `gea::Value::box` breaks it for any record,
  // because a box holds its payload as a `Ref<void>` (`held_`, gea_runtime.h).
  // The two are incompatible in the block's ADDRESSING, not merely in its
  // destruction: `refCountsOf` subtracts `refStride<T>`, which is 8 for a
  // standalone type and 16 for `void`, so an erased handle reads and writes the
  // refcount 8 bytes outside the block, and `release` then calls through an
  // operations pointer the block never had. Measured: a two-field record passed
  // to an `any` parameter certified clean, emitted, compiled under clang, and
  // segfaulted with PC=0. `for...in` was NOT required to trigger it -- boxing
  // alone was, so this reached every program that boxes a record.
  //
  // This renderer cannot prove the record is never boxed: whether a shape
  // reaches a `dynamic` carrier is a whole-program conversion fact, and only
  // `isFinal` (pure hierarchy) arrives here. Re-earning the optimization means
  // threading that fact in and marking only shapes no conversion ever boxes;
  // until then the sound answer is not to claim it. `Ref`'s converting
  // constructor and `staticCast` now `static_assert` against erasing a
  // standalone handle, so a future attempt fails to COMPILE rather than to run.
  for (const field of layout.fields) {
    lines.push(`  ${fieldStorageType(field, reactive, celled, isNarrowed(field))} ${cppRecordFieldName(field.key)};`)
    // A reactive field whose own carrier cannot be a cell gets the companion
    // revision cell instead -- see `cppReactiveRevisionFieldName`.
    if (reactive.cell !== null && celled.has(field.key) && !representationCanCell(field.value)) {
      lines.push(`  ${reactive.cell}<double> ${cppReactiveRevisionFieldName(field.key)};`)
    }
  }
  // A capturing accessor's environment. Declared beside the fields because it
  // IS storage -- see `cppRecordAccessorEnvironmentName` -- and type-erased
  // (`gea::PackedEnvironment` is a `void*` plus the handle that owns it), so
  // this struct never has to name, or be ordered after, the environment struct
  // of a body it merely carries state for.
  for (const accessor of layout.accessors) {
    for (const half of ['getter', 'setter'] as const) {
      const body = half === 'getter' ? accessor.getter : accessor.setter
      if (body === null || !accessorCarriesEnvironment(body)) continue
      lines.push(`  gea::PackedEnvironment ${cppRecordAccessorEnvironmentName(accessor.key, half)};`)
    }
  }
  for (const index of layout.indexes) {
    // One dictionary member carries every dynamic-keyed property the named
    // fields above do not, embedded by value so it shares the struct's own
    // ownership instead of needing one of its own. Spelling it by building the
    // identical `dictionary` representation a bare dictionary carrier would be
    // and handing it to `cppTypeOf` (types.ts) -- rather than picking
    // `gea::Dictionary`/`gea::NumericDictionary` here too -- keeps the
    // string-vs-number container choice a fact `cppTypeOf` states once, not a
    // second opinion this renderer could drift from.
    const sidecar: Representation = { kind: 'dictionary', key: index.key, value: index.value, ownership: 'owned' }
    lines.push(`  ${cppTypeOf(sidecar)} ${cppRecordIndexSidecarNameFor(index, layout.indexes)};`)
    const attributeKey = index.key === 'symbol' ? 'gea::Symbol' : 'std::string'
    lines.push(`  gea::NativeIndexAttributeTable<${attributeKey}> ${cppRecordIndexAttributesNameFor(index, layout.indexes)};`)
  }
  // Presence is separate from the value carrier for EVERY fixed field.
  // `value === undefined` is present, and a required TypeScript member starts
  // present, but either physical property can later be deleted while
  // configurable. Bits follow all value/index members so existing aggregate
  // initializers keep their positional field layout.
  const constantPresence = (required: boolean): string => (required && fixedFieldStateConstant ? 'static inline ' : '')
  const constantAttributes = fixedFieldStateConstant ? 'static inline ' : ''
  for (const field of layout.fields) {
    lines.push(`  ${constantPresence(field.required)}bool ${cppRecordFieldPresenceName(field.key)} = ${field.required ? 'true' : 'false'};`)
  }
  for (const field of layout.fields)
    lines.push(`  ${constantAttributes}gea::NativeIndexAttributes ${cppRecordFieldAttributesName(field.key)};`)
  // An accessor stores no VALUE, but it is still an own property, so it needs
  // the two bits every own property has: whether it is currently present (a
  // configurable one can be deleted) and its attributes. Without them a boxed
  // `delete o.g` would have to answer by lying in one direction or the other.
  for (const accessor of renderableAccessors(layout)) {
    lines.push(`  ${constantPresence(true)}bool ${cppRecordFieldPresenceName(accessor.key)} = true;`)
    lines.push(`  ${constantAttributes}gea::NativeIndexAttributes ${cppRecordFieldAttributesName(accessor.key)};`)
  }
  // Trace the actual stored fields, including inherited storage and the
  // index sidecar. The collector counts ownership edges, never a reflective
  // property read (which could allocate, box, or run a getter).
  // A STATIC method state is not an edge the instance owns -- the collector's
  // trial deletion would subtract one reference per instance from an object
  // only the class holds -- so it is traced by nobody.
  const traceableFields = [
    ...(ownsMethodState && !staticMethodState ? ['true'] : []),
    ...(base ? [`gea::detail::TraceEdges<${base.structName}>::supported`] : []),
    ...layout.fields.map((field) => `gea::detail::TraceEdges<decltype(${cppRecordFieldName(field.key)})>::supported`),
    ...layout.indexes.map((index) => `gea::detail::TraceEdges<decltype(${cppRecordIndexSidecarNameFor(index, layout.indexes)})>::supported`)
  ]
  // `geaTraceRefs`'s only caller is `gea::detail::traceRefs`'s `if constexpr
  // (supported)` -- reachable only when SOME field here traces to a ref, which
  // is a fact about every OTHER declaration in the program that could hold
  // this struct, not about this struct in isolation. A shape with no
  // ref-reaching field (every member a plain scalar/string/bool) makes
  // `supported` a compile-time `false`, so the branch is discarded and this
  // friend is called nowhere except the unevaluated `requires(...)` that
  // detects `supported` in the first place -- which typechecks it without
  // requiring it to be emitted. Clang then reports the whole function as dead
  // (`-Wunused-function` / `-Wunneeded-internal-declaration`) for every class
  // this program happens not to need it for. `[[maybe_unused]]` is the same
  // answer `linkagePrefix` already gives every minted function for the same
  // reason: whether a minted entity has a caller is a program-wide fact this
  // renderer cannot see from one struct, so it never tries to predict it.
  lines.push(`  [[maybe_unused]] friend auto geaTraceRefs(const ${structName}& value, gea::detail::RefVisitor& visitor)`)
  lines.push(`    -> std::bool_constant<${traceableFields.length ? traceableFields.join(' || ') : 'false'}> {`)
  if (base) lines.push(`    gea::detail::traceRefs(static_cast<const ${base.structName}&>(value), visitor);`)
  if (ownsMethodState && !staticMethodState) lines.push('    gea::detail::traceRefs(value.gea_method_state, visitor);')
  for (const field of layout.fields) lines.push(`    gea::detail::traceRefs(value.${cppRecordFieldName(field.key)}, visitor);`)
  for (const index of layout.indexes)
    lines.push(`    gea::detail::traceRefs(value.${cppRecordIndexSidecarNameFor(index, layout.indexes)}, visitor);`)
  lines.push('    return {};')
  lines.push('  }')
  for (const line of renderFieldDispatcher(
    structName,
    layout,
    base,
    classDispatch,
    (field) => fieldStorageType(field, reactive, celled, isNarrowed(field)),
    wellKnownSymbols,
    definitions,
    dynamicProtocol,
    fieldOperations,
    accessorCarriesEnvironment,
    isFinal && base === undefined,
    lazyArrowFields
  ))
    lines.push(line)
  // Declared only; the definitions go out of line, after every body has been
  // forward-declared -- a member cannot forward to a body the file has not
  // named yet.
  for (const line of virtualMembers) lines.push(line)
  lines.push('};')
  return lines.join('\n')
}

/**
 * Every struct definition the selected carriers require, in a deterministic
 * order, plus the ones no layout could be rendered for.
 *
 * A gap here is reported, never thrown. A struct is required by every carrier
 * that names it, so a missing layout is discovered in the middle of assembling
 * a file -- and an exception escaping from there takes down a compilation that
 * has a perfectly good report to give, which is the same objection
 * `renderTranslationUnit` already answers for a refused body.
 */
export const cppRecordDeclarations = (
  plan: SealedRepresentationPlan,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reactive: ReactiveCellPlan,
  /** Which record members a JSX slot binds -- `reactiveBoundRecordFields`. */
  boundRecordFields: ReadonlyMap<string, ReadonlySet<string>>,
  /** Dispatch member declarations by struct name -- `virtualMethodEmission().membersByStruct`. */
  virtualMembersByStruct: ReadonlyMap<string, readonly string[]> = new Map(),
  /** The members that may be declared `long long` -- `integerStorageCensusOf().slots`. */
  narrowedSlots: ReadonlySet<string> = new Set(),
  /**
   * The frontend's declaration-identity census of `SymbolConstructor`'s own
   * members (`host-protocols.ts`'s `wellKnownSymbolDeclarationsOf`) -- what
   * lets a symbol-keyed field's dispatcher tell `Symbol.iterator` and its
   * fourteen siblings, whose runtime identity is fixed at a known low id,
   * apart from a genuinely unique symbol whose id only exists once the
   * program runs. See `wellKnownSymbolEnumNameOf`.
   */
  wellKnownSymbols: ReadonlyMap<DeclarationId, string> = new Map(),
  splitFieldDefinitions = false,
  reflection?: ReflectionExposure,
  representations: readonly Representation[] = [...plan.selected.values()],
  physicalClasses: ReadonlyMap<
    DeclarationId,
    Pick<ClassLayout, 'declaration' | 'base' | 'nativeBase' | 'instance' | 'nativeStorage'>
  > = classes,
  /**
   * Whether an accessor body carries an environment -- `captures.ts`'s
   * admission, asked rather than re-derived, so the member this struct
   * declares and the formal that body takes cannot come apart.
   */
  accessorCarriesEnvironment: (body: FunctionId) => boolean = () => false,
  /** `program-facts.ts`'s `fixedFieldStateConstant` -- see `renderStructDefinition`'s parameter of the same name. */
  fixedFieldStateConstant = false,
  /** `program-facts.ts`'s `singleEvaluationClasses` -- which classes may hold their method state statically. */
  singleEvaluationClasses: ReadonlySet<DeclarationId> = new Set()
): {
  readonly declarations: readonly string[]
  readonly fieldDefinitionsByStruct: ReadonlyMap<string, readonly string[]>
  /**
   * The classes whose struct holds `gea_method_state` as a STATIC member --
   * this renderer's decision, reported so the construct function fills the
   * static in rather than a member the struct does not have.
   */
  readonly staticMethodStateClasses: ReadonlySet<DeclarationId>
  /** Authenticated program-class ancestry; the translation unit owns namespace placement. */
  readonly runtimeClassBases: readonly { readonly derived: string; readonly base: string }[]
  readonly refused: readonly CppRecordRefusal[]
  /**
   * Which reactive fields got the COMPANION revision cell rather than a cell of
   * their own -- this renderer's own decision, reported so the emitter
   * subscribes to the member that actually exists.
   *
   * Reported rather than recomputed because the decision is
   * `representationCanCell` applied to the field's carrier as this layout
   * states it, and a second reader deriving that carrier its own way is exactly
   * the two-authorities shape that produces a member pointer to a member the
   * struct does not have.
   */
  readonly revisionFields: ReadonlyMap<string, ReadonlySet<string>>
  /** Which struct members this renderer actually put in a `Signal<T>`, by struct name. */
  readonly celledFields: ReadonlyMap<string, ReadonlySet<string>>
} => {
  const { links, unlinkable } = classBaseLinks(physicalClasses)
  const { requiredStructs, fieldsByStruct, unlayoutable } = collectRequiredStructs(
    representations,
    deriver,
    links,
    unlinkable,
    classInstanceShapes(physicalClasses),
    new Map(
      [...physicalClasses.values()].flatMap((layout) =>
        layout.nativeStorage === undefined ? [] : [[cppClassName(layout.declaration), layout.nativeStorage.fields]]
      )
    )
  )
  const celledByStruct = reactiveFieldsByStruct(classes, reactive, fieldsByStruct, boundRecordFields)

  // A `native-record-ref` never carries its own layout (model.ts): the shape
  // it names is expanded wherever a `record`/`record-with-index` for that
  // same struct name is reachable in the plan. When none is, emitting the
  // struct anyway would mean emitting an empty body for a type that is not
  // actually empty -- silently wrong C++ that happens to compile. Refusing
  // names the gap.
  //
  // A purely nominal type -- every use going through the `declared` wrapper
  // in derive.ts, never through a standalone `object` shape -- has no
  // `record`/`record-with-index` anywhere in `plan.selected` to find, because
  // nothing independently derives a declared type's own body as its own
  // result (architecture.md: "the layout is resolved from the sealed
  // structural table at emission"). That is exactly why this function takes
  // `types`, not just `plan`: `collectRequiredStructs` hands the deriver built
  // from it to `recordLayoutOfShape`, which re-derives the named shape's body
  // directly and closes the gap for the ordinary case. What lands in `missing`
  // here is the residual the re-derivation itself could not resolve --
  // `unlayoutable` already names which, by shape id and reason (a field or the
  // index sidecar bottoming out at `unresolved`, or the body itself not
  // deriving a record shape at all) -- so emitting the struct anyway would
  // still mean guessing a layout nothing actually computed. Refusing here
  // names that gap instead of rendering an empty or partial body that happens
  // to compile.
  const missing = [...requiredStructs].filter((structName) => !fieldsByStruct.has(structName)).sort()
  if (missing.length > 0) {
    return {
      declarations: [],
      fieldDefinitionsByStruct: new Map(),
      runtimeClassBases: [],
      refused: missing.map((structName) => ({
        structName,
        reason: `no record layout: ${unlayoutable.get(structName) ?? 'named by no reachable shape'}`
      })),
      revisionFields: new Map(),
      celledFields: new Map(),
      staticMethodStateClasses: new Set()
    }
  }

  const structNames = [...requiredStructs].sort()
  const classStructNames = new Set([...physicalClasses.values()].map((layout) => cppClassName(layout.declaration)))
  // Every struct some other struct derives FROM. Its complement is the leaves,
  // and a leaf is spelled `final` so `gea::Ref<T>::release` can skip the
  // operations table. `links` is the one place a base clause is decided, so
  // reading the set off it is what keeps the two from ever disagreeing.
  const baseStructNames = new Set([...links.values()].map((link) => link.structName))

  // C++ may put the vptr ahead of a non-polymorphic base when a descendant is
  // the first class to declare a virtual member. `Ref<Derived> -> Ref<Base>`
  // cannot tolerate that adjustment because both handles find one allocation
  // header by subtracting from the object address. Mark every ancestor of an
  // emitted virtual-dispatch root; `renderStructDefinition` gives ancestors
  // without their own virtual member a vptr anchor.
  const refAddressStableStructs = new Set<string>()
  for (const [root, members] of virtualMembersByStruct) {
    if (members.length === 0) continue
    const walked = new Set<string>()
    for (let link = links.get(root); link !== undefined && !walked.has(link.structName); link = links.get(link.structName)) {
      walked.add(link.structName)
      refAddressStableStructs.add(link.structName)
    }
  }

  // Forward declarations make ordering irrelevant for a struct held through a
  // pointer or reference (`shared_ptr<T>`, `T&` -- any non-`owned` ownership
  // in cppOwnershipWrap, types.ts). They do not make ordering irrelevant for
  // one held by value: `struct A { struct B b; };` still needs B's full
  // definition, not just its forward declaration, before A's. Both of those
  // dependencies -- the base clause and the by-value field -- are what
  // `definitionOrder` walks; `structNames` stays sorted only so the order is
  // deterministic where nothing constrains it.
  const forwardDeclarations = structNames.map((structName) => `struct ${structName};`)
  const valueDependencies = new Map<string, ReadonlySet<string>>()
  for (const [structName, layout] of fieldsByStruct) valueDependencies.set(structName, structValueDependencies(layout))
  const fieldDefinitionsByStruct = new Map<string, readonly string[]>()
  const dynamicProtocolByStruct = new Map<string, boolean>()
  const fieldOperationsByStruct = new Map<string, ReflectionFieldOperations>()
  if (reflection?.complete) {
    for (const [declaration, demand] of reflection.classes)
      if (demand.fieldOperations) fieldOperationsByStruct.set(cppClassName(declaration), demand.fieldOperations)
    for (const [shape, demand] of reflection.records)
      if (demand.fieldOperations) fieldOperationsByStruct.set(cppRecordStructName(shape), demand.fieldOperations)
    for (const [declaration, demand] of reflection.classes) dynamicProtocolByStruct.set(cppClassName(declaration), demand.level === 'full')
    for (const [shape, demand] of reflection.records) dynamicProtocolByStruct.set(cppRecordStructName(shape), demand.level === 'full')
  }
  // A derived class reaches its dynamic protocol through the hooks its base
  // emits, so a base keeps the full protocol whenever any descendant needs it,
  // however little the base itself is used dynamically.
  for (const structName of classStructNames) {
    if (dynamicProtocolByStruct.get(structName) === false) continue
    let base = links.get(structName)
    while (base && !base.native) {
      dynamicProtocolByStruct.set(base.structName, true)
      base = links.get(base.structName)
    }
  }
  // A class holds its method state statically when the program evaluates it
  // once AND it is a root nothing derives from: a derived class's instances
  // store THEIR evaluation's state into the base's member, so a base with a
  // descendant needs the member per instance however many times either is
  // evaluated. `links`/`baseStructNames` are the one authority on both.
  const declarationByStruct = new Map([...physicalClasses.values()].map((layout) => [cppClassName(layout.declaration), layout.declaration]))
  const staticMethodStateClasses = new Set<DeclarationId>()
  const staticMethodStateStructs = new Set<string>()
  for (const [structName, declaration] of declarationByStruct) {
    if (!requiredStructs.has(structName) || baseStructNames.has(structName) || links.has(structName)) continue
    if (!singleEvaluationClasses.has(declaration)) continue
    staticMethodStateClasses.add(declaration)
    staticMethodStateStructs.add(structName)
  }
  const rendered = definitionOrder(structNames, links, valueDependencies).map((structName) => {
    const layout = fieldsByStruct.get(structName)
    // Unreachable given the check above, and stated rather than assumed: an
    // entry that got past `missing` with no layout would render a struct with
    // no body, which compiles and is wrong.
    if (!layout) return { structName, reason: 'has no layout recorded despite passing the missing-struct check' }
    const declaration = declarationByStruct.get(structName)
    const lazyArrowFields = declaration !== undefined ? lazyArrowFieldPlansForClass(classes, declaration) : undefined
    // An accessor arm calls a body function, and a struct is defined long
    // before any body is even forward-declared. So a struct that answers for
    // one puts its whole field dispatcher out of line, where the names it
    // needs already exist -- the identical mechanism `--translation-units
    // per-file` already uses, switched on per struct rather than per file.
    // Class structs are otherwise excluded: their definitions are placed by
    // source file rather than into the program unit, and a class's accessors
    // are answered through `classMemberOf`, not through this layout -- but a
    // lazy arrow field's dynamic-read arm (`renderFieldDispatcher`'s
    // `materializeText`) is the SAME "calls a body from inline struct text"
    // problem an accessor has, for a class this time, and gets the identical
    // answer: this one struct's dispatcher, and only this one, goes out of
    // line too, however `splitFieldDefinitions`/`perFile` would otherwise
    // treat classes.
    const needsOutOfLineFields =
      (renderableAccessors(layout).length > 0 && !classStructNames.has(structName)) ||
      (lazyArrowFields !== undefined && lazyArrowFields.size > 0)
    const definitions = splitFieldDefinitions || needsOutOfLineFields ? [] : undefined
    if (definitions) fieldDefinitionsByStruct.set(structName, definitions)
    return renderStructDefinition(
      structName,
      layout,
      links.get(structName),
      reactive,
      celledByStruct.get(structName) ?? new Set<string>(),
      narrowedSlots,
      virtualMembersByStruct.get(structName) ?? [],
      classStructNames.has(structName),
      refAddressStableStructs.has(structName),
      !baseStructNames.has(structName),
      wellKnownSymbols,
      definitions,
      dynamicProtocolByStruct.get(structName) ?? true,
      fieldOperationsByStruct.get(structName),
      accessorCarriesEnvironment,
      fixedFieldStateConstant,
      staticMethodStateStructs.has(structName),
      lazyArrowFields
    )
  })
  const refused = rendered.filter((entry): entry is CppRecordRefusal => typeof entry !== 'string')
  if (refused.length > 0)
    return {
      declarations: [],
      fieldDefinitionsByStruct: new Map(),
      runtimeClassBases: [],
      refused,
      revisionFields: new Map(),
      celledFields: new Map(),
      staticMethodStateClasses: new Set()
    }

  // `Value` can only project a genuinely dynamic class back to a nominal
  // carrier when the allocation itself states an authenticated ancestry.  The
  // C++ base clause is not enough after a Ref was erased, and RTTI is not an
  // available fallback on embedded targets.  Publish exactly the checker
  // proven, emitted-program links to the runtime table; native bases are
  // intentionally absent because this compiler has no authenticated native
  // ancestry contract for them.
  const runtimeClassBases = definitionOrder(structNames, links, valueDependencies).flatMap((structName) => {
    const link = links.get(structName)
    if (!classStructNames.has(structName) || !link || link.native || !classStructNames.has(link.structName)) return []
    return [{ derived: structName, base: link.structName }]
  })

  // The same predicate `renderStructDefinition` just applied, split and read
  // back per struct for the emitter -- see `revisionFields` on the return type
  // for why it is reported rather than recomputed there. By STRUCT NAME rather
  // than by class declaration because a reactive struct is no longer only a
  // class: an element record of a reactive array is one too, and it has no
  // declaration to be keyed by.
  const revisionFields = new Map<string, ReadonlySet<string>>()
  const celledFields = new Map<string, ReadonlySet<string>>()
  for (const [structName, owned] of celledByStruct) {
    const shape = fieldsByStruct.get(structName)
    if (!shape) continue
    const celled = new Set(
      shape.fields.filter((field) => owned.has(field.key) && representationCanCell(field.value)).map((field) => field.key)
    )
    const revisions = new Set(
      shape.fields.filter((field) => owned.has(field.key) && !representationCanCell(field.value)).map((field) => field.key)
    )
    if (celled.size > 0) celledFields.set(structName, celled)
    if (revisions.size > 0) revisionFields.set(structName, revisions)
  }
  return {
    // The extension structs last: a field of one may name a record struct
    // above, and nothing above names an extension -- the array's own C++ type
    // does not mention it; only the member bodies reading the fields do.
    declarations: [
      ...forwardDeclarations,
      ...rendered.filter((entry): entry is string => typeof entry === 'string'),
      ...arrayExtensionDeclarations(representations)
    ],
    fieldDefinitionsByStruct,
    runtimeClassBases,
    refused: [],
    revisionFields,
    celledFields,
    staticMethodStateClasses
  }
}

/**
 * One struct per distinct extension an `array-object` carrier anywhere in the
 * plan declares (`array-object.extension`): the typed fields an interface
 * adds to the Array it extends, held by the runtime array's own sidecar
 * (`gea::ArrayObject::extensionFields`, gea_runtime.h). Named by the fields'
 * identity (`cppArrayExtensionStructName`), so two interfaces with one field
 * list share one struct; tagged for the runtime's own type check
 * (`gea::arrayExtensionTagOf`) instead of RTTI, which the embedded targets
 * build without; traced like a record's fields so a `Ref` a field holds is
 * reachable to the cycle collector. An optional field carries the same
 * presence bit a record's does (`cppRecordFieldPresenceName`), false until
 * the first store, so a read before any write answers `undefined`.
 */
const arrayExtensionDeclarations = (representations: readonly Representation[]): readonly string[] => {
  const extensions = new Map<string, readonly RecordField[]>()
  for (const representation of representations) {
    for (const nested of walkRepresentation(representation)) {
      if (nested.kind !== 'array-object' || nested.extension === null) continue
      const name = cppArrayExtensionStructName(nested.extension)
      if (!extensions.has(name)) extensions.set(name, nested.extension)
    }
  }
  return [...extensions.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, fields]) =>
      [
        `struct ${name} final : gea::ArrayExtension {`,
        `  ${name}() : gea::ArrayExtension(gea::arrayExtensionTagOf<${name}>()) {}`,
        ...fields.map((field) => `  ${cppTypeOf(field.value)} ${cppRecordFieldName(field.key)}{};`),
        ...fields.filter((field) => !field.required).map((field) => `  bool ${cppRecordFieldPresenceName(field.key)} = false;`),
        '  void traceRefs(gea::detail::RefVisitor& visitor) const override {',
        ...fields.map((field) => `    gea::detail::traceRefs(${cppRecordFieldName(field.key)}, visitor);`),
        '  }',
        '};'
      ].join('\n')
    )
}

/**
 * Real `static` storage for the whole program's `ClassName.KEY = value`
 * sites (`class-layout.ts`'s `censusClassStaticFieldStorage`), as bare
 * translation-unit-scope definitions -- zero-initialized, exactly the way
 * `translation-unit.ts`'s own `globalDefinitions` declares a module-scope
 * cell's storage. A bare definition rather than one with an inline
 * initializer on purpose: the ACTUAL value (`new Vector3(0, 1, 0)`, a
 * `WeakMap`-closed-over reference, ...) is whatever expression the source
 * assignment itself computed, and that expression already runs -- once, at
 * the point the enclosing module body reaches that statement -- through the
 * ordinary `[[Set]]` this storage exists to give a home to. Initializing it a
 * second time here would run that expression twice, or (for one with a
 * side effect, or one that reads another module-scope cell not yet set)
 * run it too EARLY.
 *
 * Emitted after every struct declaration and before any body, mirroring
 * `translation-unit.ts`'s own ordering for `globalDefinitions`: a static
 * whose declared carrier is itself a struct (`Object3D.DEFAULT_UP`'s
 * `Vector3`) needs that struct to already be a complete type.
 *
 * Sorted by name for the same reason every other whole-program list in this
 * file is: byte-identical output from one compile to the next, so a diff
 * between two builds is never just iteration order.
 */
export const classStaticFieldDefinitions = (
  storage: ReadonlyMap<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>
): readonly string[] => classStaticFieldStorageRows(storage).map((row) => `${row.type} ${row.name};`)

/**
 * The same storage as (type, name) pairs, for a layout that has to spell each
 * one twice -- `extern` in a shared header, defined in exactly one unit.
 */
export const classStaticFieldStorageRows = (
  storage: ReadonlyMap<DeclarationId, ReadonlyMap<string, ClassStaticFieldStorage>>
): readonly { readonly type: string; readonly name: string }[] => {
  const rows: ClassStaticFieldStorage[] = []
  for (const perClass of storage.values()) rows.push(...perClass.values())
  return rows
    .filter((entry) => entry.representation.kind !== 'unresolved' && entry.representation.kind !== 'void')
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({ type: cppTypeOf(entry.representation), name: entry.name }))
}
