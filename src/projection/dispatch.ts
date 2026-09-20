import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout, ClassMethod } from './classes.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
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
export const classFamilyOverridesOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): readonly DeclarationId[] => {
  const overriding: DeclarationId[] = []
  for (const [candidate, layout] of classes) {
    if (candidate === declaration) continue
    if (!layout.accessors.some((entry) => entry.key === key) && !layout.methods.some((entry) => entry.key === key)) continue
    if (extendsClass(classes, candidate, declaration)) overriding.push(candidate)
  }
  return overriding
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
}

export interface VirtualMethodImplementor {
  readonly declaration: DeclarationId
  readonly callable: FunctionId
}

/** The topmost class along `declaration`'s chain that declares `key` as a method. */
const rootDeclaring = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId, key: string): DeclarationId => {
  const walked = new Set<DeclarationId>()
  let root = declaration
  let current: DeclarationId | null = declaration
  while (current !== null && !walked.has(current)) {
    walked.add(current)
    const layout = classes.get(current)
    if (!layout) return root
    // Accessors alongside methods: `get label()` overridden by `get label()`
    // is the identical family question, and asking only about methods rooted
    // every override at its own class, which is no family at all.
    if (layout.methods.some((method: ClassMethod) => method.key === key) || layout.accessors.some((entry) => entry.key === key))
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
    { key: string; role: VirtualMemberRole; root: DeclarationId; rootDeclares: boolean; implementors: VirtualMethodImplementor[] }
  >()
  const record = (declaration: DeclarationId, key: string, role: VirtualMemberRole, callable: FunctionId | null): void => {
    const root = rootDeclaring(classes, declaration, key)
    const id = `${root} ${key} ${role}`
    const entry = byRoot.get(id) ?? { key, role, root, rootDeclares: false, implementors: [] }
    if (declaration === root) entry.rootDeclares = true
    if (callable !== null) entry.implementors.push({ declaration, callable })
    byRoot.set(id, entry)
  }
  for (const [declaration, layout] of classes) {
    for (const method of layout.methods) record(declaration, method.key, 'call', method.callable)
    for (const accessor of layout.accessors) {
      record(declaration, accessor.key, 'get', accessor.getter)
      record(declaration, accessor.key, 'set', accessor.setter)
    }
  }
  return [...byRoot.values()]
    .filter((entry) => entry.implementors.some((implementor) => implementor.declaration !== entry.root))
    .filter((entry) => entry.rootDeclares)
    .map((entry) => ({
      key: entry.key,
      role: entry.role,
      root: entry.root,
      abstractRoot: !entry.implementors.some((implementor) => implementor.declaration === entry.root),
      implementors: [...entry.implementors].sort((left, right) => (left.declaration < right.declaration ? -1 : 1))
    }))
    .sort((left, right) => (`${left.root} ${left.key} ${left.role}` < `${right.root} ${right.key} ${right.role}` ? -1 : 1))
}

/** The key a call site looks up: the class it resolved the member ON, plus the member. Moved here from `targets/cpp/virtual-methods.ts` (which still re-exports it) so `ir/call-dispatch.ts` can ask the identical question without importing a target module. */
export const virtualDispatchKey = (owner: DeclarationId, key: string, role: VirtualMemberRole = 'call'): string => `${owner} ${key} ${role}`

/** One family `virtualDispatchVerdictOf` proved dispatchable: the topology (`virtualMethodFamiliesOf`'s answer) plus the ABI every implementor was proven to convert to. */
export interface VirtualFamilyVerdict {
  readonly family: VirtualMethodFamily
  readonly rootAbi: CallableAbi
  /** Every selected receiver, parameter and result adapter avoids native field protocols. */
  readonly nativeFieldProtocol?: 'unused'
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
  conversions: ConversionCensus
): VirtualDispatchVerdict => {
  const families: VirtualFamilyVerdict[] = []
  const refused: VirtualFamilyRefusal[] = []

  for (const family of virtualMethodFamiliesOf(classes)) {
    const rootImplementor = family.implementors.find((implementor) => implementor.declaration === family.root)
    // An ABSTRACT root has no body, and therefore no ABI of its own to state
    // the slot's convention with. Every override is checked against the same
    // declared signature, so any implementor's convention IS that slot's --
    // taking the first in the family's own deterministic order keeps the
    // choice reproducible; the per-implementor loop below still proves every
    // other implementor converts to it rather than assuming they agree.
    const borrowed = family.implementors.map((implementor) => abiOf(implementor.callable)).find((abi) => abi !== null) ?? null
    // The borrowed convention states the PARAMETERS and RESULT of the slot,
    // never its receiver: an implementor's receiver is its own concrete class,
    // and a call site converting `Ref<Rule>` to it downcast every element of
    // `Rule[]` to whichever subclass happened to be borrowed. The slot's
    // receiver is the root's.
    const rootInstance = classes.get(family.root)?.instance ?? null
    const inheritedAbi = borrowed === null || rootInstance === null ? null : { ...borrowed, receiver: rootInstance }
    const rootAbi = (rootImplementor ? abiOf(rootImplementor.callable) : null) ?? (family.abstractRoot ? inheritedAbi : null)
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
      if (rootAbi.restFrom !== actualAbi.restFrom) {
        incompatible =
          `implementation ${implementor.declaration} uses rest slot ${String(actualAbi.restFrom)}, while the family root uses ` +
          `${String(rootAbi.restFrom)}; repartitioning an already-packed rest array is not installed`
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
      nativeFieldProtocolUnused &&= virtualValueUsesNoFields(classes, conversions, instance, actualAbi.receiver)
      let parameterIncompatible: string | null = null
      for (const [position, parameter] of actualAbi.parameters.entries()) {
        const source = rootAbi.parameters[position]
        if (source !== undefined) {
          nativeFieldProtocolUnused &&= virtualValueUsesNoFields(classes, conversions, source.value, parameter.value)
          if (!virtualValueConvertible(classes, conversions, source.value, parameter.value)) {
            parameterIncompatible =
              `implementation ${implementor.declaration}'s parameter ${position} expects "${representationKey(parameter.value)}", while the ` +
              `family member carries "${representationKey(source.value)}"`
          }
          continue
        }
        if (actualAbi.restFrom === position && parameter.value.kind === 'array-object') continue
        if (!admitsUndefined(parameter.value)) {
          parameterIncompatible =
            `implementation ${implementor.declaration}'s extra parameter ${position} is carried as "${representationKey(parameter.value)}", ` +
            'which cannot hold the undefined supplied by an omitted argument'
        }
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
      nativeFieldProtocolUnused &&= virtualValueUsesNoFields(classes, conversions, actualAbi.result, rootAbi.result)
    }
    if (incompatible !== null) {
      refused.push({
        key: family.key,
        role: family.role,
        owner: family.root,
        reason: `the implementations need incompatible virtual member conventions: ${incompatible}`
      })
      continue
    }
    families.push({ family, rootAbi, ...(nativeFieldProtocolUnused ? { nativeFieldProtocol: 'unused' as const } : {}) })
  }

  const dispatched = new Map<string, VirtualFamilyVerdict>()
  for (const verdict of families) {
    dispatched.set(virtualDispatchKey(verdict.family.root, verdict.family.key, verdict.family.role), verdict)
    for (const [declaration] of classes) {
      if (extendsClass(classes, declaration, verdict.family.root)) {
        dispatched.set(virtualDispatchKey(declaration, verdict.family.key, verdict.family.role), verdict)
      }
    }
  }

  return { families, refused, dispatched }
}
