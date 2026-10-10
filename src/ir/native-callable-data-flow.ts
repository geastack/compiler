import type { ConversionCensus } from '../conversion/nodes.js'
import {
  recipeHasNormalResult,
  recipeIsMaterializableWithoutPriorSourceGuard,
  recipePreservesNativePayload
} from '../conversion/recipe-closure.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrValueId } from '../identity/ids.js'
import type { IrOperation, IrOperand, SetOperation } from './model.js'

const primitiveStorage = (value: Representation): boolean => {
  if (value.kind === 'optional') return primitiveStorage(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => primitiveStorage(arm.value))
  return ['scalar', 'string', 'symbol', 'null', 'undefined'].includes(value.kind)
}

/** A published primitive data store cannot retain or publish its Function
 * owner. This only preserves existing provenance: the solver still owns the
 * incoming identity, and certification independently replays the source's
 * descriptor/owner proof. Reference and callable payloads need storage edges.
 */
export const nativeCallablePrimitiveDataWritePreservesOwner = (
  operation: SetOperation,
  conversions: Pick<ConversionCensus, 'nodeById'>,
  definitionOf: (value: IrValueId) => IrOperation | undefined
): boolean => {
  const receipt = operation.nativeCallableDataWrite
  const same = (left: IrOperand, right: IrOperand): boolean =>
    left.value === right.value && representationKey(left.representation) === representationKey(right.representation)
  const key = definitionOf(operation.key.value)
  if (
    !receipt ||
    receipt.prototypeProtocol !== 'absent' ||
    receipt.receiverMaterialization !== null ||
    !isNativeCallableCarrier(operation.receiver.representation.kind) ||
    key?.kind !== 'constant' ||
    key.literal !== 'string' ||
    !same(receipt.receiver, operation.receiver) ||
    !same(receipt.key, operation.key) ||
    !same(receipt.value, operation.value) ||
    ![receipt.value.representation, receipt.storedValue.representation, receipt.storage].every(primitiveStorage) ||
    !receipt.storageFits.some(
      (fit) => fit.writer === receipt.writer && representationKey(fit.source) === representationKey(receipt.storedValue.representation)
    )
  )
    return false
  const fit = (id: Parameters<ConversionCensus['nodeById']>[0], source: Representation, target: Representation): boolean => {
    const node = conversions.nodeById(id)
    return (
      node !== null &&
      representationKey(node.source) === representationKey(source) &&
      representationKey(node.target) === representationKey(target) &&
      recipeHasNormalResult(node, conversions.nodeById) &&
      recipePreservesNativePayload(node, conversions.nodeById) &&
      recipeIsMaterializableWithoutPriorSourceGuard(node, conversions.nodeById)
    )
  }
  if (
    !fit(receipt.storageConversion, receipt.storedValue.representation, receipt.storage) ||
    !receipt.storageFits.every((writer) => fit(writer.conversion, writer.source, receipt.storage))
  )
    return false
  let current = operation.value
  const seen = new Set<IrValueId>()
  while (!same(current, receipt.storedValue)) {
    if (seen.has(current.value)) return false
    seen.add(current.value)
    const producer = definitionOf(current.value)
    if (
      producer?.kind !== 'convert' ||
      producer.result.id !== current.value ||
      representationKey(producer.result.representation) !== representationKey(current.representation) ||
      !fit(producer.conversionUse, producer.source.representation, producer.result.representation)
    )
      return false
    current = producer.source
  }
  return true
}
