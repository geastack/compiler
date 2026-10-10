import { abiOfCallee } from '../projection/callee.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { NativeUnboundMethodContract } from './native-method.js'

export interface NativeBufferMethodDescriptor {
  readonly key: 'slice'
  readonly receiver: Extract<Representation, { kind: 'array-buffer' | 'shared-array-buffer' }>
  readonly abi: CallableAbi
  readonly source: Representation
  readonly target: Representation
  readonly physicalResult: Representation
}

const numericIndexOf = (value: Representation): boolean =>
  value.kind === 'scalar'
    ? value.domain === 'number' || value.domain === 'int32' || value.domain === 'uint32' || value.domain === 'float64'
    : value.kind === 'optional' && value.absence === 'undefined' && numericIndexOf(value.payload)

/** The intrinsic method's native brand and finite frame, without capturing the object used for the read. */
export const nativeBufferMethodDescriptorOf = (
  receiver: Representation,
  key: string,
  target: Representation
): NativeBufferMethodDescriptor | null => {
  if (
    (receiver.kind !== 'array-buffer' && receiver.kind !== 'shared-array-buffer') ||
    receiver.ownership !== 'shared-refcount' ||
    key !== 'slice'
  )
    return null
  const abi = abiOfCallee(target)
  if (
    abi === null ||
    abi.receiver !== null ||
    abi.restFrom !== null ||
    abi.parameters.length > 2 ||
    !abi.parameters.every((slot) => numericIndexOf(slot.value))
  )
    return null
  const sourceAbi: CallableAbi = { ...abi, receiver }
  return { key, receiver, abi: sourceAbi, source: { kind: 'function-value-dispatch', abi: sourceAbi }, target, physicalResult: receiver }
}

/** Used only by the contextual intrinsic getter node; ordinary script method admission remains unchanged. */
export const nativeBufferUnboundMethodContractOf = (source: Representation, target: Representation): NativeUnboundMethodContract | null => {
  const from = abiOfCallee(source)
  const into = abiOfCallee(target)
  const descriptor = from?.receiver ? nativeBufferMethodDescriptorOf(from.receiver, 'slice', target) : null
  if (from === null || into === null || descriptor === null || abiKey(from) !== abiKey(descriptor.abi)) return null
  return {
    source: from,
    target: into,
    receiver: descriptor.receiver,
    absence: 'undefined',
    identity: 'preserved',
    receiverRequirement: 'present-native-brand'
  }
}
