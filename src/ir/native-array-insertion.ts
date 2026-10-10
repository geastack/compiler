import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeClassReferenceTransportMatches } from '../conversion/native-class-reference.js'
import {
  nativeCallableDynamicIdentityTransportMatches,
  nativeCallableIdentityTransportMatches
} from '../conversion/native-callable-adapter.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { CallOperation, GetOperation, IrOperand, IrOperation } from './model.js'
import { nativePrototypeCallClaimsOf } from './native-prototype-calls.js'

export interface NativeArrayInsertion {
  readonly read: GetOperation
  readonly receiver: IrOperand
  readonly packed: IrOperand
  readonly source: Representation
  readonly target: Representation
  readonly conversion: ConversionNode | null
}

/** A native bulk insertion retains each packed element without publishing its fields or entering a source Function. */
export const nativeArrayInsertionOf = (
  operation: CallOperation,
  definitionOf: (value: IrValueId) => IrOperation | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): NativeArrayInsertion | null => {
  const read = definitionOf(operation.callee.value)
  if (read?.kind !== 'get' || read.receiver.representation.kind !== 'array-object') return null
  const claims = nativePrototypeCallClaimsOf(operation, definitionOf, classes)
  const claim = claims?.[0]
  if (
    claims?.length !== 1 ||
    claim?.kind !== 'array-object' ||
    (claim.member !== 'push' && claim.member !== 'unshift') ||
    read.receiver.representation.ownership !== 'shared-refcount' ||
    (operation.thisArgument ?? operation.receiver)?.value !== read.receiver.value ||
    (operation.receiver !== null && operation.receiver.value !== read.receiver.value) ||
    operation.argumentsAreSpread === true ||
    operation.arguments.length !== 1 ||
    (operation.result !== null &&
      (operation.result.representation.kind !== 'scalar' || operation.result.representation.domain !== 'number'))
  )
    return null
  const packed = operation.arguments[0]!
  if (packed.representation.kind !== 'array-object' || packed.representation.ownership !== 'shared-refcount') return null
  const source = packed.representation.element
  const target = read.receiver.representation.element
  if (representationKey(source) === representationKey(target))
    return { read, receiver: read.receiver, packed, source, target, conversion: null }
  const cited = operation.conversionRecipes?.find(
    (recipe) =>
      recipe.role === 'prototype-argument' &&
      representationKey(recipe.source) === representationKey(source) &&
      representationKey(recipe.target) === representationKey(target)
  )
  const node = cited === undefined ? null : conversions?.nodeById(cited.conversion)
  if (
    !node ||
    !(
      nativePayloadTransportMatches(source, target, node) ||
      nativeClassReferenceTransportMatches(source, target, node) ||
      nativeCallableIdentityTransportMatches(source, target, node) ||
      nativeCallableDynamicIdentityTransportMatches(source, target, node)
    )
  )
    return null
  return { read, receiver: read.receiver, packed, source, target, conversion: node }
}
