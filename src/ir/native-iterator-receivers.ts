import type { FunctionId, IrValueId } from '../identity/ids.js'
import { abiOfCallee } from '../projection/callee.js'
import { recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import { prototypeEntryMayBeCallable } from '../projection/native-prototype-methods.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import { nativeLogicalReceiverProtocolOf, nativeLogicalReceiverProtocolSupported } from '../representation/native-logical-receiver.js'
import type { GetIteratorOperation, IteratorCloseOperation, IteratorNextOperation } from './model.js'

/** Internal iterator calls use the same erased receiver protocol as ordinary
 * calls. A physical frame remains covered by its exact iterator-value recipe.
 */
export const nativeIteratorLogicalReceiverAdmitted = (
  operation: GetIteratorOperation | IteratorNextOperation | IteratorCloseOperation,
  deriver: RepresentationDeriver,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  ignoresReceiver: ReadonlySet<IrValueId>,
  sourceIgnoresReceiver: (functionId: FunctionId) => boolean
): boolean => {
  const independent = (method: Representation): boolean => {
    if (method.kind === 'optional') return independent(method.payload)
    if (method.kind === 'function') return sourceIgnoresReceiver(method.functionId)
    if (method.kind === 'function-family' || method.kind === 'function-value-family')
      return method.members.length > 0 && method.members.every(sourceIgnoresReceiver)
    return false
  }
  const physicalOrIndependent = (method: Representation): boolean => {
    if (method.kind === 'optional') return physicalOrIndependent(method.payload)
    const abi = abiOfCallee(method)
    // A noncallable member has its own protocol refusal/TypeError, rather than
    // an erased invocation whose missing receiver could change an answer.
    return abi === null ? !prototypeEntryMayBeCallable(method) : abi.receiver !== null || independent(method)
  }
  const supports = (receiver: Representation): boolean => nativeLogicalReceiverProtocolSupported(nativeLogicalReceiverProtocolOf(receiver))
  if (operation.kind === 'get-iterator')
    return (
      operation.protocol === 'enumerate' ||
      operation.method === null ||
      supports(operation.receiver.representation) ||
      ignoresReceiver.has(operation.method.value) ||
      physicalOrIndependent(operation.method.representation)
    )
  const member = operation.kind === 'iterator-next' ? 'next' : 'return'
  const check = (receiver: Representation): boolean => {
    if (supports(receiver)) return true
    if (receiver.kind === 'optional') return check(receiver.payload)
    if (receiver.kind === 'tagged-union') return receiver.arms.every((arm) => check(arm.value))
    const fields =
      receiver.kind === 'record'
        ? receiver.fields
        : receiver.kind === 'native-record-ref'
          ? recordFieldsOfShape(deriver, receiver.shapeId)
          : null
    const accessors =
      receiver.kind === 'record'
        ? receiver.accessors
        : receiver.kind === 'native-record-ref'
          ? recordAccessorsOfShape(deriver, receiver.shapeId)
          : null
    const field = fields?.find((field) => field.key === member)
    if (field) return physicalOrIndependent(field.value)
    const getter = accessors?.find((accessor) => accessor.key === member)?.getter
    const abi = getter === undefined || getter === null ? undefined : abis.get(getter)
    return abi === undefined || physicalOrIndependent(abi.result)
  }
  return check(operation.iterator.representation)
}
