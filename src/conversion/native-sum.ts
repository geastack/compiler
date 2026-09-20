import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'

type Sum = Extract<Representation, { kind: 'optional' | 'tagged-union' }>
export type NativeSumPlan =
  | { readonly kind: 'identity' }
  | { readonly kind: 'class-upcast'; readonly target: Extract<Representation, { kind: 'class-ref' }> }
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
  | { readonly kind: 'nullable-reference'; readonly present: NativeSumPlan; readonly absent: NativeSumPlan }

const isSum = (value: Representation): value is Sum => value.kind === 'optional' || value.kind === 'tagged-union'

/**
 * A native sum widens only when EVERY source alternative has a home. Leaves
 * travel by exact carrier identity or the nominal class upcast their own
 * ancestry proves; this planner never boxes, narrows, coerces a primitive,
 * rebrands an absence, or reconstructs an object. It is shared by capability
 * admission and rendering so neither can claim a partial mapping.
 */
// Both carriers are immutable, and presence is the only extra input. Keep
// negative answers too: the graph asks many pairs sharing impossible leaves.
interface CachedPlans {
  ordinary?: NativeSumPlan | null
  present?: NativeSumPlan | null
}
const plans = new WeakMap<Representation, WeakMap<Representation, CachedPlans>>()
const absences: Readonly<Record<'null' | 'undefined', Representation>> = { null: { kind: 'null' }, undefined: { kind: 'undefined' } }
const plan = (source: Representation, target: Representation, sourcePresent = false): NativeSumPlan | null => {
  let targets = plans.get(source)
  if (!targets) plans.set(source, (targets = new WeakMap()))
  let states = targets.get(target)
  if (!states) targets.set(target, (states = {}))
  const key = sourcePresent ? 'present' : 'ordinary'
  const known = states[key]
  if (known !== undefined) return known
  const result = computePlan(source, target, sourcePresent)
  states[key] = result
  return result
}

const computePlan = (source: Representation, target: Representation, sourcePresent: boolean): NativeSumPlan | null => {
  if (representationKey(source) === representationKey(target)) return { kind: 'identity' }
  // Ref<T> also carries the collapsed T|null representation. A destination
  // that represents null separately, even under nested sums, must inspect
  // that state before wrapping T in a present arm.
  if (!sourcePresent && source.kind === 'class-ref' && source.ownership === 'shared-refcount' && isSum(target)) {
    const present = plan(source, target, true)
    const absent = present ? plan(absences.null, target, true) : null
    if (present && absent) return { kind: 'nullable-reference', present, absent }
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
  // A sum's leaf can still need the ordinary nominal widening a bare class
  // value already supports. Three's `light.shadow && light.shadow.map` reads
  // two WebGLRenderTarget descendants on the evaluated arm and merges them
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
    const homes = index.recursiveArms.flatMap((armIndex) => {
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
 * is an `optional` (wrap), a `tagged-union` (a nested home), or a class-ref the
 * source class names as an ancestor. So the arms it skips are exactly the arms
 * that would have answered `null`.
 */
interface ArmIndex {
  readonly firstByKey: ReadonlyMap<string, number>
  /** Arms a non-exact leaf can recursively reach: nested sums or nominal class bases. */
  readonly recursiveArms: readonly number[]
}

const armIndexes = new WeakMap<Representation, ArmIndex>()

const armIndexOf = (union: Extract<Representation, { kind: 'tagged-union' }>): ArmIndex => {
  const remembered = armIndexes.get(union)
  if (remembered !== undefined) return remembered
  const firstByKey = new Map<string, number>()
  const recursiveArms: number[] = []
  union.arms.forEach((arm, index) => {
    const key = representationKey(arm.value)
    if (!firstByKey.has(key)) firstByKey.set(key, index)
    if (isSum(arm.value) || arm.value.kind === 'class-ref') recursiveArms.push(index)
  })
  const built = { firstByKey, recursiveArms }
  armIndexes.set(union, built)
  return built
}

export const nativeSumPlan = (source: Representation, target: Representation): NativeSumPlan | null =>
  isSum(target) ? plan(source, target) : null

export const nativeSumWidenable = (source: Representation, target: Representation): boolean => nativeSumPlan(source, target) !== null
