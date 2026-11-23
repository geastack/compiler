import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { controlFlowGraphOf } from './dominance.js'
import { fieldReadFactsOf, type CodeFreeFieldRead } from './field-read-reuse.js'
import {
  allOperationsOf,
  type GetOperation,
  type IrBlockId,
  type IrBody,
  type IrNonTerminatorOperation,
  type PhiOperation
} from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * Field reads, and the merges of them `reuseFieldReads` built, that may name
 * the field they read instead of holding a counted copy of it.
 *
 * A slab test reads `box.min` and `box.max` once per axis; the reuse pass
 * turned six reads into two and carries each across the axis branches through
 * a phi. Each kept read still copied the handle -- a retain and a release per
 * box, per field -- because the value lives across statements, and the phi
 * copied again. The field holds that value for as long as nothing can store
 * the key, rewrite the receiver's cell, or run program code: exactly the
 * availability `field-read-reuse.ts` already tracks. So a read, or a phi of
 * such reads, may be a pointer to the field when, at every use, the read is
 * still available under that same value and the use itself forgets nothing
 * of it.
 *
 * A use that is a phi this admits is checked on its edge, at the end of the
 * predecessor. Any other use reads through the pointer where it stands; a
 * merge this does not admit copies at its edge. A member every use cannot
 * vouch for leaves, and so does every phi that merges it, until nothing moves.
 *
 * Only reads through a binding cell (`admitsCell`): the cell keeps the
 * receiver alive until something writes it, and a write of the cell forgets
 * the read. A receiver that is itself an SSA value may render as an alias of
 * another field that a store of a different key can release. `borrowable`
 * is the target's answer to which reads it renders as a load at all.
 */
export const borrowedFieldReadsOf = (
  body: IrBody,
  codeFree: CodeFreeFieldRead,
  admitsCell: (declaration: DeclarationId) => boolean,
  borrowable: (operation: GetOperation) => boolean,
  inlined: (value: IrValueId) => boolean
): ReadonlySet<IrValueId> => {
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0) return new Set()
  for (const block of body.blocks.values())
    for (const operation of block.operations) if (operation.kind === 'await' || operation.kind === 'yield') return new Set()
  const facts = fieldReadFactsOf(body, codeFree)
  const cellOf = new Map<IrValueId, DeclarationId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) if (operation.kind === 'binding-read') cellOf.set(operation.result.id, operation.declaration)

  // A read with one use renders inline at it, a load with no copy, and so does
  // one the target re-renders at each use (`inlined`); only a read held across
  // statements, or carried by a merge, has a copy to save.
  const uses = new Map<IrValueId, number>()
  const mergeInputs = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'phi') for (const incoming of operation.incoming) mergeInputs.add(incoming.value.value)
      for (const operand of operandsOfIrOperation(operation)) uses.set(operand.value, (uses.get(operand.value) ?? 0) + 1)
    }
  const members = new Set<IrValueId>()
  for (const [operation] of facts.candidates) {
    if (((uses.get(operation.result.id) ?? 0) < 2 || inlined(operation.result.id)) && !mergeInputs.has(operation.result.id)) continue
    const cell = cellOf.get(operation.receiver.value)
    if (cell === undefined || !admitsCell(cell) || facts.pinned.has(operation.result.id)) continue
    if (operation.result.representation.kind === 'scalar' || !borrowable(operation)) continue
    members.add(operation.result.id)
  }
  if (members.size === 0) return members
  const phis: PhiOperation[] = []
  for (const block of body.blocks.values()) for (const operation of block.operations) if (operation.kind === 'phi') phis.push(operation)
  const closePhis = (): void => {
    for (let growing = true; growing;) {
      growing = false
      for (const phi of phis)
        if (!members.has(phi.result.id) && phi.incoming.every((incoming) => members.has(incoming.value.value))) {
          members.add(phi.result.id)
          growing = true
        }
    }
  }
  closePhis()

  type Fact = { readonly receiver: string; readonly key: string; readonly value: IrValueId }
  const graph = controlFlowGraphOf(body)
  const predecessorsOf = (block: IrBlockId): readonly IrBlockId[] => [...new Set(graph.predecessors.get(block) ?? [])]
  const transferOne = (current: Map<string, Fact>, operation: IrNonTerminatorOperation): void => {
    if (operation.kind === 'get') {
      const candidate = facts.candidates.get(operation)
      if (candidate !== undefined) {
        const receiver = facts.receiverOf(operation.receiver.value)
        const id = facts.factId(receiver, candidate.key, candidate.shape)
        if (!current.has(id)) current.set(id, { receiver, key: candidate.key, value: operation.result.id })
        return
      }
    }
    const kill = facts.killOf(operation)
    if (kill === null) return
    for (const [id, fact] of current) if (facts.forgets(kill, fact)) current.delete(id)
  }
  const holds = (current: ReadonlyMap<string, Fact>, value: IrValueId): Fact | undefined =>
    [...current.values()].find((fact) => fact.value === value)
  const exits = new Map<IrBlockId, Map<string, Fact>>()
  const entries = new Map<IrBlockId, Map<string, Fact>>()
  // A join whose predecessors hold different reads holds a phi of them, when
  // the block has one: the reuse pass built exactly those. The phi is matched
  // by its incoming values, not by the reads' fact ids: a read's published
  // facts (its recipes) differ per site once they are certified, so two reads
  // the reuse pass merged no longer share an id here.
  const merge = (blockId: IrBlockId): Map<string, Fact> | null => {
    const predecessors = predecessorsOf(blockId)
    if (blockId === body.entry || predecessors.length === 0) return new Map()
    const reached = predecessors.flatMap((predecessor) => {
      const exit = exits.get(predecessor)
      return exit === undefined ? [] : [{ predecessor, exit }]
    })
    const [first, ...rest] = reached
    if (first === undefined) return null
    const blockPhis = (body.blocks.get(blockId)?.operations ?? []).filter(
      (operation): operation is PhiOperation => operation.kind === 'phi'
    )
    const merged = new Map<string, Fact>()
    for (const [id, fact] of first.exit) if (rest.every(({ exit }) => exit.get(id)?.value === fact.value)) merged.set(id, fact)
    for (const phi of blockPhis) {
      const held = reached.map(({ predecessor, exit }) => {
        const incoming = phi.incoming.find((candidate) => candidate.block === predecessor)
        return incoming === undefined ? undefined : holds(exit, incoming.value.value)
      })
      const [one, ...others] = held
      if (one === undefined || others.some((other) => other === undefined || other.receiver !== one.receiver || other.key !== one.key))
        continue
      merged.set(`phi:${phi.result.id}`, { receiver: one.receiver, key: one.key, value: phi.result.id })
    }
    return merged
  }
  const same = (left: ReadonlyMap<string, Fact>, right: ReadonlyMap<string, Fact>): boolean =>
    left.size === right.size && [...left].every(([id, fact]) => right.get(id)?.value === fact.value)
  let settled = false
  for (let round = 0; round < 64 && !settled; round++) {
    settled = true
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (block === undefined) continue
      const incoming = merge(blockId)
      if (incoming === null) continue
      entries.set(blockId, new Map(incoming))
      for (const operation of block.operations) transferOne(incoming, operation)
      const previous = exits.get(blockId)
      if (previous === undefined || !same(previous, incoming)) {
        exits.set(blockId, incoming)
        settled = false
      }
    }
  }
  if (!settled) return new Set()

  // Every use of a member, and whether it can vouch for it.
  const vouched = (): IrValueId | null => {
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      const entry = entries.get(blockId)
      if (block === undefined) continue
      const current = new Map(entry ?? [])
      for (const operation of block.operations) {
        if (operation.kind === 'phi') {
          // On its edge: the predecessor's exit must still hold the incoming read.
          for (const incoming of operation.incoming) {
            if (!members.has(incoming.value.value)) continue
            if (holds(exits.get(incoming.block) ?? new Map(), incoming.value.value) === undefined) return incoming.value.value
          }
          continue
        }
        for (const operand of operandsOfIrOperation(operation)) {
          if (!members.has(operand.value)) continue
          if (entry === undefined) return operand.value
          const fact = holds(current, operand.value)
          if (fact === undefined) return operand.value
          // Code the use runs would see the field through the pointer: a getter
          // handed the read as its receiver, a call handed it as an argument.
          if (facts.forgets(facts.killOf(operation), fact)) return operand.value
        }
        transferOne(current, operation)
      }
      for (const operand of operandsOfIrOperation(block.terminator))
        if (members.has(operand.value) && (entry === undefined || holds(current, operand.value) === undefined)) return operand.value
    }
    return null
  }
  for (let failed = vouched(); failed !== null; failed = vouched()) {
    members.delete(failed)
    // A phi that merges a value no longer borrowed copies at its edges.
    for (let shrinking = true; shrinking;) {
      shrinking = false
      for (const phi of phis)
        if (members.has(phi.result.id) && phi.incoming.some((incoming) => !members.has(incoming.value.value))) {
          members.delete(phi.result.id)
          shrinking = true
        }
    }
  }
  return members
}
