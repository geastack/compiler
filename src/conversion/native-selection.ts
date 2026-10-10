import type { Representation } from '../representation/model.js'
import { abiKey, representationKey } from '../representation/model.js'
import { nativeRecordBaseUpcastPlan, nativeSumPlan, nativeSumPreservesPayload, type NativeSumPlan } from './native-sum.js'

export type NativeSelectionStep =
  | { readonly kind: 'identity' }
  | { readonly kind: 'null' }
  | { readonly kind: 'reference-null'; readonly absent: NativeSelectionStep | null; readonly undefined?: NativeSelectionStep }
  | { readonly kind: 'transfer'; readonly plan: NativeSumPlan }
  | { readonly kind: 'class-cast'; readonly target: Extract<Representation, { kind: 'class-ref' }>; readonly down: boolean }
  | {
      readonly kind: 'optional'
      readonly absence: 'null' | 'undefined'
      readonly present: NativeSelectionStep | null
      readonly absent: NativeSelectionStep | null
    }
  | { readonly kind: 'dispatch'; readonly arms: readonly (NativeSelectionStep | null)[] }

/** A sealed selection uses only native tags, payload loads and nominal handle casts. */
export interface NativeSelectionRecipe {
  readonly source: string
  readonly target: string
  readonly step: NativeSelectionStep
}

type Selection = NativeSelectionStep | 'disjoint' | 'unknown'

/**
 * These carriers have distinct native runtime categories. A structural object,
 * host handle or dynamic value cannot be excluded merely because its carrier
 * key differs: it might require a view, host conversion or checked unbox.
 */
const categoryOf = (value: Representation): string | null => {
  switch (value.kind) {
    case 'scalar':
      return value.domain
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'class-ref':
    case 'array-object':
    case 'typed-array':
      return value.kind
    default:
      return null
  }
}

const disjoint = (source: Representation, target: Representation, sourcePresent = false): boolean => {
  if (target.kind === 'optional')
    return disjoint(source, target.payload, sourcePresent) && disjoint(source, { kind: target.absence }, sourcePresent)
  if (target.kind === 'tagged-union') return target.arms.every((arm) => disjoint(source, arm.value, sourcePresent))
  if (source.kind === 'class-ref' && target.kind === 'class-ref')
    return (
      source.declaration !== target.declaration &&
      !source.ancestors.includes(target.declaration) &&
      !target.ancestors.includes(source.declaration)
    )
  // A shared class handle can carry the collapsed class|null representation.
  if (source.kind === 'class-ref' && target.kind === 'null') return sourcePresent
  if (source.kind === 'null' && target.kind === 'class-ref') return false
  const from = categoryOf(source)
  const to = categoryOf(target)
  return from !== null && to !== null && from !== to
}

const select = (source: Representation, target: Representation): Selection => {
  if (representationKey(source) === representationKey(target)) return { kind: 'identity' }
  const transfer = nativeSumPlan(source, target)
  if (transfer) return { kind: 'transfer', plan: transfer }
  if (source.kind === 'optional') {
    const present = select(source.payload, target)
    const absent = select({ kind: source.absence }, target)
    if (present === 'unknown' || absent === 'unknown') return 'unknown'
    if (present === 'disjoint' && absent === 'disjoint') return 'disjoint'
    return {
      kind: 'optional',
      absence: source.absence,
      present: present === 'disjoint' ? null : present,
      absent: absent === 'disjoint' ? null : absent
    }
  }
  if (source.kind === 'tagged-union') {
    const arms = source.arms.map((arm) => select(arm.value, target))
    if (arms.includes('unknown')) return 'unknown'
    if (arms.every((arm) => arm === 'disjoint')) return 'disjoint'
    return { kind: 'dispatch', arms: arms.map((arm) => (typeof arm === 'string' ? null : arm)) }
  }
  if (source.kind === 'class-ref' && target.kind === 'class-ref' && source.ownership === target.ownership) {
    // Shape aliases do not mint a new class allocation or C++ class type.
    if (source.declaration === target.declaration) return { kind: 'identity' }
    if (source.ownership === 'shared-refcount') {
      if (target.ancestors.includes(source.declaration)) return { kind: 'class-cast', target, down: true }
      if (source.ancestors.includes(target.declaration)) return { kind: 'class-cast', target, down: false }
      return { kind: 'reference-null', absent: { kind: 'null' } }
    }
  }
  if (source.kind === 'null' && target.kind === 'class-ref' && target.ownership === 'shared-refcount') return { kind: 'null' }
  if (source.kind === 'class-ref' && source.ownership === 'shared-refcount') {
    if (target.kind === 'null') return { kind: 'reference-null', absent: { kind: 'null' } }
    const absent = nativeSumPlan({ kind: 'null' }, target)
    const undefinedHome = nativeSumPlan({ kind: 'undefined' }, target)
    if ((absent || undefinedHome) && disjoint(source, target, true)) {
      return {
        kind: 'reference-null',
        absent: absent === null ? null : { kind: 'transfer', plan: absent },
        ...(undefinedHome === null ? {} : { undefined: { kind: 'transfer' as const, plan: undefinedHome } })
      }
    }
  }
  return disjoint(source, target) ? 'disjoint' : 'unknown'
}

/**
 * Selection is partial in its runtime domain, never partial in its analysis.
 * Every excluded alternative must be proven disjoint. An opaque alternative
 * keeps the general conversion recipe; it cannot be dropped to avoid boxing.
 * Admission still belongs to the caller's existing narrowing authority.
 */
export const nativeSelectionRecipeOf = (source: Representation, target: Representation): NativeSelectionRecipe | null => {
  if (source.kind !== 'optional' && source.kind !== 'tagged-union') return null
  const step = select(source, target)
  return typeof step === 'string' ? null : { source: representationKey(source), target: representationKey(target), step }
}

const sameConstructorCarrier = (value: Representation, destination: Representation): boolean =>
  (value.kind === 'constructor-value-dispatch' || value.kind === 'constructor-family') &&
  (destination.kind === 'constructor-value-dispatch' || destination.kind === 'constructor-family') &&
  abiKey(value.abi) === abiKey(destination.abi)

/**
 * A subset already admitted by the union narrowing table can retain opaque
 * native arms by their exact tags. Unlike category selection, this does not
 * claim that an omitted record or Proxy is structurally disjoint from a live
 * arm. The installed classifier checks its tag and the materializer rejects
 * it. Every destination arm must have an exact source home: reconstruction
 * and nominal downcasts still use their own conversion contracts.
 */
export const nativeSubsetSelectionRecipeOf = (source: Representation, target: Representation): NativeSelectionRecipe | null => {
  const union = source.kind === 'optional' ? source.payload : source
  const selected = target.kind === 'optional' ? target.payload : target
  if (union.kind !== 'tagged-union') return null
  const sourceKeys = new Set(union.arms.map((arm) => representationKey(arm.value)))
  const targets = selected.kind === 'tagged-union' ? selected.arms.map((arm) => arm.value) : [selected]
  if (!targets.every((arm) => sourceKeys.has(representationKey(arm)))) return null
  // A box is a home for every alternative: an omitted arm is boxed into it,
  // never rejected by tag (`double | any` returned as `any`).
  if (targets.some((arm) => arm.kind === 'dynamic')) return null

  const hasExactHome = (value: Representation, destination: Representation): boolean => {
    if (representationKey(value) === representationKey(destination)) return true
    if (destination.kind === 'optional') return value.kind === destination.absence || hasExactHome(value, destination.payload)
    return destination.kind === 'tagged-union' && destination.arms.some((arm) => hasExactHome(value, arm.value))
  }
  const exact = (value: Representation): NativeSelectionStep | null => {
    if (representationKey(value) === representationKey(target)) return { kind: 'identity' }
    if (hasExactHome(value, target)) {
      const transfer = nativeSumPlan(value, target)
      if (transfer && nativeSumPreservesPayload(transfer)) return { kind: 'transfer', plan: transfer }
    }
    // A structural constructor value and a class constructor family under ONE
    // construct convention are one native carrier (the construct pointer):
    // `factory.make(bytes)` over `ResponseConstructor | typeof WireResponse`
    // hands either arm to a static body whose `this` names the other. Which
    // class it evaluates is still decided where a family dispatches on it.
    if (sameConstructorCarrier(value, selected)) return { kind: 'identity' }
    // An arm whose class derives in place from the selected native record is
    // already that record: the upcast is total and keeps the allocation.
    const upcast = nativeRecordBaseUpcastPlan(value, selected)
    if (upcast)
      return { kind: 'transfer', plan: target.kind === 'optional' ? { kind: 'wrap', target, payload: upcast, index: null } : upcast }
    if (value.kind === 'optional') {
      const present = exact(value.payload)
      const absent = exact({ kind: value.absence })
      return present || absent ? { kind: 'optional', absence: value.absence, present, absent } : null
    }
    if (value.kind === 'tagged-union') {
      const arms = value.arms.map((arm) => exact(arm.value))
      return arms.some((arm) => arm !== null) ? { kind: 'dispatch', arms } : null
    }
    return null
  }
  const step = exact(source)
  return step ? { source: representationKey(source), target: representationKey(target), step } : null
}

const total = (step: NativeSelectionStep | null): boolean => {
  if (step === null) return false
  switch (step.kind) {
    case 'dispatch':
      return step.arms.every(total)
    case 'optional':
      return total(step.present) && total(step.absent)
    case 'class-cast':
      return !step.down
    case 'reference-null':
      return false
    default:
      return true
  }
}

/** Discarded tags read no payload; every retained transfer must preserve its native carrier. */
export const nativeSelectionPreservesPayload = (recipe: NativeSelectionRecipe): boolean => {
  const preserves = (step: NativeSelectionStep | null): boolean => {
    if (step === null) return true
    switch (step.kind) {
      case 'transfer':
        return nativeSumPreservesPayload(step.plan)
      case 'dispatch':
        return step.arms.every(preserves)
      case 'optional':
        return preserves(step.present) && preserves(step.absent)
      case 'reference-null':
        return preserves(step.absent) && preserves(step.undefined ?? null)
      default:
        return true
    }
  }
  return preserves(recipe.step)
}

/** Tag/presence selection checks its own domain; a nominal downcast still needs the surrounding class-layout proof. */
export const nativeSelectionGuardContractOf = (
  recipe: NativeSelectionRecipe
): { readonly requiresSourceGuard?: true; readonly executesSourceGuard?: true } => {
  if (total(recipe.step)) return {}
  const uncheckedClassCast = (step: NativeSelectionStep | null): boolean => {
    if (step === null) return false
    switch (step.kind) {
      case 'class-cast':
        return step.down
      case 'dispatch':
        return step.arms.some(uncheckedClassCast)
      case 'optional':
        return uncheckedClassCast(step.present) || uncheckedClassCast(step.absent)
      case 'reference-null':
        return uncheckedClassCast(step.absent) || uncheckedClassCast(step.undefined ?? null)
      default:
        return false
    }
  }
  return { requiresSourceGuard: true, ...(uncheckedClassCast(recipe.step) ? {} : { executesSourceGuard: true as const }) }
}

/** Widening may not discard an alternative or require a successful downcast. */
export const nativeTotalSelectionRecipeOf = (source: Representation, target: Representation): NativeSelectionRecipe | null => {
  const recipe = nativeSelectionRecipeOf(source, target)
  return recipe && total(recipe.step) ? recipe : null
}

/**
 * The same total step for ONE alternative a caller has already proven live
 * (a merge's live arm, its live absence). Leaves are admitted here too: the
 * `null -> shared Ref` rule and the nominal upcast are total, and neither
 * can discard an alternative. A downcast or a collapsed-null test is not.
 */
export const nativeTotalSelectionStepOf = (source: Representation, target: Representation): NativeSelectionStep | null => {
  const step = select(source, target)
  return typeof step === 'string' || !total(step) ? null : step
}
