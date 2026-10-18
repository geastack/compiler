import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import { numberStorageTarget, type NumberScalar } from './number-storage.js'
import type { ConversionCapability } from './algebra.js'

export const NATIVE_SUM_CLASSIFIER = 'gea::native-sum::live-alternative'
export const NATIVE_SUM_MATERIALIZER = 'gea::native-sum::inject-alternative'

type Sum = Extract<Representation, { kind: 'optional' | 'tagged-union' }>
export type NativeSumPlan =
  | { readonly kind: 'identity' }
  | { readonly kind: 'number-storage'; readonly target: NumberScalar }
  | { readonly kind: 'class-upcast'; readonly target: Extract<Representation, { kind: 'class-ref' } | { kind: 'native-record-ref' }> }
  | { readonly kind: 'null-reference'; readonly target: Extract<Representation, { kind: 'class-ref' }> }
  | { readonly kind: 'empty'; readonly target: Sum }
  | { readonly kind: 'wrap'; readonly target: Sum; readonly payload: NativeSumPlan; readonly index: number | null }
  | {
      readonly kind: 'optional'
      readonly target: Representation
      readonly absence: 'null' | 'undefined'
      readonly present: NativeSumPlan
      readonly absent: NativeSumPlan
    }
  | { readonly kind: 'dispatch'; readonly target: Representation; readonly arms: readonly NativeSumPlan[] }
  | {
      readonly kind: 'nullable-reference'
      readonly present: NativeSumPlan
      readonly absent: NativeSumPlan
      /** The native undefined sentinel has its own home; it is never the null branch. */
      readonly undefined: { readonly value: 'source' | 'undefined'; readonly plan: NativeSumPlan }
    }

const isSum = (value: Representation): value is Sum => value.kind === 'optional' || value.kind === 'tagged-union'

/**
 * A native sum widens only when EVERY source alternative has a home. Leaves
 * travel by carrier identity, native Number storage conversion, or the nominal
 * class upcast their own ancestry proves. It never boxes, narrows a sum,
 * changes a primitive's JS type, rebrands an absence, or reconstructs an
 * object. Capability admission and rendering share this complete mapping.
 */
// No memo: once `nativeSumPlan`'s leaf test has refused the impossible pairs,
// a large app asks under a million that may widen and repeats 3% of them, so a
// cache keyed by carrier pair held nearly a million entries to save almost
// nothing.
const absences: Readonly<Record<'null' | 'undefined', Representation>> = { null: { kind: 'null' }, undefined: { kind: 'undefined' } }
const plan = (source: Representation, target: Representation, sourcePresent = false): NativeSumPlan | null => {
  if (representationKey(source) === representationKey(target)) return { kind: 'identity' }
  // Ref<T> carries distinct null and native undefined states. A destination
  // that represents either separately must inspect it before wrapping T in
  // a present arm. Without an explicit undefined alternative, the admitted
  // native reference payload home still retains the source's sentinel.
  if (!sourcePresent && source.kind === 'class-ref' && source.ownership === 'shared-refcount' && isSum(target)) {
    const present = plan(source, target, true)
    const absent = present ? plan(absences.null, target, true) : null
    if (present && absent) {
      const undefinedHome = plan(absences.undefined, target, true)
      return {
        kind: 'nullable-reference',
        present,
        absent,
        undefined: undefinedHome === null ? { value: 'source', plan: present } : { value: 'undefined', plan: undefinedHome }
      }
    }
  }
  if (source.kind === 'optional') {
    const present = plan(source.payload, target)
    if (!present) return null
    const absent = plan(absences[source.absence], target)
    return present && absent ? { kind: 'optional', target, absence: source.absence, present, absent } : null
  }
  if (source.kind === 'tagged-union') {
    const arms: NativeSumPlan[] = []
    for (const arm of source.arms) {
      const converted = plan(arm.value, target)
      if (!converted) return null
      arms.push(converted)
    }
    return arms.length > 0 ? { kind: 'dispatch', target, arms } : null
  }
  const numberTarget = numberStorageTarget(source, target)
  if (numberTarget !== null) return { kind: 'number-storage', target: numberTarget }
  // A sum's leaf can still need the ordinary nominal widening a bare class
  // value already supports. `owner.child && owner.child.target` reads
  // two descendants of one base class on the evaluated arm and merges them
  // into the declared base-class arm beside null/undefined. Exact carrier-key
  // matching cannot find that home, but the source class names its complete
  // ancestry and ownership, so this is the same unambiguous upcast
  // `convertedValueText` performs for a bare Ref rather than a new coercion.
  if (
    source.kind === 'class-ref' &&
    target.kind === 'class-ref' &&
    source.ownership === target.ownership &&
    source.ancestors.includes(target.declaration)
  ) {
    return { kind: 'class-upcast', target }
  }
  // The same Ref<T> carrier used for T|null represents null by its empty
  // handle. This stores the null value; it neither constructs T nor changes
  // null into the enclosing optional's (possibly undefined) absence.
  if (source.kind === 'null' && target.kind === 'class-ref' && target.ownership === 'shared-refcount')
    return { kind: 'null-reference', target }
  if (target.kind === 'optional') {
    if (source.kind === target.absence) return { kind: 'empty', target }
    const payload = plan(source, target.payload, sourcePresent)
    return payload ? { kind: 'wrap', target, payload, index: null } : null
  }
  if (target.kind === 'tagged-union') {
    const index = armIndexOf(target)
    const exact = index.firstByKey.get(representationKey(source)) ?? -1
    if (exact >= 0) return { kind: 'wrap', target, payload: { kind: 'identity' }, index: exact }
    const candidates =
      source.kind === 'scalar' && source.domain === 'number' ? [...index.recursiveArms, ...index.numberArms] : index.recursiveArms
    const homes = candidates.flatMap((armIndex) => {
      const arm = target.arms[armIndex]
      if (arm === undefined) return []
      const payload = plan(source, arm.value, sourcePresent)
      return payload ? [{ kind: 'wrap' as const, target, payload, index: armIndex }] : []
    })
    // Null has no nominal object identity: all proven null homes store the
    // same JS value. Canonicalize its physical home in representation order,
    // after the exact null arm above. Non-null alternatives still require a
    // unique home; choosing an arbitrary base would lose their identity/tag.
    if (source.kind === 'null') return homes[0] ?? null
    // An ambiguous non-null alternative cannot be selected by declaration order.
    return homes.length === 1 ? (homes[0] ?? null) : null
  }
  return null
}

/**
 * A target union's arms, indexed once: the first arm under each carrier key,
 * and which arms can recursively receive a non-exact source leaf.
 *
 * `plan` above used to scan the arms twice per source value -- `findIndex`
 * by key, then a recursive `plan` against EVERY arm -- so a union-to-union
 * pair cost source arms times target arms. The recast loop asks this of every
 * pair of the plan's recastable carriers; on TypeScript's own compiler,
 * whose `Node` unions run past a hundred arms, a CPU profile of that stage was
 * 82% inside `representationKey`'s memo lookup from these two scans.
 *
 * `recursiveArms` is exact, not a heuristic: with the source known not to be a
 * sum (the `optional`/`tagged-union` source branches run first) and its key
 * matching no arm, `plan(source, arm.value)` can only succeed when `arm.value`
 * is an `optional` (wrap), a `tagged-union` (a nested home), a class-ref the
 * source class names as an ancestor, or another native storage width of a
 * Number. Number arms are asked only for numeric sources; an integer must not
 * be coerced into a string alternative just because it has no exact home.
 */
interface ArmIndex {
  readonly firstByKey: ReadonlyMap<string, number>
  /** Arms a non-exact leaf can recursively reach: nested sums or nominal class bases. */
  readonly recursiveArms: readonly number[]
  readonly numberArms: readonly number[]
}

const armIndexes = new WeakMap<Representation, ArmIndex>()

const armIndexOf = (union: Extract<Representation, { kind: 'tagged-union' }>): ArmIndex => {
  const remembered = armIndexes.get(union)
  if (remembered !== undefined) return remembered
  const firstByKey = new Map<string, number>()
  const recursiveArms: number[] = []
  const numberArms: number[] = []
  union.arms.forEach((arm, index) => {
    const key = representationKey(arm.value)
    if (!firstByKey.has(key)) firstByKey.set(key, index)
    if (isSum(arm.value) || arm.value.kind === 'class-ref') recursiveArms.push(index)
    if (arm.value.kind === 'scalar' && arm.value.domain === 'number') numberArms.push(index)
  })
  const built = { firstByKey, recursiveArms, numberArms }
  armIndexes.set(union, built)
  return built
}

/**
 * A class instance read as the intrinsic record its struct derives from in
 * place (`class-ref.nativeBase` -- `Error`): the same pointer upcast
 * `targets/cpp/class-ref-transport.ts` admits for a bare store, refused for a
 * family that answers one of the record's own members differently. A leaf
 * fact for callers selecting into that bare record; sum widening still finds
 * homes only by key or class ancestry, so no union gains a second candidate.
 */
export const nativeRecordBaseUpcastPlan = (source: Representation, target: Representation): NativeSumPlan | null =>
  source.kind === 'class-ref' &&
  target.kind === 'native-record-ref' &&
  source.nativeBase?.kind === 'native-record-ref' &&
  source.nativeBaseOverridden !== true &&
  source.ownership === target.ownership &&
  representationKey(source.nativeBase) === representationKey(target)
    ? { kind: 'class-upcast', target }
    : null

/**
 * Every place `plan` can house a source leaf, gathered from a target
 * sum once: the carriers it holds at any depth, its class arms, whether it
 * holds a Number, and its absences. A leaf finds a home only by exact key, a
 * nominal class base, Number storage, or an absence (`null` also in a shared
 * class handle), and every one of those homes is an arm somewhere in the
 * target, so a leaf none of these names can never be housed.
 */
interface SumHomes {
  readonly keys: ReadonlySet<string>
  readonly classes: readonly Extract<Representation, { kind: 'class-ref' }>[]
  readonly number: boolean
  readonly nullHome: boolean
  readonly undefinedHome: boolean
}
const sumHomes = new WeakMap<Representation, SumHomes>()
const sumHomesOf = (target: Sum): SumHomes => {
  const known = sumHomes.get(target)
  if (known !== undefined) return known
  const keys = new Set<string>()
  const classes: Extract<Representation, { kind: 'class-ref' }>[] = []
  let number = false
  let nullHome = false
  let undefinedHome = false
  const visit = (value: Representation): void => {
    if (value.kind === 'optional') {
      if (value.absence === 'null') nullHome = true
      else undefinedHome = true
      visit(value.payload)
      return
    }
    if (value.kind === 'tagged-union') {
      for (const arm of value.arms) visit(arm.value)
      return
    }
    keys.add(representationKey(value))
    if (value.kind === 'class-ref') {
      classes.push(value)
      if (value.ownership === 'shared-refcount') nullHome = true
    }
    if (value.kind === 'scalar' && value.domain === 'number') number = true
  }
  visit(target)
  const built = { keys, classes, number, nullHome, undefinedHome }
  sumHomes.set(target, built)
  return built
}
/** A source's leaves: what `plan` splits an optional or a union into. */
const sumLeaves = new WeakMap<Representation, readonly Representation[]>()
const sumLeavesOf = (source: Representation): readonly Representation[] => {
  const known = sumLeaves.get(source)
  if (known !== undefined) return known
  const leaves: Representation[] = []
  const visit = (value: Representation): void => {
    if (value.kind === 'optional') {
      visit(value.payload)
      leaves.push(absences[value.absence])
    } else if (value.kind === 'tagged-union') for (const arm of value.arms) visit(arm.value)
    else leaves.push(value)
  }
  visit(source)
  sumLeaves.set(source, leaves)
  return leaves
}
const mayHouse = (homes: SumHomes, leaf: Representation): boolean => {
  if (homes.keys.has(representationKey(leaf))) return true
  switch (leaf.kind) {
    case 'null':
      return homes.nullHome
    case 'undefined':
      return homes.undefinedHome
    case 'class-ref':
      return homes.classes.some((home) => home.ownership === leaf.ownership && leaf.ancestors.includes(home.declaration))
    case 'scalar':
      return leaf.domain === 'number' && homes.number
    default:
      return false
  }
}

// The recast and selection passes ask this of every carrier pair, and almost
// none can widen: on a large app 14.5 million questions, 90% of them refused.
// The leaf test answers those from two small per-carrier summaries, so only a
// pair that may widen reaches `plan` and its cache.
export const nativeSumPlan = (source: Representation, target: Representation): NativeSumPlan | null => {
  if (!isSum(target)) return null
  if (representationKey(source) !== representationKey(target)) {
    const homes = sumHomesOf(target)
    if (!sumLeavesOf(source).every((leaf) => mayHouse(homes, leaf))) return null
  }
  return plan(source, target)
}

export const nativeSumWidenable = (source: Representation, target: Representation): boolean => nativeSumPlan(source, target) !== null

/** Numeric casts stay field-free, but must not claim to merely wrap the original payload. */
export const nativeSumPreservesPayload = (step: NativeSumPlan): boolean => {
  switch (step.kind) {
    case 'number-storage':
      return false
    case 'wrap':
      return nativeSumPreservesPayload(step.payload)
    case 'optional':
      return nativeSumPreservesPayload(step.present) && nativeSumPreservesPayload(step.absent)
    case 'nullable-reference':
      return (
        nativeSumPreservesPayload(step.present) && nativeSumPreservesPayload(step.absent) && nativeSumPreservesPayload(step.undefined.plan)
      )
    case 'dispatch':
      return step.arms.every(nativeSumPreservesPayload)
    default:
      return true
  }
}

/** A declared dynamic value may already be an exact native sum payload. No other arm is read on that edge. */
export const nativeSumPayloadCapabilityMatches = (
  source: Representation,
  target: Representation,
  capability: ConversionCapability
): boolean => {
  const plan = nativeSumPlan(source, target)
  if (plan === null || !nativeSumPreservesPayload(plan) || capability.kind !== 'atom') return false
  const domain = `sum-widen:${representationKey(source)}->${representationKey(target)}`
  return (
    capability.classifier.id === NATIVE_SUM_CLASSIFIER &&
    capability.classifier.domain === domain &&
    capability.materializer.id === NATIVE_SUM_MATERIALIZER &&
    capability.materializer.domain === domain &&
    capability.materializer.nativeFieldProtocol === 'unused' &&
    capability.materializer.nativePayloadTransport === 'preserved' &&
    !capability.materializer.allocates
  )
}
