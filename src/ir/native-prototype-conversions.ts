import { abiOfCallee } from '../projection/callee.js'
import { hasReferenceIdentity } from '../representation/collections.js'
import type { Representation } from '../representation/model.js'
import type { CallOperation } from './model.js'
import type { NativePrototypeCallClaim } from './native-prototype-calls.js'
import type { OperationConversionInput } from './operation-conversions.js'

/** Native collection slots and callback frames; ambient interface formals are not entered. */
export const nativePrototypeConversionInputsOf = (
  operation: CallOperation,
  claims: readonly NativePrototypeCallClaim[]
): readonly OperationConversionInput[] => {
  const inputs: OperationConversionInput[] = []
  const add = (role: OperationConversionInput['role'], source: Representation, target: Representation): void => {
    inputs.push({ role, source, target })
  }
  for (const claim of claims) {
    const carrier = claim.carrier
    if (claim.nativeReceiver) add('native-base-view', claim.nativeReceiver, carrier)
    if (carrier.kind !== 'keyed-collection') continue
    if (carrier.family === 'set' && claim.member === 'forEach') {
      const callback = operation.arguments[0]
      const abi = callback && abiOfCallee(callback.representation)
      if (!abi || abi.restFrom !== null) continue
      for (const [index, parameter] of abi.parameters.entries())
        add('prototype-callback', index < 2 ? carrier.key : index === 2 ? carrier : { kind: 'undefined' }, parameter.value)
      if (abi.receiver) add('prototype-callback', operation.arguments[1]?.representation ?? { kind: 'undefined' }, abi.receiver)
      continue
    }
    const expected = claim.member === 'set' ? 2 : ['clear', 'entries', 'keys', 'values'].includes(claim.member) ? 0 : 1
    if (operation.arguments.length !== expected) continue
    for (const [index, argument] of operation.arguments.entries()) {
      if (index === 0 && (carrier.family === 'weak-map' || carrier.family === 'weak-set') && hasReferenceIdentity(argument.representation))
        continue
      if (
        carrier.family === 'set' &&
        claim.member === 'has' &&
        !carrier.recursive &&
        carrier.key.kind === 'dictionary' &&
        carrier.key.key === 'string' &&
        carrier.key.value.kind === 'dynamic' &&
        argument.representation.kind === 'dynamic'
      )
        continue
      add('prototype-argument', argument.representation, index === 1 && carrier.value ? carrier.value : carrier.key)
    }
    if (claim.member === 'get' && carrier.value && operation.result && operation.result.representation.kind !== 'void')
      add('prototype-result', { kind: 'optional', payload: carrier.value, absence: 'undefined' }, operation.result.representation)
  }
  return inputs
}
