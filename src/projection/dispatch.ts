import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassField, ClassLayout, ClassMethod } from './classes.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { abiKey, passingOf, representationKey, sameRestPartition } from '../representation/model.js'
import { optionalOf } from '../representation/optional.js'
import { classMemberOf } from './fields.js'

/** Exact allocation identities and the method each prototype lookup selects.
 * Selection happens when the property is read, before a later call supplies
 * its receiver. A virtual call adapter would select at the wrong time.
 */
export const classPrototypeMethodValueArmsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: DeclarationId,
  key: string
): readonly { readonly allocation: DeclarationId; readonly method: (ClassMethod & { readonly callable: FunctionId }) | null }[] | null => {
  const arms: { allocation: DeclarationId; method: (ClassMethod & { callable: FunctionId }) | null }[] = []
  for (const [allocation, layout] of classes) {
    if (allocation !== receiver && !extendsClass(classes, allocation, receiver)) continue
    if (layout.nativeBase !== null) return null
    const site = classMemberOf(classes, allocation, key)
    // Absence belongs to the language's undefined result. An accessor is an
    // invocation, not a method value, and must keep its separate proof path.
    if (site === null) arms.push({ allocation, method: null })
    else if (site.kind === 'method' && site.method.callable !== null)
      arms.push({ allocation, method: { ...site.method, callable: site.method.callable } })
    else return null
  }
  return arms.length === 0 ? null : arms
}

/** All prototype keys reachable through this native family, including keys
 * introduced below the static receiver and inherited above it.
 */
export const classPrototypeMethodKeysOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: DeclarationId
): readonly string[] => {
  const keys = new Set<string>()
  const visited = new Set<DeclarationId>()
  for (const allocation of classes.keys()) {
    if (allocation !== receiver && !extendsClass(classes, allocation, receiver)) continue
    for (let current: DeclarationId | null = allocation; current !== null && !visited.has(current);) {
      visited.add(current)
      const layout = classes.get(current)
      if (!layout) break
      for (const method of layout.methods) keys.add(method.key)
      current = layout.base
    }
  }
  return [...keys]
}

/** A statically callable family still requires a method on every allocation. */
export const classMethodValueArmsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: DeclarationId,
  key: string
): readonly { readonly allocation: DeclarationId; readonly method: ClassMethod & { readonly callable: FunctionId } }[] | null => {
  const arms = classPrototypeMethodValueArmsOf(classes, receiver, key)
  if (arms === null || arms.some((arm) => arm.method === null)) return null
  return arms.map((arm) => ({ allocation: arm.allocation, method: arm.method! }))
}

/**
 * The class-hierarchy topology behind method dispatch: which key belongs to
 * which override family, and who redeclares what.
 *
 * Both questions are pure functions of `ClassLayout` -- no lowered IR, no
 * capture analysis, no render-time ABI comparison enters them -- so they
 * belong here rather than in the C++ target, and `targets/cpp/virtual-methods.
 * ts`/`targets/cpp/class-layout.ts` re-export them rather than defining their
 * own copies. `virtual-methods.ts` previously carried its own `extendsClass`,
 * byte-identical to `class-layout.ts`'s: two definitions of one graph walk is
 * the exact two-authorities shape a single import now forecloses.
 *
 * The DISPATCHABILITY verdict -- whether a family is actually dispatchable
 * (every override's ABI is compatible, and none of them captures an
 * environment a C++ member function has no formal to carry) -- lives here
 * too now, as `virtualDispatchVerdictOf` below. It used to live in
 * `targets/cpp/virtual-methods.ts`, decided from the LOWERED bodies' ABIs and
 * `targets/cpp/captures.ts`'s whole-unit capture index, both of which existed
 * only after every body in the unit had lowered (`translation-unit.ts`'s
 * `renderTranslationUnit`) -- a fact this module, which runs before any body
 * lowers, could not see. What moved it here is `ir/captures.ts`'s
 * `publishCaptureFacts`, sealed onto every body as `IrBody.facts` right after
 * `shakeProgram`, which is where `ir/captures.ts` fills the allocation op:
 * `IrBodyFacts.capturedDeclarations`/
 * `.capturedReceiver` name capture-freedom with no C++ in the answer, so a
 * caller can hand `virtualDispatchVerdictOf` a plain predicate over those
 * published facts instead of a render-time capture index. The one thing that
 * still cannot move is ABI-compatibility TEXT (the exact conversion an
 * implementor's parameter or receiver needs) -- that stays a C++ spelling in
 * `virtual-methods.ts`, which renders it having already been TOLD by this
 * verdict that every implementor converts; see that file's `virtualMethodAdapterOf`.
 */

/** Whether `candidate`'s base chain reaches `ancestor`. A class reached twice would be a class extending itself, which no well-formed program has, so the walk stops there rather than looping. */
export const extendsClass = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  candidate: DeclarationId,
  ancestor: DeclarationId
): boolean => {
  const walked = new Set<DeclarationId>()
  let current: DeclarationId | null = classes.get(candidate)?.base ?? null
  while (current !== null && !walked.has(current)) {
    if (current === ancestor) return true
    walked.add(current)
    current = classes.get(current)?.base ?? null
  }
  return false
}

/**
 * Every class BELOW `declaration` that redeclares `key`, nearest first.
 *
 * `classMemberOf` (`projection/fields.ts`) walks UP, which is the language's
 * lookup for a receiver whose class is known exactly. It is not the whole
 * answer for a CALL. A receiver annotated as a base can hold an instance of
 * anything derived from it, and the language dispatches on the object; so a
 * member found up the chain is only safe to bind directly when nothing below
 * redeclares it. An empty result is the proof that the family is closed at
 * this key -- the assumption every direct bind of a method or accessor body
 * already makes, now asked rather than assumed.
 *
 * The search is over the whole class map because inheritance is stated
 * upward: a layout names its base and never its derivations, so the derived
 * side exists only as the set of classes whose own chain leads here.
 */
// Which classes declare a member at all, by key, in the class map's own
// iteration order. Every dispatch decision of every emitted body asks about one
// key, and the answer is nearly always "a handful of classes declare it" -- but
// the walk above visited the whole class map (and scanned each layout's member
// lists) to find them. The size guard is the invalidation: a class map only
// ever grows while it is being built.
const declarersByKey = new WeakMap<
  ReadonlyMap<DeclarationId, ClassLayout>,
  { readonly size: number; readonly byKey: Map<string, DeclarationId[]> }
>()

const declarersOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>, key: string): readonly DeclarationId[] => {
  let held = declarersByKey.get(classes)
  if (!held || held.size !== classes.size) {
    const byKey = new Map<string, DeclarationId[]>()
    for (const [candidate, layout] of classes) {
      const keys = new Set<string>()
      for (const entry of layout.accessors) keys.add(entry.key)
      for (const entry of layout.methods) keys.add(entry.key)
      for (const member of keys) {
        const declarers = byKey.get(member)
        if (declarers) declarers.push(candidate)
        else byKey.set(member, [candidate])
      }
    }
    held = { size: classes.size, byKey }
    declarersByKey.set(classes, held)
  }
  return held.byKey.get(key) ?? []
}

export const classFamilyOverridesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): readonly DeclarationId[] => {
  const overriding: DeclarationId[] = []
  for (const candidate of declarersOf(classes, key)) {
    if (candidate === declaration) continue
    if (extendsClass(classes, candidate, declaration)) overriding.push(candidate)
  }
  return overriding
}

/**
 * A data field a descendant's accessor can replace: one a JavaScript
 * `this.x = v` store creates. That store is a [[Set]], so on an instance of a
 * class below that declares `get x()`/`set x()` it runs the setter rather than
 * creating an own property, and the field never exists on that instance. A
 * field DEFINED at construction is an own property that shadows the accessor
 * instead. A subclass-member overlay defines nothing: it is the typed slot a
 * base keeps for its descendants' same-named members, so the descendants'
 * `this.x = v` stores land in it. A base that names no `value` keeps one when
 * `this.referenceNode.value` reads it through that base, and InputNode's own
 * `this.value = value` is then that slot's write.
 */
const assignedFieldEvidence = (layout: ClassLayout | undefined, key: string): ClassField | undefined =>
  layout?.fields.find((field) => field.key === key && (field.assignedMember === true || field.syntheticSubclassMemberOverlay === true))

/**
 * The replaceable field whose slot `declaration`'s native storage holds,
 * carried as the slot is stored: a class this answers for can root a family
 * over the field.
 *
 * The evidence alone does not say where the slot is. An overlay is type
 * evidence, kept as storage only where an access goes through that base
 * (`projectNativeClassStorage`); when none does, the slot is the first
 * descendant's own, and three's `InputNode` holds `value` while `Node`, whose
 * overlay types it, holds nothing. Rooting at the overlay anyway made the
 * root's member store into a struct member that was never declared, and
 * pulled every same-named accessor under the overlay's class into the family,
 * reachable from the receivers or not: `PMREMNode`'s `value`, whose Texture
 * the slot did not convert to, and `Node`'s getter-only `type` under
 * `EventDispatcher`'s overlay, which left the `type` family with no setter
 * for Node -- either refused the family, and with it every write through an
 * `InputNode`, a `UniformNode` or a `Material`.
 *
 * The slot's carrier is the storage's, which can be wider than the evidence:
 * the evidence lists the values the flow saw stored, and a field that stores
 * a function is boxed, so a setter taking a value the flow never saw stored
 * (TextureNode's Texture) finds no conversion from the evidence while every
 * write already converts into the storage. A class with no native storage is
 * answered by its evidence.
 */
const accessorReplaceableField = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): ClassField | undefined => {
  const layout = classes.get(declaration)
  if (layout?.nativeStorage === undefined) return assignedFieldEvidence(layout, key)
  const slot = layout.nativeStorage.fields.find((field) => field.key === key)
  if (slot === undefined) return undefined
  const site = classMemberOf(classes, declaration, key)
  const evidence = site?.kind === 'field' ? assignedFieldEvidence(classes.get(site.owner), key) : undefined
  return evidence === undefined ? undefined : { ...evidence, representation: slot.value }
}

/**
 * Every class below `declaration` whose accessor replaces the data field a
 * read or write of `key` on it resolves to, or nothing when the member is no
 * such field. three's `InputNode` stores `this.value = value`, and
 * `TextureNode`, below it, declares `get value()`/`set value()`: a receiver
 * typed `UniformNode` holding a TextureNode reaches the accessor, so a
 * non-empty answer means the field is not the member for every instance and
 * the access has to dispatch.
 */
export const fieldReplacingAccessorsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): readonly DeclarationId[] => {
  const site = classMemberOf(classes, declaration, key)
  if (site?.kind !== 'field' || assignedFieldEvidence(classes.get(site.owner), key) === undefined) return []
  return classFamilyOverridesOf(classes, declaration, key).filter((candidate) =>
    classes.get(candidate)!.accessors.some((entry) => entry.key === key)
  )
}

/**
 * Which of a member's three dispatchable halves a family is.
 *
 * A key is a method OR an accessor, never both, so `call` never coexists with
 * the other two on one key -- but a getter and a setter are two bodies with
 * two conventions, and each needs its own slot.
 */
export type VirtualMemberRole = 'call' | 'get' | 'set'

/** One key, and every class in its family that implements it. */
export interface VirtualMethodFamily {
  readonly key: string
  /** Which half of the member this family dispatches. */
  readonly role: VirtualMemberRole
  /** The topmost class declaring the key: the struct that gets the `virtual` member. */
  readonly root: DeclarationId
  readonly implementors: readonly VirtualMethodImplementor[]
  /**
   * Whether the root's own declaration is BODYLESS -- `abstract check(value:
   * number): boolean`, or an overload signature with no implementation.
   *
   * The root is what gives the family its dispatch slot, and a slot is a
   * declaration, not a body: an abstract root states the convention every
   * override is checked against and supplies nothing to run. Dropping the
   * family for want of a root body is what sent `rules.map(r => r.describe())`
   * over `Rule[]` through a boxed dynamic property read, which then aborted at
   * runtime -- the program was statically dispatchable the whole time.
   */
  readonly abstractRoot: boolean
  /**
   * The receiverless convention of the generic-method COPY this family
   * dispatches, or absent for a method with one body per class. See
   * `virtualCopyFamiliesOf`.
   */
  readonly copy?: string
  /**
   * The classes that redeclare the key but carry no body at this copy's
   * convention. Such a copy has no member to dispatch a subclass instance to,
   * so the family is refused rather than run the base's body for it.
   */
  readonly copyAbsentFrom?: readonly DeclarationId[]
  /**
   * The derived classes whose own DATA FIELD implements an accessor family:
   * `abstract get clearServerSelectionTimeout(): boolean` on mongodb's
   * `TimeoutContext`, answered by `clearServerSelectionTimeout: boolean` in
   * `LegacyTimeoutContext`/`CSOTTimeoutContext`. The field is an own property
   * of every such instance and shadows the prototype accessor, so a read (or
   * write) through the root must reach it -- without an override here the
   * slot fell through to the abstract root's stub and aborted.
   */
  readonly fieldImplementors?: readonly VirtualFieldImplementor[]
  /**
   * The root's own DATA FIELD, which the implementors' accessors replace
   * (`fieldReplacingAccessorsOf`): the root's member reads or writes it, and
   * the slot carries its carrier. Without the family a read through the root
   * loaded the field a TextureNode never writes, and the root's own
   * constructor store wrote it instead of running the setter.
   */
  readonly rootField?: ClassField
  /**
   * The classes whose accessor replaces `rootField` but has no body for this
   * half. The language throws on such a write (a getter-only accessor in
   * class code), and no read of a setter-only one finds the field, so the
   * family is refused rather than let the root's field answer for them.
   */
  readonly halfAbsentFrom?: readonly DeclarationId[]
}

export interface VirtualMethodImplementor {
  readonly declaration: DeclarationId
  readonly callable: FunctionId
}

export interface VirtualFieldImplementor {
  readonly declaration: DeclarationId
  readonly field: ClassField
}

/** The topmost class along `declaration`'s chain that declares `key` as a method. */
const rootDeclaring = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string,
  role: VirtualMemberRole
): DeclarationId => {
  const walked = new Set<DeclarationId>()
  let root = declaration
  let current: DeclarationId | null = declaration
  while (current !== null && !walked.has(current)) {
    walked.add(current)
    const layout = classes.get(current)
    if (!layout) return root
    // Accessors alongside methods: `get label()` overridden by `get label()`
    // is the identical family question, and asking only about methods rooted
    // every override at its own class, which is no family at all. A data
    // field an accessor below replaces roots the accessor's family the same
    // way: a receiver typed as the field's class reaches the accessor.
    if (
      layout.methods.some((method: ClassMethod) => method.key === key) ||
      layout.accessors.some((entry) => entry.key === key) ||
      (role !== 'call' && accessorReplaceableField(classes, current, key) !== undefined)
    )
      root = current
    current = layout.base
  }
  return root
}

/**
 * Every method key the program actually overrides, grouped by the class that
 * roots the family.
 *
 * A key declared only by unrelated classes is not a family: no receiver can be
 * typed as a common base that has it, so nothing dispatches. Only a key whose
 * ROOT declares it, and which something derived from that root redeclares,
 * needs a vtable slot.
 */
export const virtualMethodFamiliesOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>): readonly VirtualMethodFamily[] => {
  const byRoot = new Map<
    string,
    {
      key: string
      role: VirtualMemberRole
      root: DeclarationId
      rootDeclares: boolean
      implementors: VirtualMethodImplementor[]
      absent: DeclarationId[]
    }
  >()
  const record = (declaration: DeclarationId, key: string, role: VirtualMemberRole, callable: FunctionId | null): void => {
    const root = rootDeclaring(classes, declaration, key, role)
    const id = `${root} ${key} ${role}`
    const entry = byRoot.get(id) ?? { key, role, root, rootDeclares: false, implementors: [], absent: [] }
    if (declaration === root) entry.rootDeclares = true
    if (callable !== null) entry.implementors.push({ declaration, callable })
    else entry.absent.push(declaration)
    byRoot.set(id, entry)
  }
  for (const [declaration, layout] of classes) {
    for (const method of layout.methods) record(declaration, method.key, 'call', method.callable)
    for (const accessor of layout.accessors) {
      record(declaration, accessor.key, 'get', accessor.getter)
      record(declaration, accessor.key, 'set', accessor.setter)
    }
  }
  // A data field a class below an accessor's root declares under the same
  // key implements both halves of it for that class's instances.
  const fieldImplementorsOf = (entry: { key: string; role: VirtualMemberRole; root: DeclarationId }): VirtualFieldImplementor[] => {
    if (entry.role === 'call') return []
    const found: VirtualFieldImplementor[] = []
    for (const [declaration, layout] of classes) {
      if (declaration === entry.root || !extendsClass(classes, declaration, entry.root)) continue
      const field = layout.fields.find((candidate) => candidate.key === entry.key && !candidate.syntheticSubclassMemberOverlay)
      if (field !== undefined) found.push({ declaration, field })
    }
    return found.sort((left, right) => (left.declaration < right.declaration ? -1 : 1))
  }
  return [...byRoot.values()]
    .map((entry) => ({
      entry,
      fieldImplementors: fieldImplementorsOf(entry),
      // Only a root that declares no accessor of its own is answered by its
      // field; one that does is an ordinary accessor family.
      rootField: entry.role === 'call' || entry.rootDeclares ? undefined : accessorReplaceableField(classes, entry.root, entry.key)
    }))
    .filter(
      ({ entry, fieldImplementors, rootField }) =>
        rootField !== undefined ||
        fieldImplementors.length > 0 ||
        entry.implementors.some((implementor) => implementor.declaration !== entry.root)
    )
    .filter(({ entry, rootField }) => entry.rootDeclares || rootField !== undefined)
    .map(({ entry, fieldImplementors, rootField }) => ({
      key: entry.key,
      role: entry.role,
      root: entry.root,
      abstractRoot: rootField === undefined && !entry.implementors.some((implementor) => implementor.declaration === entry.root),
      implementors: [...entry.implementors].sort((left, right) => (left.declaration < right.declaration ? -1 : 1)),
      ...(fieldImplementors.length > 0 ? { fieldImplementors } : {}),
      ...(rootField !== undefined ? { rootField } : {}),
      ...(rootField !== undefined && entry.absent.length > 0 ? { halfAbsentFrom: [...entry.absent].sort() } : {})
    }))
    .sort((left, right) => (`${left.root} ${left.key} ${left.role}` < `${right.root} ${right.key} ${right.role}` ? -1 : 1))
}

/** The key a call site looks up: the class it resolved the member ON, plus the member. Moved here from `targets/cpp/virtual-methods.ts` (which still re-exports it) so `ir/call-dispatch.ts` can ask the identical question without importing a target module. */
export const virtualDispatchKey = (owner: DeclarationId, key: string, role: VirtualMemberRole = 'call'): string => `${owner} ${key} ${role}`

/** The convention that tells one copy of a generic method from another: its ABI without the receiver, which is each class's own. */
export const virtualCopyKeyOf = (abi: CallableAbi): string => abiKey({ ...abi, receiver: null })

/** The key a call site reading one COPY of a generic method looks up, beside `virtualDispatchKey`. */
export const virtualCopyDispatchKey = (owner: DeclarationId, key: string, copy: string): string => `${owner} ${key} call ${copy}`

/** A dispatch a member read resolves to, with the generic-method copy it names when it names one. */
export interface VirtualDispatchEntry<T> {
  readonly entry: T
  readonly copy?: string
}

/**
 * The dispatch a method read resolves to: the family of the whole key, else
 * the family of the ONE copy whose convention the read holds.
 *
 * A read's held convention is the checker's view of the call, which can widen
 * the result past the body's -- `doc.get('cursor', 'object')?.get(...)`
 * publishes the optional chain's `undefined` in it. So a copy is taken when its
 * parameters are the read's exactly and its result's arms are the read's, less
 * at most that `undefined`, and only when exactly one copy fits.
 */
export const virtualDispatchFor = <T>(
  dispatched: ReadonlyMap<string, T>,
  owner: DeclarationId,
  key: string,
  role: VirtualMemberRole,
  held: CallableAbi | null,
  abiOfEntry: (entry: T) => CallableAbi
): VirtualDispatchEntry<T> | undefined => {
  const whole = dispatched.get(virtualDispatchKey(owner, key, role))
  if (whole !== undefined) return { entry: whole }
  if (role !== 'call' || held === null) return undefined
  const exactCopy = virtualCopyKeyOf(held)
  const exact = dispatched.get(virtualCopyDispatchKey(owner, key, exactCopy))
  if (exact !== undefined) return { entry: exact, copy: exactCopy }
  const prefix = virtualCopyDispatchKey(owner, key, '')
  const fitting: VirtualDispatchEntry<T>[] = []
  for (const [dispatchKey, entry] of dispatched) {
    if (!dispatchKey.startsWith(prefix)) continue
    if (conventionFits(abiOfEntry(entry), held)) fitting.push({ entry, copy: dispatchKey.slice(prefix.length) })
  }
  return fitting.length === 1 ? fitting[0] : undefined
}

/**
 * The one copy among a class's same-key methods whose convention a read holds
 * -- the rule `virtualDispatchFor` applies to dispatch members, applied to the
 * bodies themselves: an exact receiverless match, else the one copy whose
 * parameters agree and whose result's values the read's result admits.
 * `null` when no copy, or more than one, fits.
 */
export const methodCopyHeldBy = <M extends { readonly callable: FunctionId | null }>(
  copies: readonly M[],
  held: CallableAbi,
  abiOf: (callable: FunctionId) => CallableAbi | null
): M | null => {
  const wanted = virtualCopyKeyOf(held)
  const conventions = copies.map((copy) => ({ copy, abi: copy.callable === null ? null : abiOf(copy.callable) }))
  const exact = conventions.find(({ abi }) => abi !== null && virtualCopyKeyOf(abi) === wanted)
  if (exact !== undefined) return exact.copy
  const fitting = conventions.filter(({ abi }) => abi !== null && conventionFits(abi, held))
  return fitting.length === 1 ? fitting[0]!.copy : null
}

const conventionFits = (body: CallableAbi, held: CallableAbi): boolean =>
  sameRestPartition(body, held) &&
  body.parameters.length === held.parameters.length &&
  body.parameters.every((parameter, index) => representationKey(parameter.value) === representationKey(held.parameters[index]!.value)) &&
  resultArmsFit(body.result, held.result)

/** The values a result carrier can hold, as the carriers of its arms. */
const resultArmsOf = (value: Representation): readonly Representation[] =>
  value.kind === 'tagged-union'
    ? value.arms.flatMap((arm) => resultArmsOf(arm.value))
    : value.kind === 'optional'
      ? [...resultArmsOf(value.payload), { kind: value.absence }]
      : [value]

// The read may add only the optional chain's `undefined`: any other extra arm
// could be a different copy's result, and a copy the verdict refused is not in
// the table to lose a tie against.
const resultArmsFit = (body: Representation, held: Representation): boolean => {
  const bodyArms = new Set(resultArmsOf(body).map(representationKey))
  const heldArms = new Set(resultArmsOf(held).map(representationKey))
  const undefinedArm = representationKey({ kind: 'undefined' })
  return [...bodyArms].every((arm) => heldArms.has(arm)) && [...heldArms].every((arm) => bodyArms.has(arm) || arm === undefinedArm)
}

/**
 * A generic method's family split into one family per copy.
 *
 * `specialization.ts` compiles `get<const T>(name, as: T): JSTypeOf[T]` once
 * per instantiation, and every class in the family publishes its copies under
 * the one key -- mongodb's `OnDemandDocument.get<T>` overridden by
 * `MongoDBResponse.get<T>`, read at `'object'` and at `'timestamp'`. Treated as
 * one family, the `timestamp` copy's `Timestamp | null` result had to convert
 * into the `object` copy's slot, and the whole key was refused. Each copy is
 * its own overridable member: the base's `T = 'object'` body is overridden by
 * the subclass's `T = 'object'` body and by nothing else. So the copies are
 * partitioned by their receiverless convention, and each partition is a
 * family of its own with its own member; a class with two copies of one
 * convention (two instantiations the types erase to the same ABI) contributes
 * its first, as both run the same JavaScript.
 *
 * A family with at most one implementor per class is returned unchanged.
 */
const virtualCopyFamiliesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  family: VirtualMethodFamily,
  abiOf: (callable: FunctionId) => CallableAbi | null
): readonly VirtualMethodFamily[] => {
  if (family.role !== 'call') return [family]
  const lineage = classCopyFamiliesOf(classes, family, abiOf)
  if (lineage !== null) return lineage
  const declarations = new Set(family.implementors.map((implementor) => implementor.declaration))
  if (declarations.size === family.implementors.length) return [family]
  const partitions = new Map<string, VirtualMethodImplementor[]>()
  for (const implementor of family.implementors) {
    const abi = abiOf(implementor.callable)
    // A copy with no convention cannot be told apart; keeping the family whole
    // lets the ordinary verdict name it.
    if (abi === null) return [family]
    const copy = virtualCopyKeyOf(abi)
    const members = partitions.get(copy) ?? []
    if (!members.some((member) => member.declaration === implementor.declaration)) members.push(implementor)
    partitions.set(copy, members)
  }
  return [...partitions]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([copy, implementors]) => {
      const present = new Set(implementors.map((implementor) => implementor.declaration))
      const absent = [...declarations].filter((declaration) => !present.has(declaration)).sort()
      return { ...family, implementors, copy, ...(absent.length > 0 ? { copyAbsentFrom: absent } : {}) }
    })
}

/**
 * A family rooted at a GENERIC class split into one family per copy of the
 * root's method that some implementor overrides, by heritage rather than by
 * convention -- or `null` when the root is not a generic's copies, or some
 * implementor's lineage cannot be followed, and `virtualCopyFamiliesOf`
 * partitions by convention as before.
 *
 * `Operation<TResult>.handleOk` is one body per class copy, and `Count extends
 * Command<number>` overrides the `number` copy only: it states `(reply) =>
 * number`, and a `RunCursorCommand` under `RunCommand<Document>` states
 * `(reply) => CursorReply` for the `Document` copy. Taken as one family, every
 * override had to convert into ONE root convention -- a number into a document
 * -- and the whole key was refused (mongodb's `AbstractOperation.handleOk`,
 * `CommandOperation.buildCommandDocument`). An override's convention need not
 * equal its copy's, only convert to it, which the verdict checks as for any
 * family. A copy of the root whose body is dead (`dead-method-copies.ts`) is
 * the family's bodyless root, exactly as an abstract one is; copies whose
 * conventions coincide are one member, as in `virtualCopyFamiliesOf`.
 */
const classCopyFamiliesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  family: VirtualMethodFamily,
  abiOf: (callable: FunctionId) => CallableAbi | null
): readonly VirtualMethodFamily[] | null => {
  const rootLayout = classes.get(family.root)
  const rootCopies = new Set(rootLayout?.copies ?? [])
  if (rootCopies.size < 2) return null
  const methodOf = (declaration: DeclarationId, callable: FunctionId): ClassMethod | undefined =>
    classes.get(declaration)?.methods.find((method) => method.key === family.key && method.callable === callable)
  const layoutHolding = (id: DeclarationId): ClassLayout | undefined =>
    classes.get(id) ?? [...classes.values()].find((layout) => layout.copies?.includes(id) === true)
  // The root copy an implementor's body replaces: its own copy of the class,
  // then each heritage link up to a copy of the root.
  const rootCopyOf = (implementor: VirtualMethodImplementor): DeclarationId | null => {
    const published = methodOf(implementor.declaration, implementor.callable)?.publishedBy
    if (implementor.declaration === family.root) return published !== undefined && rootCopies.has(published) ? published : null
    let current: DeclarationId = published ?? implementor.declaration
    for (let depth = 0; depth < 32; depth += 1) {
      const layout = layoutHolding(current)
      if (layout === undefined) return null
      const next = layout.baseCopies?.get(current) ?? layout.base
      if (next === null) return null
      if (rootCopies.has(next)) return next
      if (next === family.root) return null
      current = next
    }
    return null
  }
  const byCopy = new Map<DeclarationId, VirtualMethodImplementor[]>()
  for (const implementor of family.implementors) {
    const copy = rootCopyOf(implementor)
    if (copy === null) return null
    const members = byCopy.get(copy) ?? []
    members.push(implementor)
    byCopy.set(copy, members)
  }
  if (byCopy.size < 2) return null
  // One member per convention: the root copy's own body states it, else the
  // widest override (the rule `virtualDispatchVerdictOf` borrows by).
  const byConvention = new Map<string, VirtualMethodImplementor[]>()
  const statedBy = new Map<string, { readonly abi: CallableAbi; readonly borrowed: boolean }>()
  for (const implementors of byCopy.values()) {
    const own = implementors.find((implementor) => implementor.declaration === family.root)
    const stating =
      own ??
      implementors.reduce((widest, implementor) =>
        (abiOf(implementor.callable)?.parameters.length ?? -1) > (abiOf(widest.callable)?.parameters.length ?? -1) ? implementor : widest
      )
    const abi = abiOf(stating.callable)
    if (abi === null) return null
    const convention = virtualCopyKeyOf(abi)
    const members = byConvention.get(convention) ?? []
    for (const implementor of implementors)
      if (!members.some((member) => member.declaration === implementor.declaration)) members.push(implementor)
    byConvention.set(convention, members)
    const previous = statedBy.get(convention)
    statedBy.set(convention, { abi, borrowed: own === undefined && (previous?.borrowed ?? true) })
  }
  // A bodyless root copy whose every override leaves out trailing parameters
  // (mongodb's `FindOperation.buildCommandDocument()` against the abstract
  // `(connection, session?)`) borrowed a convention NO call site holds: a
  // read's held convention is the checker's signature of the DECLARATION, so
  // `this.buildCommandDocument(connection, session)` looks up the wider one --
  // the sibling copy's, with the same result -- and dispatched every override
  // of the narrow copy to that copy's abstract stub. Such a borrowed
  // convention is folded into the one wider convention it is a parameter
  // prefix of with the same result: the members of both copies are then one
  // slot, and an override with fewer parameters ignores the rest, as the
  // language does (the adapter passes only the formals it declares).
  // `narrow` is a parameter prefix of `wide`, with the same rest and result.
  const extendsConvention = (narrow: CallableAbi, wide: CallableAbi): boolean =>
    sameRestPartition(wide, narrow) &&
    wide.parameters.length > narrow.parameters.length &&
    narrow.parameters.every(
      (parameter, index) => representationKey(parameter.value) === representationKey(wide.parameters[index]!.value)
    ) &&
    representationKey(wide.result) === representationKey(narrow.result)
  // Narrowest first, so a chain of borrowed prefixes folds into its widest
  // end; the widest candidate is taken only when every other candidate is
  // itself a prefix of it (one declaration, not two diverging ones).
  const byWidth = [...statedBy].sort(([, left], [, right]) => left.abi.parameters.length - right.abi.parameters.length)
  for (const [convention, stated] of byWidth) {
    if (!stated.borrowed || !statedBy.has(convention)) continue
    const wider = [...statedBy].filter(([other, candidate]) => other !== convention && extendsConvention(stated.abi, candidate.abi))
    if (wider.length === 0) continue
    const widest = wider.reduce((best, entry) => (entry[1].abi.parameters.length > best[1].abi.parameters.length ? entry : best))
    if (!wider.every((entry) => entry === widest || extendsConvention(entry[1].abi, widest[1].abi))) continue
    const [target] = widest
    const members = byConvention.get(target)!
    for (const implementor of byConvention.get(convention) ?? [])
      if (!members.some((member) => member.declaration === implementor.declaration)) members.push(implementor)
    byConvention.delete(convention)
    statedBy.delete(convention)
  }
  return [...byConvention]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([copy, implementors]) => ({
      ...family,
      implementors,
      copy,
      abstractRoot: !implementors.some((implementor) => implementor.declaration === family.root)
    }))
}

/** One family `virtualDispatchVerdictOf` proved dispatchable: the topology (`virtualMethodFamiliesOf`'s answer) plus the ABI every implementor was proven to convert to. */
export interface VirtualFamilyVerdict {
  readonly family: VirtualMethodFamily
  readonly rootAbi: CallableAbi
  /** Every selected receiver, parameter and result adapter avoids native field protocols. */
  readonly nativeFieldProtocol?: 'unused'
  /**
   * The adapter conversions that DO reach a native field protocol -- a class
   * instance an override answers, viewed as the root's open `Document`, say.
   * Adapters are generated code, not IR operations, so the reflection census
   * (`ir/reflection-demand.ts`) never meets them in a body; it reads them here
   * instead, or the view would be asked of an object that has no protocol.
   */
  readonly protocolBoundaries?: readonly { readonly source: Representation; readonly target: Representation }[]
}

/** One family `virtualDispatchVerdictOf` refused, and why. */
export interface VirtualFamilyRefusal {
  readonly key: string
  readonly role: VirtualMemberRole
  readonly owner: DeclarationId
  readonly reason: string
}

export interface VirtualDispatchVerdict {
  readonly families: readonly VirtualFamilyVerdict[]
  readonly refused: readonly VirtualFamilyRefusal[]
  /**
   * Every class-key-role a receiver ANYWHERE in a dispatchable family's
   * subtree resolves to, expanded from `families` the way a call site looks
   * a member up: a class between the root and an implementor inherits the
   * member, so the whole subtree -- not only the implementors -- is
   * dispatchable through it. Keyed by `virtualDispatchKey`.
   */
  readonly dispatched: ReadonlyMap<string, VirtualFamilyVerdict>
}

/**
 * Whether `source`'s class-ref carrier can reach `target`'s -- an upcast to
 * an ancestor (or itself), or a runtime-checked downcast to a descendant
 * with at least one other concrete class in the program to distinguish it
 * from. Mirrors `targets/cpp/virtual-methods.ts`'s old `classRefConversionText`'s
 * null-vs-text branching, minus the text: virtual dispatch's receiver/
 * argument adaptation is a C++ mechanism with no ECMAScript-level conversion
 * behind it, so this stays a standalone structural test rather than a
 * `ConversionCensus` entry.
 */
const classRefConvertible = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  source: Extract<Representation, { kind: 'class-ref' }>,
  target: Extract<Representation, { kind: 'class-ref' }>
): boolean => {
  if (source.ownership !== 'shared-refcount' || target.ownership !== 'shared-refcount') return false
  if (source.declaration === target.declaration || extendsClass(classes, source.declaration, target.declaration)) return true
  if (!extendsClass(classes, target.declaration, source.declaration)) return false
  return [...classes.keys()].some(
    (declaration) => declaration === target.declaration || extendsClass(classes, declaration, target.declaration)
  )
}

/**
 * Whether an OMITTED argument -- an implementor with more formals than the
 * family's root convention supplies -- can be represented at all.
 *
 * Mirrors `targets/cpp/types.ts`'s `cppUndefinedIn` EXISTENCE check (which
 * kinds admit an `undefined` value) without any of its C++ text: the verdict
 * only needs to know an omitted value CAN be carried, never what its spelling
 * is, so duplicating the shape test here -- rather than threading a text
 * builder into a projection-level module -- is the one part of that function
 * safe to restate.
 */
const admitsUndefined = (representation: Representation): boolean => {
  if (representation.kind === 'undefined' || representation.kind === 'dynamic') return true
  if (representation.kind === 'optional' && representation.absence === 'undefined') return true
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => arm.value.kind === 'undefined')
  return false
}

/**
 * One parameter/receiver/result conversion a virtual member adapter needs,
 * decided generically: class-ref pairs by the structural rule above,
 * everything else by asking the SAME conversion census the printer's own
 * `alignedValueText` consults (`emit-narrowing.ts`), so this can never
 * approve a pair the printer would refuse.
 */
const virtualValueConvertible = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  source: Representation,
  target: Representation
): boolean => {
  if (source.kind === 'class-ref' && target.kind === 'class-ref') return classRefConvertible(classes, source, target)
  return conversions.nodeFor(source, target).capability.kind !== 'never'
}

const virtualValueUsesNoFields = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  source: Representation,
  target: Representation
): boolean => {
  if (source.kind === 'class-ref' && target.kind === 'class-ref') return classRefConvertible(classes, source, target)
  const capability = conversions.nodeFor(source, target).capability
  return (
    capability.kind === 'identity' ||
    ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
      capability.materializer.nativeFieldProtocol === 'unused')
  )
}

/**
 * The nearest class every implementor's `class-ref` result upcasts to, as that
 * class's own instance carrier -- or `null` when some result is not a
 * shared class-ref, or the results share no ancestor in the program.
 */
const joinedClassResultOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  implementors: readonly VirtualMethodImplementor[],
  abiOf: (callable: FunctionId) => CallableAbi | null
): Representation | null => {
  const declarations: DeclarationId[] = []
  for (const implementor of implementors) {
    const result = abiOf(implementor.callable)?.result
    if (result === undefined || result.kind !== 'class-ref' || result.ownership !== 'shared-refcount') return null
    declarations.push(result.declaration)
  }
  const [first, ...rest] = declarations
  if (first === undefined) return null
  const walked = new Set<DeclarationId>()
  for (
    let candidate: DeclarationId | null = first;
    candidate !== null && !walked.has(candidate);
    candidate = classes.get(candidate)?.base ?? null
  ) {
    walked.add(candidate)
    const joined = candidate
    if (!rest.every((declaration) => declaration === joined || extendsClass(classes, declaration, joined))) continue
    const instance = classes.get(joined)?.instance ?? null
    return instance !== null && instance.kind === 'class-ref' && instance.ownership === 'shared-refcount' ? instance : null
  }
  return null
}

/**
 * The carrier one position of a family's slot takes when the implementors
 * that declare it disagree: one of their own carriers that every other
 * converts to and back from -- the caller converts into the slot, the adapter
 * out of it into each implementor. Only static carriers join: `dynamic` would
 * box every statically typed argument. `null` keeps the root's convention,
 * which the implementor that does not fit then refuses.
 *
 * That holds even where every declarer carries the same `dynamic` (three's
 * `updateReference( state )`, `@param {any}` on each override): the caller's
 * conversion into the slot is printed at the call site, outside every IR body,
 * so the reflection census never sees the class instance it boxes and the
 * box reaches the override with no field dispatcher to read it through.
 * `joinedRootAbiOf` carries such a box only where the program's calls are
 * known, so the verdict can hand the census each one.
 */
const joinedParameterOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  values: readonly Representation[]
): Representation | null => {
  if (values.some((value) => value.kind === 'dynamic' || value.kind === 'void' || value.kind === 'unresolved')) return null
  const fits = (candidate: Representation): boolean =>
    values.every(
      (value) =>
        virtualValueConvertible(classes, conversions, value, candidate) && virtualValueConvertible(classes, conversions, candidate, value)
    )
  return values.find(fits) ?? null
}

/**
 * The argument lists the program's own calls hand each virtual member, keyed
 * by `virtualDispatchKey(receiverClass, key, 'call')` of the read the call
 * goes through -- one entry per call, `null` when some call there spreads its
 * arguments. A key with no entry has no call through its member.
 *
 * Published by `ir/virtual-member-calls.ts` from the same reads
 * `targets/cpp/direct-call-receivers.ts`'s `virtualCalleesOf` routes through
 * the member: a method value that escapes its read is selected at read time
 * and never reaches the slot. Absent altogether, nothing is known about any
 * call, and a slot position is carried exactly as the implementors' own
 * conventions allow.
 */
export type VirtualMemberCalls = ReadonlyMap<string, readonly (readonly Representation[])[] | null>

/**
 * Every call through `family`'s member, from a receiver of the root's class
 * or any class below it -- or `null` when that is not known.
 */
const familyCallsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  family: VirtualMethodFamily,
  calls: VirtualMemberCalls | undefined
): readonly (readonly Representation[])[] | null => {
  // A generic method's copies share the key, so a call does not say which
  // copy's member it went through.
  if (calls === undefined || family.role !== 'call' || family.copy !== undefined) return null
  const found: (readonly Representation[])[] = []
  for (const declaration of classes.keys()) {
    if (declaration !== family.root && !extendsClass(classes, declaration, family.root)) continue
    const entry = calls.get(virtualDispatchKey(declaration, family.key, 'call'))
    if (entry === undefined) continue
    if (entry === null) return null
    found.push(...entry)
  }
  return found
}

/**
 * The carrier a slot position takes from the arguments the program's calls
 * actually pass there, when the implementors' own carriers do not join (three's
 * `updateReference( state )`, `@param {any}` on every override, called as
 * `node.updateReference( this )` with a `NodeFrame`).
 *
 * The call site converts into the slot outside every IR body, where the
 * reflection census cannot see it, so it must never box, and never test either:
 * the candidate is a static carrier every passed argument WIDENS to -- the
 * same carrier, an ancestor class's, or an optional of one -- so the
 * conversion cannot fail where the language's call could not. The adapter then converts
 * it into each implementor's own formal -- a box there is a protocol boundary
 * the census does read (`VirtualFamilyVerdict.protocolBoundaries`). A call
 * that omits the position binds `undefined`, so the slot carries it optional
 * and every implementor's formal must hold `undefined` too.
 */
const passedCarrierOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  passed: readonly Representation[],
  omitted: boolean,
  declared: readonly Representation[]
): Representation | null => {
  const opaque = (value: Representation): boolean => value.kind === 'dynamic' || value.kind === 'void' || value.kind === 'unresolved'
  if (passed.length === 0 || passed.some(opaque)) return null
  if (omitted && !declared.every(admitsUndefined)) return null
  const widens = (value: Representation, target: Representation): boolean => {
    if (representationKey(value) === representationKey(target)) return true
    if (value.kind === 'class-ref' && target.kind === 'class-ref')
      return (
        value.ownership === 'shared-refcount' &&
        target.ownership === 'shared-refcount' &&
        extendsClass(classes, value.declaration, target.declaration)
      )
    // Injection into a declared union's arm (three's `@param
    // {(NodeFrame|NodeBuilder)} state`, passed a `NodeFrame`) -- but only into
    // exactly one: a value two arms could take would leave the arm to a guess.
    if (target.kind === 'tagged-union') return target.arms.filter((arm) => widens(value, arm.value)).length === 1
    return target.kind === 'optional' && target.absence === 'undefined' && (value.kind === 'undefined' || widens(value, target.payload))
  }
  for (const candidate of [...passed, ...declared]) {
    if (opaque(candidate)) continue
    if (!passed.every((value) => widens(value, candidate))) continue
    const carried = omitted ? optionalOf(candidate, 'undefined') : candidate
    if (carried === null || carried.kind === 'unresolved') continue
    if (declared.every((value) => virtualValueConvertible(classes, conversions, carried, value))) return carried
  }
  return null
}

/**
 * The parameters of a concrete root's slot, joined with its overrides'
 * (ECMA-262 10.2.11): the root's own, then every position an override
 * declares beyond them.
 *
 * A caller typed as the root still passes the arguments an override reads
 * (`nodeObject.updateReference( this )` against `Node.updateReference()`); a
 * slot that stopped at the root's formals dropped them and ran the override
 * with `undefined`. A position past the root's formals is bound to
 * `undefined` when the call omits it, so its carrier is the implementors'
 * join made optional -- a static carrier, never the box.
 *
 * The result is not joined here. A call publishes the result of the member it
 * reads, which is the root's own body, so a slot answering a wider join would
 * be read back through a narrowing that the overrides it was widened for
 * always fail; an implementation whose result does not convert to the root's
 * keeps the family refused, by name.
 */
const joinedRootAbiOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions: ConversionCensus,
  root: CallableAbi,
  implementors: readonly VirtualMethodImplementor[],
  abiOf: (callable: FunctionId) => CallableAbi | null,
  calls: readonly (readonly Representation[])[] | null
): CallableAbi => {
  const abis = implementors.map((implementor) => abiOf(implementor.callable))
  if (root.restFrom !== null || abis.some((abi) => abi === null || abi.restFrom !== null)) return root
  const declared = abis.filter((abi): abi is CallableAbi => abi !== null)
  const width = Math.max(root.parameters.length, ...declared.map((abi) => abi.parameters.length))
  if (width === root.parameters.length) return root
  const parameters = [...root.parameters]
  for (let position = root.parameters.length; position < width; position++) {
    const values = declared.flatMap((abi) => {
      const parameter = abi.parameters[position]
      return parameter === undefined ? [] : [parameter.value]
    })
    // A call through the root's type may omit the argument, and each
    // implementation then receives `undefined`; one whose own formal cannot
    // hold it keeps the root's convention and is refused for it below, rather
    // than unwrapping an absent optional into that formal.
    const joined = values.every(admitsUndefined) ? joinedParameterOf(classes, conversions, values) : null
    const optional = joined === null ? null : optionalOf(joined, 'undefined')
    // Where the implementors' own carriers do not join, the calls the program
    // makes decide: a position no call passes needs no carrier (the slot ends
    // before it, and every later one, since a call omitting it omits them
    // too), and one some call passes takes the arguments' own carrier.
    const passed = calls?.flatMap((call) => (call.length > position ? [call[position]!] : [])) ?? null
    if (optional === null && passed !== null && passed.length === 0) break
    // Every implementor that declares the position holds the same box (three's
    // `VarNode.getArrayCount( builder )`, untagged, against a root with no
    // formal): the slot carries that box, so each call converts into it as a
    // direct call to the override would. That conversion is printed at the call
    // site, outside every IR body, so the verdict hands each passed carrier to
    // the census as a protocol boundary -- which is why the calls must be known.
    const box = values[0]
    if (
      optional === null &&
      box !== undefined &&
      box.kind === 'dynamic' &&
      admitsUndefined(box) &&
      values.every((value) => representationKey(value) === representationKey(box)) &&
      passed !== null &&
      passed.every(
        (value) => value.kind !== 'void' && value.kind !== 'unresolved' && virtualValueConvertible(classes, conversions, value, box)
      )
    ) {
      const declarer = declared.find((abi) => abi.parameters[position] !== undefined)!.parameters[position]!
      parameters.push(declarer)
      continue
    }
    const value =
      optional ??
      (calls === null || passed === null
        ? null
        : passedCarrierOf(
            classes,
            conversions,
            passed,
            calls.some((call) => call.length <= position),
            values
          ))
    if (value === null || value.kind === 'unresolved') return root
    // A carrier that names its own ownership (a class handle) is passed as it
    // is held; `owned` would spell the struct itself by value.
    const ownership = optional === null && 'ownership' in value ? value.ownership : 'owned'
    parameters.push({ value, ownership, passing: passingOf(value, ownership) })
  }
  return { ...root, parameters }
}

/**
 * The slot of a family whose root answers with its own data field: the
 * accessors' convention, with the field's stored carrier where the value
 * passes. A read converts from it to what the read publishes, as a load of the
 * field does, and a write converts into it as a store does, so every accessor
 * converts to the field rather than the field to one accessor -- the getter's
 * result must be one the field can hold.
 */
const fieldSlotAbiOf = (field: ClassField, role: VirtualMemberRole, accessors: CallableAbi | null): CallableAbi | null => {
  const stored = field.representation
  if (stored === null || stored.kind === 'unresolved' || accessors === null) return null
  if (role === 'get') return { ...accessors, result: stored }
  const ownership = 'ownership' in stored ? stored.ownership : 'owned'
  return { ...accessors, parameters: [{ value: stored, ownership, passing: passingOf(stored, ownership) }] }
}

/**
 * The dispatchability verdict for every override family: whether it can be
 * dispatched through a C++ virtual member at all, and the exact convention
 * (`rootAbi`) every call site converts to when it can.
 *
 * `abiOf` answers with the convention a body was compiled under, which is the
 * one authority on its formals -- deriving them here a second way is the
 * two-authorities shape that produces a member the definition cannot match. A
 * family whose implementors disagree on that convention, or one whose body
 * captures an environment (a capturing body carries a formal no member can
 * supply), is REFUSED rather than approximated: a call site then declines the
 * direct bind too, so the program never silently runs the base's body.
 *
 * `capturesNothing` is asked directly of `IrBody.facts` by the caller (see
 * `ir/captures.ts`'s `IrBodyFacts.capturedDeclarations`/`.capturedReceiver`)
 * -- not of a render-time `CaptureIndex` admission, which only ever answers
 * for a body some `allocate-callable` operation names, and a plain instance
 * method almost never is one.
 */
export const virtualDispatchVerdictOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  conversions: ConversionCensus,
  memberCalls?: VirtualMemberCalls
): VirtualDispatchVerdict => {
  const families: VirtualFamilyVerdict[] = []
  const refused: VirtualFamilyRefusal[] = []

  for (const family of virtualMethodFamiliesOf(classes).flatMap((whole) => virtualCopyFamiliesOf(classes, whole, abiOf))) {
    const rootImplementor = family.implementors.find((implementor) => implementor.declaration === family.root)
    // An ABSTRACT root has no body, and therefore no ABI of its own to state
    // the slot's convention with. Every override is checked against the same
    // declared signature, so any implementor's convention IS that slot's --
    // taking the first in the family's own deterministic order keeps the
    // choice reproducible; the per-implementor loop below still proves every
    // other implementor converts to it rather than assuming they agree.
    //
    // The WIDEST implementor, though: an override may leave out trailing
    // parameters it does not read (mongodb's `AggregateOperation`
    // `buildCommandDocument()` against the abstract `(connection, session?)`),
    // and borrowing that one's empty list made every sibling that does read
    // `connection` look like it was called without it. An implementor with
    // fewer parameters simply ignores the rest, as the language does.
    const borrowed =
      family.implementors
        .map((implementor) => abiOf(implementor.callable))
        .reduce<CallableAbi | null>(
          (widest, abi) => (abi !== null && (widest === null || abi.parameters.length > widest.parameters.length) ? abi : widest),
          null
        ) ?? null
    // The borrowed convention states the PARAMETERS and RESULT of the slot,
    // never its receiver: an implementor's receiver is its own concrete class,
    // and a call site converting `Ref<Rule>` to it downcast every element of
    // `Rule[]` to whichever subclass happened to be borrowed. The slot's
    // receiver is the root's.
    const rootInstance = classes.get(family.root)?.instance ?? null
    // Nor its result, when that is a class the borrowed implementor narrowed to
    // itself: `abstract addToOperationsList(...): this` (mongodb's bulk writers)
    // and `abstract refreshed(): TimeoutContext` both come back from each
    // override as the override's OWN class, so borrowing one sibling's result
    // made every other sibling's "convert" to it a cast between unrelated
    // classes, and the whole family was refused. The slot answers the classes'
    // join -- every implementor's result upcasts to it.
    const borrowedResult = borrowed === null ? null : joinedClassResultOf(classes, family.implementors, abiOf)
    const inheritedAbi =
      borrowed === null || rootInstance === null
        ? null
        : { ...borrowed, receiver: rootInstance, ...(borrowedResult ? { result: borrowedResult } : {}) }
    const ownRootAbi = rootImplementor ? abiOf(rootImplementor.callable) : null
    const calls = familyCallsOf(classes, family, memberCalls)
    const rootAbi =
      family.rootField !== undefined
        ? fieldSlotAbiOf(family.rootField, family.role, inheritedAbi)
        : ownRootAbi !== null
          ? joinedRootAbiOf(classes, conversions, ownRootAbi, family.implementors, abiOf, calls)
          : family.abstractRoot
            ? inheritedAbi
            : null
    if (family.halfAbsentFrom !== undefined) {
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason: `the accessor replacing data field ${family.root}.${family.key} in ${family.halfAbsentFrom.join(', ')} has no ${family.role === 'get' ? 'getter' : 'setter'}`
      })
      continue
    }
    if (family.rootField !== undefined && rootAbi === null) {
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason: `data field ${family.root}.${family.key}, which descendants replace with an accessor, publishes no carrier for the dispatch member`
      })
      continue
    }
    if (family.copyAbsentFrom !== undefined) {
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason: `the copy of this generic method at ${family.copy} has no body in ${family.copyAbsentFrom.join(', ')}, which redeclare it`
      })
      continue
    }
    const capturing = family.implementors.filter((implementor) => !capturesNothing(implementor.callable))
    if (rootAbi === null || capturing.length > 0) {
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason:
          rootAbi === null
            ? 'the class that roots the family names no body to dispatch to'
            : `these implementations capture an environment, which a member function has no formal to carry: ${capturing.map((implementor) => implementor.declaration).join(', ')}`
      })
      continue
    }

    let incompatible: string | null = null
    let nativeFieldProtocolUnused = true
    const protocolBoundaries: { readonly source: Representation; readonly target: Representation }[] = []
    const observeProtocol = (source: Representation, target: Representation): void => {
      if (virtualValueUsesNoFields(classes, conversions, source, target)) return
      nativeFieldProtocolUnused = false
      protocolBoundaries.push({ source, target })
    }
    // A position past the root's own formals is not in the checker's signature
    // of the member, so the lowering passes the argument as it is and the
    // printer converts it into the slot at the call -- a conversion no IR body
    // holds. The census reads it here, as it reads the adapter's.
    const ownWidth = ownRootAbi?.parameters.length ?? rootAbi.parameters.length
    for (const call of calls ?? []) {
      for (let position = ownWidth; position < Math.min(call.length, rootAbi.parameters.length); position++)
        observeProtocol(call[position]!, rootAbi.parameters[position]!.value)
    }
    for (const implementor of family.implementors) {
      const actualAbi = abiOf(implementor.callable)
      if (actualAbi === null) {
        incompatible = `implementation ${implementor.declaration} names no callable convention`
        break
      }
      if (actualAbi.receiver === null) {
        incompatible = `implementation ${implementor.declaration} declares no receiver`
        break
      }
      if (!sameRestPartition(rootAbi, actualAbi)) {
        incompatible =
          `implementation ${implementor.declaration} uses rest slot ${String(actualAbi.restFrom)}${actualAbi.argumentsFrame ? ' (every argument)' : ''}, ` +
          `while the family root uses ${String(rootAbi.restFrom)}${rootAbi.argumentsFrame ? ' (every argument)' : ''}; ` +
          'repartitioning an already-packed rest array is not installed'
        break
      }
      const instance = classes.get(implementor.declaration)?.instance
      if (instance === null || instance === undefined || instance.kind !== 'class-ref') {
        incompatible = `implementation ${implementor.declaration}'s class publishes no class-ref instance carrier`
        break
      }
      if (!virtualValueConvertible(classes, conversions, instance, actualAbi.receiver)) {
        incompatible = `implementation ${implementor.declaration}'s receiver cannot be converted to "${representationKey(actualAbi.receiver)}"`
        break
      }
      observeProtocol(instance, actualAbi.receiver)
      let parameterIncompatible: string | null = null
      for (const [position, parameter] of actualAbi.parameters.entries()) {
        const source = rootAbi.parameters[position]
        if (source !== undefined) {
          observeProtocol(source.value, parameter.value)
          if (!virtualValueConvertible(classes, conversions, source.value, parameter.value)) {
            parameterIncompatible =
              `implementation ${implementor.declaration}'s parameter ${position} expects "${representationKey(parameter.value)}", while the ` +
              `family member carries "${representationKey(source.value)}"`
          }
          continue
        }
        if (actualAbi.restFrom === position && parameter.value.kind === 'array-object') continue
        // A position the slot does not carry is one every call through the
        // family drops: the implementation runs with `undefined` there even
        // when the caller passed a value (`node.updateReference( this )`
        // against a root `updateReference()`). That is the language's own
        // answer only when no call passes it -- then the adapter supplies the
        // `undefined` the omitted argument binds, if the formal can hold it.
        const omittedByEveryCall = calls !== null && calls.every((call) => call.length <= position)
        if (omittedByEveryCall && admitsUndefined(parameter.value)) continue
        parameterIncompatible = admitsUndefined(parameter.value)
          ? `implementation ${implementor.declaration}'s extra parameter ${position} ("${representationKey(parameter.value)}") has no ` +
            "carrier in the family's slot, so an argument a call passes there would be dropped"
          : `implementation ${implementor.declaration}'s extra parameter ${position} is carried as "${representationKey(parameter.value)}", ` +
            'which cannot hold the undefined supplied by an omitted argument'
      }
      if (parameterIncompatible !== null) {
        incompatible = parameterIncompatible
        break
      }
      if (!virtualValueConvertible(classes, conversions, actualAbi.result, rootAbi.result)) {
        incompatible =
          `implementation ${implementor.declaration} returns "${representationKey(actualAbi.result)}", while family ${family.root}.${family.key} ` +
          `returns "${representationKey(rootAbi.result)}"`
        break
      }
      observeProtocol(actualAbi.result, rootAbi.result)
    }
    for (const { declaration, field } of incompatible === null ? (family.fieldImplementors ?? []) : []) {
      const stored = field.representation
      const written = rootAbi.parameters[0]?.value
      if (stored === null) incompatible = `field implementation ${declaration}.${family.key} publishes no carrier`
      else if (family.role === 'get') {
        if (!virtualValueConvertible(classes, conversions, stored, rootAbi.result))
          incompatible = `field implementation ${declaration}.${family.key} holds "${representationKey(stored)}", while the family returns "${representationKey(rootAbi.result)}"`
        else observeProtocol(stored, rootAbi.result)
      } else if (written === undefined || !virtualValueConvertible(classes, conversions, written, stored))
        incompatible = `field implementation ${declaration}.${family.key} holds "${representationKey(stored)}", which the family's written value cannot convert to`
      else observeProtocol(written, stored)
      if (incompatible !== null) break
    }
    if (incompatible !== null) {
      // The refusal surfaces downstream only as "needs dynamic dispatch" at
      // each read of the member; this names why the family has no member.
      const filter = process.env['GEA_VIRTUAL_FAMILY_DEBUG']
      if (filter !== undefined && (filter === '*' || filter === family.key)) {
        // What the slot's calls pass is what decided its length, so a refusal
        // over a formal the root leaves out is traced only with them.
        const passed =
          calls === null
            ? 'unknown'
            : calls.map((call) => `(${call.map((value) => representationKey(value)).join(', ')})`).join(' ') || 'none'
        console.error(`[VIRTUAL-FAMILY] ${family.root}.${family.key}: ${incompatible}; calls through the slot pass ${passed}`)
      }
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason: `the implementations need incompatible virtual member conventions: ${incompatible}`
      })
      continue
    }
    families.push({
      family,
      rootAbi,
      ...(nativeFieldProtocolUnused ? { nativeFieldProtocol: 'unused' as const } : { protocolBoundaries })
    })
  }

  const dispatched = new Map<string, VirtualFamilyVerdict>()
  for (const verdict of families) {
    const { root, key, role, copy } = verdict.family
    const keyOf = (owner: DeclarationId): string =>
      copy === undefined ? virtualDispatchKey(owner, key, role) : virtualCopyDispatchKey(owner, key, copy)
    dispatched.set(keyOf(root), verdict)
    for (const [declaration] of classes) {
      if (extendsClass(classes, declaration, root)) dispatched.set(keyOf(declaration), verdict)
    }
  }

  return { families, refused, dispatched }
}
