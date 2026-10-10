import type { DeclarationId, FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, RecordAccessor, RecordField, RecordIndexSidecar, Representation } from '../representation/model.js'
import { walkRepresentation } from '../representation/model.js'
import { classMethodValueArmsOf, methodCopyHeldBy } from './dispatch.js'
import { abiOfCallee } from './callee.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { dynamicFieldAbsencePolicy } from '../representation/field-descriptor-policy.js'
import type { ClassAccessor, ClassField, ClassFieldOwnership, ClassLayout, ClassMethod } from './classes.js'

/**
 * What a receiver's own declared shape says one member holds.
 *
 * These were the printer's (`targets/cpp/records.ts`, `class-layout.ts`),
 * and every field store, field initializer and class member dispatch asked
 * them there. The slot census asks the identical question before the IR is
 * built, so the answer lives here, below both: a census that read a field's
 * carrier one way and a printer that read it another would be two authorities
 * over one storage contract. The printer re-exports these; nothing in it
 * defines a second copy.
 */

export interface RecordLayoutView {
  readonly fields: readonly RecordField[]
  readonly indexes: readonly RecordIndexSidecar[]
}

/** The record layout a shape derives to, or `null` when it carries none. */
export const recordLayoutOfShapeId = (deriver: RepresentationDeriver, shapeId: string): RecordLayoutView | null => {
  const carrier = deriver.layoutOf(shapeId as StructuralTypeId)
  if (carrier.kind === 'record') return { fields: carrier.fields, indexes: [] }
  if (carrier.kind === 'record-with-index') return { fields: carrier.fields, indexes: carrier.indexes }
  return null
}

/** A shape's index sidecars, in declaration order; empty for a shape with none or with no record layout. */
export const recordIndexesOfShape = (deriver: RepresentationDeriver, shapeId: string): readonly RecordIndexSidecar[] =>
  recordLayoutOfShapeId(deriver, shapeId)?.indexes ?? []

/**
 * The questions about a record shape or class that the shape and the class
 * table alone answer. A reader holding no symbol table and no projected ABIs
 * gets exactly these, and nothing it could mistake for an answer to the
 * symbol- or ABI-dependent questions (`recordLayoutPolicyOf`).
 */
export type RecordShapeLayouts = Required<
  Pick<
    RecordLayoutPolicy,
    | 'forShape'
    | 'indexesForShape'
    | 'accessorsForShape'
    | 'plainFieldsForShape'
    | 'classUninstantiable'
    | 'classSubtreeOf'
    | 'classMethodFor'
    | 'classDirectMethodFor'
  >
>

export const recordShapeLayoutsOf = (
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): RecordShapeLayouts => {
  const nativeFields = new Map(
    [...classes.values()].flatMap((layout) =>
      layout.instance?.kind === 'class-ref' && layout.nativeStorage !== undefined
        ? [[layout.instance.shapeId, layout.nativeStorage.fields] as const]
        : []
    )
  )
  const fieldsOf = (shapeId: string): readonly RecordField[] | null => nativeFields.get(shapeId) ?? recordFieldsOfShape(deriver, shapeId)
  return {
    forShape: (shapeId) => fieldsOf(shapeId),
    indexesForShape: (shapeId) => recordIndexesOfShape(deriver, shapeId),
    accessorsForShape: (shapeId) => recordAccessorsOfShape(deriver, shapeId),
    plainFieldsForShape: (shapeId) =>
      recordIndexesOfShape(deriver, shapeId).length === 0 && (recordAccessorsOfShape(deriver, shapeId) ?? []).length === 0
        ? fieldsOf(shapeId)
        : null,
    classUninstantiable: (declaration) => classes.get(declaration)?.uninstantiable === true,
    classSubtreeOf: (declaration) => {
      if (!classes.has(declaration)) return null
      const extendsIt = (candidate: DeclarationId): boolean => {
        const seen = new Set<DeclarationId>()
        for (
          let current: DeclarationId | null = candidate;
          current !== null && !seen.has(current);
          current = classes.get(current)?.base ?? null
        ) {
          if (current === declaration) return true
          seen.add(current)
        }
        return false
      }
      // A class no evaluation reaches, or none can instantiate, is never the
      // class an existing instance was allocated as.
      return [...classes.values()]
        .filter((layout) => layout.layoutOnly !== true && layout.uninstantiable !== true && extendsIt(layout.declaration))
        .map((layout) => ({ declaration: layout.declaration, construct: layout.construct }))
    },
    classMethodFor: (declaration, key) => {
      const member = classMemberOf(classes, declaration, key)
      return member?.kind === 'method' && member.method.callable !== null
    },
    // Whether a direct body call is SOUND, which is a different question from
    // whether the member exists: a key some subclass overrides dispatches
    // through the family's slot, and calling the resolved body outright would
    // run the base's implementation for a derived instance. The scan is over
    // the whole class table because the override may live anywhere below this
    // class, and a family this cannot see is one it must not claim.
    classDirectMethodFor: (declaration, key) => {
      const member = classMemberOf(classes, declaration, key)
      if (member?.kind !== 'method' || member.method.callable === null) return null
      const carrier = member.method.representation
      if (carrier === undefined || !('abi' in carrier) || carrier.abi === null) return null
      const abi = carrier.abi as CallableAbi
      // ToPrimitive calls the method with NO arguments (7.1.1.1 step 5.b.i), so
      // every declared parameter binds to `undefined`; only a parameter whose
      // carrier can hold that is admissible.
      const takesUndefined = (value: Representation): boolean =>
        value.kind === 'undefined' || value.kind === 'dynamic' || (value.kind === 'optional' && value.absence === 'undefined')
      if (abi.restFrom !== null || !abi.parameters.every((parameter) => takesUndefined(parameter.value))) return null
      for (const [candidate, layout] of classes) {
        if (candidate === member.owner) continue
        if (!layout.methods.some((method) => method.key === key)) continue
        const seen = new Set<DeclarationId>()
        for (let base = layout.base; base !== null && !seen.has(base); base = classes.get(base)?.base ?? null) {
          if (base === member.owner) return null
          seen.add(base)
        }
      }
      return { callable: member.method.callable, result: abi.result, absentParameters: abi.parameters.map((parameter) => parameter.value) }
    }
  }
}

/**
 * The one layout policy every reader of record shapes shares: the conversion
 * registry (`targets/cpp/conversions.ts`, through `compiler.ts`) and the
 * printer's own context. Two constructions of this were two chances to
 * answer "what does this shape hold" differently. Both inputs are required:
 * an empty symbol table or an absent ABI projection answered "no such
 * symbol" and "no setter" for members that exist.
 */
export const recordLayoutPolicyOf = (
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  wellKnownSymbols: ReadonlyMap<DeclarationId, string>,
  abiOfCallable: (callable: FunctionId) => CallableAbi | null
): RecordLayoutPolicy => ({
  ...recordShapeLayoutsOf(deriver, classes),
  accessorAbiFor: abiOfCallable,
  wellKnownSymbolOfKey: (key) => {
    for (const [declaration, member] of wellKnownSymbols) if (key === `sym(${declaration})`) return member
    return null
  },
  classMethodAbiFor: (declaration, key) => {
    const member = classMemberOf(classes, declaration, key)
    if (member?.kind !== 'method' || member.method.callable === null) return null
    return abiOfCallable(member.method.callable)
  },
  classMethodValueSourcesFor: (declaration, key, carrier) =>
    nativeClassMethodValueSourcesOf(classes, declaration, key, abiOfCallable, carrier),
  // The getter's published result, taken from the accessor the class layout
  // carries -- NOT from the instance shape. That shape enumerates storage,
  // and an accessor has none, so `record.accessors` is empty for every class
  // body and a shape lookup answers `null` for exactly the members this
  // exists to find.
  classAccessorSetterFor: (declaration, key) => {
    const member = classMemberOf(classes, declaration, key)
    const setter = member?.kind === 'accessor' ? member.accessor.setter : null
    if (setter === null || setter === undefined) return null
    const abi = abiOfCallable(setter)
    return abi !== null && abi.parameters.length === 1 && abi.restFrom === null ? abi.parameters[0]!.value : null
  },
  classAccessorFor: (declaration, key) => {
    const member = classMemberOf(classes, declaration, key)
    if (member?.kind !== 'accessor' || member.accessor.getter === null) return null
    const abi = abiOfCallable(member.accessor.getter)
    if (abi === null) return null
    // A getter takes no argument and yields a value; anything else under
    // this key is not a member a record field can be built from.
    return abi.parameters.length === 0 && abi.restFrom === null && abi.result.kind !== 'void' ? abi.result : null
  }
})

/** A shape's own field list, or `null` when it carries no record layout. */
export const recordFieldsOfShape = (deriver: RepresentationDeriver, shapeId: string): readonly RecordField[] | null =>
  recordLayoutOfShapeId(deriver, shapeId)?.fields ?? null

/**
 * A shape's own accessor list, or `null` when it carries no record layout (or
 * derives to a `dictionary`/`record-with-index` carrier, neither of which
 * preserves accessors).
 */
export const recordAccessorsOfShape = (deriver: RepresentationDeriver, shapeId: string): readonly RecordAccessor[] | null => {
  const carrier = deriver.layoutOf(shapeId as StructuralTypeId)
  return carrier.kind === 'record' ? carrier.accessors : null
}

/**
 * Whether a `class-ref` field is inherited from a NATIVE base rather than
 * declared by any struct this compiler emits. Such a field has a carrier
 * (read through `declaredRecordFieldOf`) but no presence bit of its own.
 */
export const nativeBaseFieldOf = (
  deriver: RepresentationDeriver,
  representation: Representation,
  fieldName: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null = null
): boolean => {
  if (representation.kind !== 'class-ref' || classes === null) return false
  return nativeBaseRecordFieldOf(deriver, representation.declaration, fieldName, classes) !== null
}

/** The field a class's native record base (up its chain) declares under a name, if any. */
const nativeBaseRecordFieldOf = (
  deriver: RepresentationDeriver,
  declaration: DeclarationId,
  fieldName: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): RecordField | null => {
  const owner = (current: DeclarationId, seen: Set<DeclarationId>): RecordField | null => {
    if (seen.has(current)) return null
    seen.add(current)
    const layout = classes.get(current)
    if (layout === undefined) return null
    if (layout.base !== null) {
      const inherited = owner(layout.base, seen)
      if (inherited !== null) return inherited
    }
    if (layout.nativeBase !== null && layout.nativeBase.instance.kind === 'native-record-ref')
      return recordFieldsOfShape(deriver, layout.nativeBase.instance.shapeId)?.find((field) => field.key === fieldName) ?? null
    return null
  }
  return owner(declaration, new Set())
}

/**
 * The declared field one receiver carrier stores under a name: `record` and
 * `record-with-index` carry their fields inline; `native-record-ref` names a
 * shape; a `class-ref` is read through the shape its struct was built from,
 * base-first, so a field found up the chain names the base's storage.
 */
export const declaredRecordFieldOf = (
  deriver: RepresentationDeriver,
  representation: Representation,
  fieldName: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null = null
): RecordField | null => {
  if (representation.kind === 'class-ref' && classes !== null) {
    const override = classMethodOverrideOf(classes, representation.declaration, fieldName)
    if (override) return override
    // A member the NATIVE base declares is stored there whatever the class
    // redeclares it as: `class AppError extends Error { override
    // cause?: Error }` holds its cause in `gea::runtime::Error`'s one dynamic
    // `cause`, and the struct links that base (`records.ts`) and prints no
    // second slot. The class's storage census still lists the redeclaration,
    // so asking it first typed every load and store of that member against a
    // slot no struct declares.
    const native = nativeBaseRecordFieldOf(deriver, representation.declaration, fieldName, classes)
    if (native !== null) return native
    const nativeStorage = classes.get(representation.declaration)?.nativeStorage
    if (nativeStorage !== undefined) return nativeStorage.fields.find((field) => field.key === fieldName) ?? null
    const physicalField = (declaration: DeclarationId, seen: Set<DeclarationId>): RecordField | null => {
      if (seen.has(declaration)) return null
      seen.add(declaration)
      const layout = classes.get(declaration)
      if (layout === undefined) return null
      if (layout.base !== null) {
        const inherited = physicalField(layout.base, seen)
        if (inherited !== null) return inherited
      }
      if (layout.nativeBase !== null && layout.nativeBase.instance.kind === 'native-record-ref') {
        const inherited = recordFieldsOfShape(deriver, layout.nativeBase.instance.shapeId)?.find((field) => field.key === fieldName) ?? null
        if (inherited !== null) return inherited
      }
      const instance = layout.instance
      if (instance === null || instance.kind !== 'class-ref') return null
      return recordFieldsOfShape(deriver, instance.shapeId)?.find((field) => field.key === fieldName) ?? null
    }
    return physicalField(representation.declaration, new Set())
  }
  const classShape = representation.kind === 'class-ref' ? (classes?.get(representation.declaration)?.instance ?? null) : null
  const shapeId =
    classShape !== null && classShape.kind === 'class-ref' && 'shapeId' in representation
      ? classShape.shapeId
      : (representation as { shapeId?: string }).shapeId
  const fields =
    representation.kind === 'record' || representation.kind === 'record-with-index'
      ? representation.fields
      : (representation.kind === 'native-record-ref' || representation.kind === 'class-ref') && shapeId !== undefined
        ? recordFieldsOfShape(deriver, shapeId)
        : null
  return fields?.find((field) => field.key === fieldName) ?? null
}

export const declaredFieldRepresentationOf = (
  deriver: RepresentationDeriver,
  representation: Representation,
  fieldName: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null = null
): Representation | null => declaredRecordFieldOf(deriver, representation, fieldName, classes)?.value ?? null

/** The emitted class that physically owns a field, including redeclarations of an inherited slot. */
export const classFieldStorageOwnerOf = (
  deriver: RepresentationDeriver,
  representation: Representation,
  fieldName: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): DeclarationId | null => {
  if (representation.kind !== 'class-ref' || nativeBaseFieldOf(deriver, representation, fieldName, classes)) return null
  if (declaredRecordFieldOf(deriver, representation, fieldName, classes) === null) return null
  let owner = representation.declaration
  const seen = new Set<DeclarationId>()
  while (!seen.has(owner)) {
    seen.add(owner)
    const layout = classes.get(owner)
    if (!layout) return null
    if (layout.base === null) return owner
    const base = classes.get(layout.base)
    if (!base?.instance) return null
    if (declaredRecordFieldOf(deriver, base.instance, fieldName, classes) === null) return owner
    owner = layout.base
  }
  return null
}

/**
 * Published overlay ownership facts, optionally narrowed to one property key.
 *
 * The facts are computed by `projectClasses` after specialization collapse;
 * this accessor is intentionally a read of that sealed census rather than a
 * second walk that infers physical ownership from a target's record layout.
 */
export const classFieldOwnershipOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  key: string | null = null
): readonly ClassFieldOwnership[] => {
  const ownership: ClassFieldOwnership[] = []
  for (const layout of classes.values()) {
    for (const entry of layout.fieldOwnership) if (key === null || entry.key === key) ownership.push(entry)
  }
  return ownership
}

/**
 * The carrier a native property read produces before use-site narrowing.
 * Getter calls produce their ABI result. A fixed slot with an undefined tag
 * can also produce its storage carrier directly: the separate presence bit
 * has an exact absent value in that carrier, including after deletion.
 * Other storage carriers still need a read recipe that joins absence before
 * narrowing; using a plain payload here would erase a deleted property's
 * undefined result.
 */
export const propertyReadResultRepresentationOf = (
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  receiver: Representation,
  key: string
): Representation | null => {
  const carrier = receiver.kind === 'optional' ? receiver.payload : receiver
  const site = carrier.kind === 'class-ref' ? classMemberOf(classes, carrier.declaration, key) : null
  const getter =
    site?.kind === 'accessor'
      ? site.accessor.getter
      : carrier.kind === 'record' || carrier.kind === 'native-record-ref'
        ? recordAccessorsOfShape(deriver, carrier.shapeId)?.find((accessor) => accessor.key === key)?.getter
        : null
  if (getter) return abis.get(getter)?.result ?? null
  if (site?.kind === 'accessor' || site?.kind === 'method') return null
  // Host records own their read protocol; a described field does not prove
  // that their bridge returns the compiler's generated storage carrier.
  if (carrier.kind === 'native-record-ref' && carrier.native !== null) return null
  const field = declaredRecordFieldOf(deriver, carrier, key, classes)
  if (!field) return null
  // A native tagged union has an explicit undefined arm just as an Optional
  // has an absence bit. Read that complete storage carrier before narrowing;
  // otherwise the printer hides the conversion from IR and reflection demand.
  if (field.value.kind === 'tagged-union' && dynamicFieldAbsencePolicy(field.value)?.allowsUndefined) return field.value
  return field.value.kind === 'optional' && field.value.absence === 'undefined' ? field.value : null
}

export type ClassMemberSite =
  // `owner` is the class that DECLARES the member, which is not always the
  // class the receiver was typed as: a field found up the chain has its
  // storage -- and therefore its C++ member -- on the base's struct.
  | { readonly kind: 'field'; readonly owner: DeclarationId }
  | { readonly kind: 'accessor'; readonly owner: DeclarationId; readonly accessor: ClassAccessor }
  | { readonly kind: 'method'; readonly owner: DeclarationId; readonly method: ClassMethod }
  | { readonly kind: 'unknown-class'; readonly owner: DeclarationId }

/**
 * Which of several same-key methods a site means.
 *
 * One key can name more than one body: a GENERIC method is monomorphized per
 * type argument, and every copy installs itself under the method's own name
 * (`map<R>` at `R = number` and at `R = string` are two `ClassMethod`s keyed
 * `"map"`). Taking the first unconditionally is what made
 * `n.map((v) => 'x!')` call the number-returning body and then refuse to
 * convert its callback into that body's parameter slot. The site knows which
 * one it means -- its callee read carries that copy's own convention -- so it
 * says so here, and a site with no opinion keeps getting the first exactly as
 * before. The answer is a RANK: an exact convention outranks one the site's
 * values merely convert into (`call-dispatch.ts`'s `methodCopyPreferenceOf`).
 */
export type ClassMethodPreference = (method: ClassMethod) => number

const selectedMethod = (
  methods: readonly ClassMethod[],
  key: string,
  prefer: ClassMethodPreference | undefined
): ClassMethod | undefined => {
  const named = methods.filter((candidate) => candidate.key === key)
  if (named.length < 2 || prefer === undefined) return named[0]
  // The highest-ranked candidate, the first among equals; a rank of zero is
  // no opinion, which keeps the first exactly as before.
  let chosen = named[0]
  let best = 0
  for (const candidate of named) {
    const rank = prefer(candidate)
    if (rank > best) {
      chosen = candidate
      best = rank
    }
  }
  return chosen
}

const memberSiteAlong = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string,
  select: (layout: ClassLayout) => { fields: readonly ClassField[]; accessors: readonly ClassAccessor[]; methods: readonly ClassMethod[] },
  prefer?: ClassMethodPreference
): ClassMemberSite | null => {
  const walked = new Set<DeclarationId>()
  let current: DeclarationId | null = declaration
  while (current !== null && !walked.has(current)) {
    walked.add(current)
    const owner: DeclarationId = current
    const layout = classes.get(owner)
    if (!layout) return { kind: 'unknown-class', owner }
    const { fields, accessors, methods } = select(layout)
    if (fields.some((field) => field.key === key)) return { kind: 'field', owner }
    const accessor = accessors.find((candidate) => candidate.key === key)
    if (accessor) return { kind: 'accessor', owner, accessor }
    const method = selectedMethod(methods, key, prefer)
    if (method) return { kind: 'method', owner, method }
    current = layout.base
  }
  return null
}

/** Which instance member a key names on a class, walking its bases; `null` when none declares it. */
export const classMemberOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string,
  prefer?: ClassMethodPreference
): ClassMemberSite | null =>
  memberSiteAlong(
    classes,
    declaration,
    key,
    (layout) => ({ fields: layout.fields, accessors: layout.accessors, methods: layout.methods }),
    prefer
  )

/** The one physical slot shared by own shadows of an inherited method. */
export const classMethodOverrideOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): RecordField | null => {
  const seen = new Set<DeclarationId>()
  let selected: RecordField | null = null
  // The slot has to EXIST on the receiver's struct. Native storage drops a
  // reserved overlay slot nothing accesses (`projectNativeClassStorage`'s
  // `omittedOverlays`), and a method shadowed only by such a slot is not
  // shadowed at all: no write ever made it present. Answering the layout's
  // `methodOverrides` entry anyway made every reader spell
  // `receiver->gea_present_<method>` on a struct that never declared it.
  const physical = classes.get(declaration)?.nativeStorage
  const resolve = (candidate: RecordField | null): RecordField | null =>
    candidate !== null && physical !== undefined && !physical.fields.some((field) => field.key === candidate.key) ? null : candidate
  for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
    seen.add(current)
    const layout = classes.get(current)
    if (!layout) break
    if (layout.fields.some((field) => field.key === key) || layout.accessors.some((accessor) => accessor.key === key))
      return resolve(selected)
    selected = layout.methodOverrides?.find((field) => field.key === key) ?? selected
    current = layout.base
  }
  return resolve(selected)
}

/** Every read-time native function carrier selected by a class family's method lookup. */
export const nativeClassMethodValueSourcesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string,
  projectedAbi?: (callable: FunctionId) => CallableAbi | null,
  carrier?: Representation
): readonly Representation[] | null => {
  const readAbi = (callable: FunctionId): CallableAbi | null => {
    if (projectedAbi !== undefined) return projectedAbi(callable)
    for (const layout of classes.values()) {
      const method = layout.methods.find((entry) => entry.callable === callable)
      if (method?.representation !== undefined && 'abi' in method.representation) return method.representation.abi
    }
    return null
  }
  const site = classMemberOf(classes, declaration, key)
  if (site?.kind !== 'method') return null
  const held =
    carrier !== undefined
      ? abiOfCallee(carrier)
      : site.method.callable !== null
        ? readAbi(site.method.callable)
        : site.method.representation === undefined
          ? null
          : abiOfCallee(site.method.representation)
  const arms = classMethodValueArmsOf(classes, declaration, key)
  if (held === null || arms === null) return null
  const sources: Representation[] = []
  for (const arm of arms) {
    const owner = [...classes.values()].find((layout) => layout.methods.some((method) => method.callable === arm.method.callable))
    if (owner === undefined) return null
    const copies = owner.methods.filter((method) => method.key === key)
    const method = copies.length < 2 ? arm.method : methodCopyHeldBy(copies, held, readAbi)
    if (method?.callable === null || method?.callable === undefined) return null
    const abi = readAbi(method.callable)
    if (abi === null) return null
    sources.push({ kind: 'function-value-dispatch', abi })
    const own = classMethodOverrideOf(classes, arm.allocation, key)
    if (own !== null) sources.push(own.value)
    const prototype = classMethodOverrideOf(classes, owner.declaration, key)
    if (prototype !== null) sources.push(prototype.value)
  }
  return sources
}

/** A super lookup still observes replacement of the selected prototype method. */
export const classPrototypeMethodMutableOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): boolean => {
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
    seen.add(current)
    const layout = classes.get(current)
    if (!layout) return false
    if (layout.prototypeMethodMutations?.includes(key)) return true
    if (
      layout.fields.some((field) => field.key === key) ||
      layout.accessors.some((accessor) => accessor.key === key) ||
      layout.methods.some((method) => method.key === key)
    )
      return false
    current = layout.base
  }
  return false
}

const prototypeFamilyMutabilityCache = new WeakMap<ReadonlyMap<DeclarationId, ClassLayout>, Map<DeclarationId, Map<string, boolean>>>()

/** A base-typed ordinary receiver may carry any reachable derived prototype. */
export const classPrototypeMethodFamilyMutableOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): boolean => {
  let byDeclaration = prototypeFamilyMutabilityCache.get(classes)
  if (!byDeclaration) prototypeFamilyMutabilityCache.set(classes, (byDeclaration = new Map()))
  let answers = byDeclaration.get(declaration)
  if (!answers) byDeclaration.set(declaration, (answers = new Map()))
  const previous = answers.get(key)
  if (previous !== undefined) return previous
  const remember = (answer: boolean): boolean => {
    answers.set(key, answer)
    return answer
  }
  if (![...classes.values()].some((layout) => layout.prototypeMethodMutations?.includes(key))) return remember(false)
  for (const candidate of classes.keys()) {
    const seen = new Set<DeclarationId>()
    for (let current: DeclarationId | null = candidate; current !== null && !seen.has(current);) {
      if (current === declaration) {
        if (classPrototypeMethodMutableOf(classes, candidate, key)) return remember(true)
        break
      }
      seen.add(current)
      current = classes.get(current)?.base ?? null
    }
  }
  return remember(false)
}

/** The static counterpart of `classMemberOf`. */
export const classStaticMemberOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): ClassMemberSite | null =>
  memberSiteAlong(classes, declaration, key, (layout) => ({
    fields: layout.staticFields,
    accessors: layout.staticAccessors,
    methods: layout.staticMethods
  }))

/**
 * Every accessor body a reachable record shape names.
 *
 * `buildCaptureIndex` needs it before it can decide which bodies get an
 * environment, and an accessor body is reached only through the shape that
 * names it -- there is no `allocate-callable` for one, which is exactly why it
 * has no environment today. Walked with `walkRepresentation`, the model's own
 * shared walk, so this cannot cover a different carrier set than the guards
 * built on the same walk do.
 */
export const recordAccessorBodiesOf = (
  representations: readonly Representation[],
  deriver: RepresentationDeriver
): ReadonlySet<FunctionId> => {
  const accessorBodies = new Set<FunctionId>()
  const visited = new Set<Representation>()
  const record = (accessors: readonly RecordAccessor[]): void => {
    for (const accessor of accessors) {
      if (accessor.getter) accessorBodies.add(accessor.getter)
      if (accessor.setter) accessorBodies.add(accessor.setter)
    }
  }
  for (const representation of representations) {
    for (const found of walkRepresentation(representation, visited)) {
      if (found.kind === 'record') record(found.accessors)
      // A nominal reference NAMES the shape rather than carrying it, so its
      // members come from the deriver -- `recordLayoutOfShape`, the same
      // authority the struct itself is rendered from.
      if (found.kind === 'native-record-ref') record(recordAccessorsOfShape(deriver, found.shapeId) ?? [])
    }
  }
  return accessorBodies
}
