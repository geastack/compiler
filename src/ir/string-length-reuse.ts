import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { dominatorTreeOf } from './dominance.js'
import { stringConstantsOf } from './dead-values.js'
import type { IrBlockId, IrBody, IrOperand } from './model.js'

/** Reuse a dominating native string length. The receiver must be the same
 * SSA value, or a read of a cell the caller proves aliases an unchanged
 * formal. No object getters, mutable cells, or assumptions about callees.
 * Relocated/dead reads are excluded: their original CFG position no longer
 * states where (or whether) their result will be available. */
export const stringLengthReuseOf = (
  body: IrBody,
  stableFormals: ReadonlySet<DeclarationId>,
  excluded: ReadonlySet<IrValueId>
): ReadonlyMap<IrValueId, IrOperand> => {
  const reuse = new Map<IrValueId, IrOperand>()
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return reuse
  const keys = stringConstantsOf(body)
  const receivers = new Map<IrValueId, string>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind === 'binding-read' && stableFormals.has(operation.declaration))
        receivers.set(operation.result.id, `formal:${operation.declaration}`)
      if (operation.kind === 'parameter') receivers.set(operation.result.id, `parameter:${operation.ordinal}`)
    }
  }
  const dominance = dominatorTreeOf(body)
  const available = new Map<string, { block: IrBlockId; operand: IrOperand }[]>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      if (
        operation.kind !== 'get' ||
        operation.receiver.representation.kind !== 'string' ||
        keys.get(operation.key.value) !== 'length' ||
        excluded.has(operation.result.id)
      )
        continue
      // Non-formal binding reads deliberately keep their distinct SSA IDs.
      const identity = receivers.get(operation.receiver.value) ?? `value:${operation.receiver.value}`
      const prior = available.get(identity) ?? []
      const dominating = prior.find((candidate) => dominance.dominates(candidate.block, blockId))
      if (dominating) reuse.set(operation.result.id, dominating.operand)
      else {
        prior.push({ block: blockId, operand: { value: operation.result.id, representation: operation.result.representation } })
        available.set(identity, prior)
      }
    }
  }
  return reuse
}
