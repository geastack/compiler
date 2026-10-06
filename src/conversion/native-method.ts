import type { FunctionId } from '../identity/ids.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { ConversionNodeId } from './algebra.js'

export const NATIVE_UNBOUND_METHOD_MATERIALIZER = 'gea::CallableObject::unboundMethod'

/** A method read is a view of its Function object; only an explicit bind captures the read's object. */
export interface NativeMethodValueRecipe {
  readonly key: string
  readonly callable: FunctionId | null
  readonly origin: 'prototype' | 'own'
  readonly source: Representation
  readonly target: Representation
  readonly conversion: ConversionNodeId
}

export interface NativeUnboundMethodContract {
  readonly source: CallableAbi
  readonly target: CallableAbi
  readonly receiver: Extract<Representation, { kind: 'class-ref' }>
  readonly absence: 'undefined'
  readonly identity: 'preserved'
}

const nativeAbiOf = (value: Representation): CallableAbi | null => {
  switch (value.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return value.abi
    default:
      return null
  }
}

/** Removing the physical receiver changes invocation protocol, never the remaining argument or result carriers. */
export const nativeUnboundMethodContractOf = (source: Representation, target: Representation): NativeUnboundMethodContract | null => {
  const from = nativeAbiOf(source)
  const to = nativeAbiOf(target)
  if (
    from === null ||
    to === null ||
    from.receiver?.kind !== 'class-ref' ||
    from.receiver.ownership !== 'shared-refcount' ||
    to.receiver !== null ||
    abiKey({ ...from, receiver: null }) !== abiKey(to)
  )
    return null
  return { source: from, target: to, receiver: from.receiver, absence: 'undefined', identity: 'preserved' }
}
