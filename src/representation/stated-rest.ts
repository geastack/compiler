import type { CallableAbi } from './model.js'
import { restPackedFrom } from './model.js'

/**
 * Where a function object's trailing array sits and where its first element
 * comes from, both counted over the PHYSICAL formals (a receiver is formal 0).
 * `slot` is `-1` for a trailing array that is an ordinary positional
 * parameter. `packedFrom` equals `slot` except for an `arguments` frame
 * (`CallableAbi.argumentsFrame`), whose array holds every argument past any
 * receiver while the formals before it still bind by position.
 */
export interface StatedRest {
  readonly slot: number
  readonly packedFrom: number
}

/**
 * The rest position a function object of this convention states for itself,
 * or `null` when the last formal is no array and a boxed dynamic call never
 * has to ask.
 *
 * The question exists because the carrier cannot answer it: `(a, xs: T[])`,
 * `(a, ...xs: T[])` and `(a)` reading `arguments` are one physical signature,
 * and a box made where no ABI is in view (a callable handed back out of a
 * dynamic call) packs the trailing arguments by this fact or hands the first
 * one to the array slot. The emitter states it where the object is created and
 * the certifier checks that a creation and its carrier agree; both ask here.
 */
export const statedRestOf = (abi: CallableAbi): StatedRest | null => {
  const last = abi.parameters.at(-1)?.value ?? abi.receiver
  if (last?.kind !== 'array-object') return null
  const packedFrom = restPackedFrom(abi)
  if (abi.restFrom === null || packedFrom === null) return { slot: -1, packedFrom: -1 }
  const receiverSlots = abi.receiver === null ? 0 : 1
  return { slot: abi.restFrom + receiverSlots, packedFrom: packedFrom + receiverSlots }
}

/** Whether two statements split one argument list the same way. */
export const sameStatedRest = (left: StatedRest | null, right: StatedRest | null): boolean =>
  left === null || right === null ? left === right : left.slot === right.slot && left.packedFrom === right.packedFrom
