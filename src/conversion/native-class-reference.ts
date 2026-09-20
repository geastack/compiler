import type { ConversionNode, MaterializerContract } from './algebra.js'
import { representationKey, type Representation } from '../representation/model.js'

const referenceEnvelope = (value: Representation): boolean => {
  switch (value.kind) {
    case 'class-ref':
      return value.ownership === 'shared-refcount'
    case 'null':
    case 'undefined':
      return true
    case 'optional':
      return referenceEnvelope(value.payload)
    case 'tagged-union':
      return value.arms.length > 0 && value.arms.every((arm) => referenceEnvelope(arm.value))
    default:
      return false
  }
}

/** Called by materializer producers only after selecting an identity-preserving native operation. */
export const nativeClassReferenceIdentityOf = (
  source: Representation,
  target: Representation
): Pick<MaterializerContract, 'nativeClassReferenceIdentity'> =>
  referenceEnvelope(source) && referenceEnvelope(target) ? { nativeClassReferenceIdentity: 'preserved' } : {}

/**
 * A native reference can change its nullable/union envelope without exposing
 * another route to its fields. Structural records and containers are excluded:
 * their conversion can publish nested aliases that a class-slot census has not
 * indexed. The installed conversion must independently certify preservation of
 * reference identity; absence of boxing or allocation alone is not that proof.
 */
export const nativeClassReferenceTransportMatches = (
  source: Representation,
  target: Representation,
  node: ConversionNode | null | undefined
): boolean => {
  if (
    !node ||
    representationKey(node.source) !== representationKey(source) ||
    representationKey(node.target) !== representationKey(target) ||
    !referenceEnvelope(source) ||
    !referenceEnvelope(target)
  )
    return false
  const capability = node.capability
  return (
    capability.kind === 'identity' ||
    ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
      !capability.materializer.allocates &&
      capability.materializer.nativeFieldProtocol === 'unused' &&
      capability.materializer.nativeClassReferenceIdentity === 'preserved')
  )
}
