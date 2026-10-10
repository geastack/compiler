import { representationKey, type Representation } from '../representation/model.js'
import {
  nativeLogicalReceiverCallablePayloadsOf,
  nativeLogicalReceiverProtocolOf,
  nativeLogicalReceiverProtocolSupported
} from '../representation/native-logical-receiver.js'
import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'

/** The physical receiver factory and its possible actual-any observations are
 * one sealed plan, distinct from the caller's positional argument adapters.
 * @semanticCategory generic-primitive
 */
export interface NativeLogicalReceiverRecipe {
  readonly receiver: Representation
  readonly materializers: readonly ConversionNode[]
}

export const nativeLogicalReceiverRecipeOf = (
  receiver: Representation,
  nodeFor: (source: Representation, target: Representation) => ConversionNode | null,
  resolve?: ConversionNodeResolver
): NativeLogicalReceiverRecipe | null => {
  if (!nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(receiver))) return null
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const materializers: ConversionNode[] = []
  for (const source of nativeLogicalReceiverCallablePayloadsOf(receiver)) {
    const node = nodeFor(source, dynamic)
    if (
      node === null ||
      representationKey(node.source) !== representationKey(source) ||
      representationKey(node.target) !== representationKey(dynamic) ||
      !recipeIsMaterializableWithoutPriorSourceGuard(node, resolve)
    )
      return null
    materializers.push(node)
  }
  return { receiver, materializers }
}
