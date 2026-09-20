import type { Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import { nativeSumPlan, type NativeSumPlan } from './native-sum.js'

export type NativeSelectionStep =
  | { readonly kind: 'identity' }
  | { readonly kind: 'null' }
  | { readonly kind: 'reference-null'; readonly absent: NativeSelectionStep }
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
    if (absent && disjoint(source, target, true)) return { kind: 'reference-null', absent: { kind: 'transfer', plan: absent } }
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
