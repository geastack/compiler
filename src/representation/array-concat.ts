import type { Representation } from './model.js'

/**
 * ECMA-262 23.1.3.2 `concat(...items)` through a call that states no frame:
 * three's TSLCore `params.concat( new Array( n ).fill( 0 ) )` over an untyped
 * rest list, whose `concat` read the checker types `any`. The receiver's
 * carrier still says it is an Array, and the deferred `Array.prototype` read
 * the printer spells the call from is the same claim
 * (`emit-carrier-members.ts`'s `deferredArrayMethodClaim`): an `array-object`
 * whose own extension declares no `concat`.
 */
export const framelessConcatReceiverOf = (
  receiver: Representation,
  member: string
): Extract<Representation, { kind: 'array-object' }> | null =>
  member === 'concat' && receiver.kind === 'array-object' && !(receiver.extension?.some((field) => field.key === 'concat') ?? false)
    ? receiver
    : null

/**
 * IsConcatSpreadable (23.1.3.2.1) of one item, as its carrier states it: an
 * Array spreads, a primitive is appended whole. `null` for a carrier whose
 * answer is a run-time fact -- a box, an object that may carry
 * `@@isConcatSpreadable`, a sum -- which the caller refuses by name.
 */
export const concatItemOf = (carrier: Representation): 'spread' | 'whole' | null => {
  if (carrier.kind === 'array-object') return carrier.ownership === 'shared-refcount' && carrier.extension === null ? 'spread' : null
  switch (carrier.kind) {
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
      return 'whole'
    default:
      return null
  }
}
