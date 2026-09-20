import { abiOfCallee } from '../projection/callee.js'
import { abiKey, representationKey } from '../representation/model.js'
import type { IrOperation } from './model.js'

/**
 * A native bind captures an already-converted prefix; it neither reads object
 * properties nor invokes the callable. An eventual dynamic publication or
 * callable adapter is analyzed at that operation, not invented at allocation.
 * Match the complete source frame and remaining result frame before claiming
 * native transport. Boxed sources and mismatched frames keep boundary demand.
 */
export const nativeCallableBindTransportOf = (operation: IrOperation): boolean => {
  if (operation.kind !== 'bind-callable' || operation.source.representation.kind === 'dynamic') return false
  const source = abiOfCallee(operation.source.representation)
  const result = abiOfCallee(operation.result.representation)
  if (!source || !result || abiKey(source) !== abiKey(operation.sourceAbi)) return false
  if (source.restFrom !== null || result.restFrom !== null || result.receiver !== null) return false
  if (
    source.receiver === null
      ? operation.receiver !== null
      : operation.receiver === null || representationKey(source.receiver) !== representationKey(operation.receiver.representation)
  )
    return false
  if (
    operation.bound.length > source.parameters.length ||
    operation.bound.some((value, index) => representationKey(value.representation) !== representationKey(source.parameters[index]!.value))
  )
    return false
  const remaining = source.parameters.slice(operation.bound.length)
  return (
    remaining.length === result.parameters.length &&
    representationKey(source.result) === representationKey(result.result) &&
    remaining.every((parameter, index) => representationKey(parameter.value) === representationKey(result.parameters[index]!.value))
  )
}
