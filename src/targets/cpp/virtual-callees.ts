import type { IrBody } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import type { EmitContext } from './emit-context.js'
import type { CallableAbi } from '../../representation/model.js'
import { immediateVirtualCalleesOf } from '../../projection/immediate-callees.js'
import { virtualCalleeClaim } from './class-properties/emit-class-properties.js'

/**
 * Every method read in one body that has to be DISPATCHED through the object,
 * settled before the body renders a line.
 *
 * Which reads are consumed only as an immediate virtual callee is the
 * projection's answer (`immediateVirtualCalleesOf`); the class claim decides
 * which of those use the family dispatch members. `virtualCalleesUsed`
 * stays where it is -- it is a proof buffer, filled as each call consumes an
 * entry and checked once the body has finished, which is what a buffer is.
 */
export const virtualCalleesOf = (
  ctx: EmitContext,
  body: IrBody
): ReadonlyMap<IrValueId, { readonly member: string; readonly abi: CallableAbi }> => {
  const callees = new Map<IrValueId, { readonly member: string; readonly abi: CallableAbi }>()
  const immediate = immediateVirtualCalleesOf(body)
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get' || !immediate.has(operation.result.id)) continue
      const claim = virtualCalleeClaim(ctx, operation)
      if (claim !== null) callees.set(operation.result.id, claim)
    }
  }
  return callees
}
