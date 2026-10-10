import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { dominatorTreeOf } from './dominance.js'
import { stringConstantsOf } from './dead-values.js'
import { allOperationsOf, type IrBlockId, type IrBody, type IrOperand } from './model.js'

/**
 * The string receivers whose reads name one value, keyed by that value's
 * identity: a read of a formal the caller proves stable, the SSA parameter
 * itself, and a read of a private string cell (`privateCell`) written exactly
 * once in this body by a write that dominates every read of it.
 *
 * The last is the shape `const text = JSON.stringify(xs)` takes inside a loop,
 * read for its `length` and a `charCodeAt` on the next lines. Two such reads,
 * one dominating the other, observe the same execution of the write: a path
 * from the first read back through the write to the second that skipped the
 * first read again would join a path from entry to the write -- which never
 * passes a read the write dominates -- into a path to the second read that
 * avoids the first, contradicting the dominance. No closure may write a
 * private cell, so nothing else can change it in between.
 */
export const stableStringReceiversOf = (
  body: IrBody,
  stableFormals: ReadonlySet<DeclarationId>,
  privateCell: (declaration: DeclarationId) => boolean
): ReadonlyMap<IrValueId, string> => {
  const receivers = new Map<IrValueId, string>()
  const writes = new Map<DeclarationId, { block: IrBlockId; position: number }[]>()
  const reads = new Map<DeclarationId, { value: IrValueId; block: IrBlockId; position: number }[]>()
  for (const block of body.blocks.values())
    for (const [position, operation] of allOperationsOf(block).entries()) {
      if (operation.kind === 'binding-write') {
        const sites = writes.get(operation.declaration) ?? []
        sites.push({ block: block.id, position })
        writes.set(operation.declaration, sites)
      }
      if (operation.kind === 'binding-read') {
        if (stableFormals.has(operation.declaration)) receivers.set(operation.result.id, `formal:${operation.declaration}`)
        else if (operation.result.representation.kind === 'string') {
          const sites = reads.get(operation.declaration) ?? []
          sites.push({ value: operation.result.id, block: block.id, position })
          reads.set(operation.declaration, sites)
        }
      }
      if (operation.kind === 'parameter') receivers.set(operation.result.id, `parameter:${operation.ordinal}`)
    }
  const dominance = dominatorTreeOf(body)
  for (const [declaration, loaded] of reads) {
    const sites = writes.get(declaration) ?? []
    const only = sites[0]
    if (sites.length !== 1 || only === undefined || !privateCell(declaration)) continue
    const dominated = loaded.every((read) =>
      only.block === read.block ? only.position < read.position : dominance.dominates(only.block, read.block)
    )
    if (!dominated) continue
    for (const read of loaded) receivers.set(read.value, `single-write:${declaration}`)
  }
  return receivers
}

/** Reuse a dominating native string length. The receiver must be the same
 * SSA value, or a read `stableStringReceiversOf` proves names one value.
 * No object getters, mutable cells, or assumptions about callees.
 * Relocated/dead reads are excluded: their original CFG position no longer
 * states where (or whether) their result will be available. */
export const stringLengthReuseOf = (
  body: IrBody,
  receivers: ReadonlyMap<IrValueId, string>,
  excluded: ReadonlySet<IrValueId>
): ReadonlyMap<IrValueId, IrOperand> => {
  const reuse = new Map<IrValueId, IrOperand>()
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return reuse
  const keys = stringConstantsOf(body)
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
      // Any other binding read deliberately keeps its distinct SSA ID.
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
