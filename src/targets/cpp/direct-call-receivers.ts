import type { IrBody, IrOperand } from '../../ir/model.js'
import { allOperationsOf } from '../../ir/model.js'
import { operandsOfIrOperation } from '../../ir/queries.js'
import type { IrValueId } from '../../identity/ids.js'
import type { EmitContext } from './emit-context.js'
import type { CallableAbi } from '../../representation/model.js'
import { classMethodValueReceiverClaim, virtualCalleeClaim } from './class-properties/emit-class-properties.js'
import { unionClassMethodValueReceiverClaim } from './emit-union-properties.js'

/**
 * The receiver every method-value read in one body has to keep, settled
 * before the body renders a line.
 *
 * A method value carries its body's physical convention, receiver first, while
 * the language's view of it declares none; the call that consumes it is handed
 * the object the READ went through. Which reads publish such a value is a
 * question about the projected class layout, not about any text, so it is
 * asked here rather than recorded as a side effect of whichever resolver
 * happened to spell the value -- there were four such sites, two of which
 * (`settleDeadCalleeSideEffects` and `computedClassPrototypeMethodText`) only
 * ran on some renders, which is exactly how a fact goes missing.
 *
 * This composes; it decides nothing. Both claims live with the resolver that
 * owns the carrier, and the map is keyed by the read's own SSA result, so a
 * detached method read reaches its call through a different value and cannot
 * acquire a receiver from it.
 */
export const directCallReceiversOf = (ctx: EmitContext, body: IrBody): ReadonlyMap<IrValueId, IrOperand> => {
  const receivers = new Map<IrValueId, IrOperand>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      const receiver = classMethodValueReceiverClaim(ctx, operation) ?? unionClassMethodValueReceiverClaim(ctx, operation)
      if (receiver !== null) receivers.set(operation.result.id, receiver)
    }
  }
  return receivers
}

/**
 * Every method read in one body that has to be DISPATCHED through the object,
 * settled before the body renders a line.
 *
 * The same walk as above over the same claims' home: which reads are virtual
 * is a question about the projected class family and the dispatch members this
 * unit emitted, both fixed long before a line is printed. `virtualCalleesUsed`
 * stays where it is -- it is a proof buffer, filled as each call consumes an
 * entry and checked once the body has finished, which is what a buffer is.
 */
export const virtualCalleesOf = (
  ctx: EmitContext,
  body: IrBody
): ReadonlyMap<IrValueId, { readonly member: string; readonly abi: CallableAbi }> => {
  const callees = new Map<IrValueId, { readonly member: string; readonly abi: CallableAbi }>()
  const immediate = new Set<IrValueId>()
  const escaped = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'call') immediate.add(operation.callee.value)
      for (const operand of operandsOfIrOperation(operation)) {
        if (
          operation.kind === 'call' &&
          operand.value === operation.callee.value &&
          operation.receiver?.value !== operand.value &&
          !operation.arguments.some((argument) => argument.value === operand.value)
        )
          continue
        escaped.add(operand.value)
      }
    }
  }
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind !== 'get') continue
      // A method returned, stored, or inspected is selected at property-read
      // time. Only a value consumed exclusively as an immediate callee may
      // defer that selection to the receiver's virtual dispatch member.
      if (!immediate.has(operation.result.id) || escaped.has(operation.result.id)) continue
      const claim = virtualCalleeClaim(ctx, operation)
      if (claim !== null) callees.set(operation.result.id, claim)
    }
  }
  return callees
}
