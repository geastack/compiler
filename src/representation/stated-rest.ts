import type { CallableAbi } from './model.js'

/**
 * The rest position a function object of this convention states for itself,
 * counted over the PHYSICAL formals (a receiver is formal 0): `-1` for a
 * trailing array that is an ordinary positional parameter, or `null` when the
 * last formal is no array and a boxed dynamic call never has to ask.
 *
 * The question exists because the carrier cannot answer it: `(a, xs: T[])`
 * and `(a, ...xs: T[])` are one physical signature, and a box made where no
 * ABI is in view (a callable handed back out of a dynamic call) packs the
 * trailing arguments by this fact or hands the first one to the array slot.
 * The emitter states it where the object is created and the certifier checks
 * that a creation and its carrier agree; both ask here.
 */
export const statedRestOf = (abi: CallableAbi): number | null => {
  const last = abi.parameters.at(-1)?.value ?? abi.receiver
  if (last?.kind !== 'array-object') return null
  return abi.restFrom === null ? -1 : abi.restFrom + (abi.receiver === null ? 0 : 1)
}
