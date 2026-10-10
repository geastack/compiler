import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import type { Representation } from '../representation/model.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'

export type PromiseAdoptionKind = 'rejection-only' | 'unit-transfer' | 'payload-transfer'

export type PromiseAdoptionRecipe =
  | { readonly kind: 'rejection-only' }
  | { readonly kind: 'unit-transfer'; readonly fulfillment: 'void' | 'undefined' | 'dynamic' }
  | { readonly kind: 'payload-transfer'; readonly conversion: ConversionNode }

const unitPayload = (value: Representation): boolean => value.kind === 'void' || value.kind === 'undefined'

/** A promise's completion channel decides whether a payload conversion exists at all. */
export const promiseAdoptionKindOf = (source: Representation, target: Representation): PromiseAdoptionKind | null => {
  if (source.kind !== 'promise' || target.kind !== 'promise') return null
  const from = source.value
  const into = target.value
  if (from.kind === 'void' && from.bottom === true) return 'rejection-only'
  if (from.kind === 'void' || into.kind === 'void')
    return unitPayload(from) && (unitPayload(into) || into.kind === 'dynamic') ? 'unit-transfer' : null
  return 'payload-transfer'
}

export const promiseAdoptionPlanOf = (
  source: Representation,
  target: Representation,
  nodeFor: (source: Representation, target: Representation) => ConversionNode,
  resolve?: ConversionNodeResolver
): PromiseAdoptionRecipe | null => {
  const kind = promiseAdoptionKindOf(source, target)
  if (kind === null || source.kind !== 'promise' || target.kind !== 'promise') return null
  if (kind === 'rejection-only') return { kind }
  if (kind === 'unit-transfer') {
    const into = target.value.kind
    if (into !== 'void' && into !== 'undefined' && into !== 'dynamic') return null
    return { kind, fulfillment: into }
  }
  const conversion = nodeFor(source.value, target.value)
  return recipeIsMaterializableWithoutPriorSourceGuard(conversion, resolve) ? { kind, conversion } : null
}
