import type { Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'

/** A native key/presence query reads metadata without publishing field values. */
export const nativeKeyQueryOf = (operation: IrOperation, closedLayoutOf: (value: Representation) => boolean): boolean => {
  const closedReceiver = (value: Representation): boolean => {
    if (value.kind === 'optional') return closedReceiver(value.payload)
    if (value.kind === 'borrowed-ref') return closedReceiver(value.referent)
    if (value.kind === 'tagged-union') return value.arms.length > 0 && value.arms.every((arm) => closedReceiver(arm.value))
    // A proxy can execute a trap even when both its target and handler have
    // native fixed layouts. Their layouts cannot prove this query harmless.
    return value.kind !== 'proxy-object' && closedLayoutOf(value)
  }
  if (operation.kind === 'has-property') {
    const key = operation.key.representation
    // Coercing an object-shaped key can execute user code independently of
    // the receiver's presence protocol.
    return (key.kind === 'string' || key.kind === 'symbol' || key.kind === 'scalar') && closedReceiver(operation.receiver.representation)
  }
  if (operation.kind === 'own-property-keys' || (operation.kind === 'get-iterator' && operation.protocol === 'enumerate'))
    return closedReceiver(operation.receiver.representation)
  if (operation.kind !== 'call' || !operation.intrinsicOwnKeys || operation.argumentsAreSpread) return false
  const queried = operation.arguments[0]?.representation
  // Lowering authenticates this intrinsic. A same-shaped arbitrary callable
  // has no such contract and must retain its ordinary call effects.
  if (queried === undefined || !closedLayoutOf(queried)) return false
  // `Object.hasOwn(o, key)` is the one member of this family that takes a
  // second argument -- the queried KEY, not a second object -- and
  // `HasOwnProperty` runs `ToPropertyKey` on it (7.1.19) before ever
  // consulting `o`'s own keys. An object-shaped key can execute arbitrary
  // user code from that coercion alone, independently of whether `o`'s own
  // layout is closed, so this asks the identical question `has-property`
  // above already asks of its own key operand.
  const key = operation.arguments[1]?.representation
  return key === undefined || key.kind === 'string' || key.kind === 'symbol' || key.kind === 'scalar'
}
