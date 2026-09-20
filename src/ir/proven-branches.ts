import { irValueId, type IrValueId, type PhysicalBodyId, type SemanticResultId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import type { OperandSource } from '../semantics/model/operands.js'
import { allOperationsOf, type IrBlock, type IrBlockId, type IrBody, type IrNonTerminatorOperation } from './model.js'
import type { SlotDrift } from './lower-operands.js'
import { resultOfIrOperation, successorsOfTerminator } from './queries.js'
import { verifyIrBody } from './verify.js'

const nonNullPrimitive = (representation: Representation): boolean =>
  representation.kind === 'scalar' ||
  representation.kind === 'string' ||
  representation.kind === 'symbol' ||
  (representation.kind === 'tagged-union' &&
    representation.arms.length > 0 &&
    representation.arms.every((arm) => nonNullPrimitive(arm.value)))

const primitiveOrNullish = (representation: Representation): boolean =>
  nonNullPrimitive(representation) ||
  representation.kind === 'null' ||
  representation.kind === 'undefined' ||
  (representation.kind === 'optional' && primitiveOrNullish(representation.payload)) ||
  (representation.kind === 'tagged-union' && representation.arms.every((arm) => primitiveOrNullish(arm.value)))

/** Normal-completion truth facts derived from the semantic operations' sealed results. */
export const provenResultTruthiness = (graph: Pick<SemanticGraph, 'operations'>): ReadonlyMap<SemanticResultId, boolean> => {
  const facts = new Map<SemanticResultId, boolean>()
  const read = (source: OperandSource | undefined): boolean | undefined => {
    if (source?.kind === 'result') return facts.get(source.result)
    if (source?.kind !== 'constant') return undefined
    switch (source.literal) {
      case 'undefined':
      case 'null':
        return false
      case 'boolean':
        return source.text === 'true'
      case 'string':
        return source.text.length !== 0
      case 'number':
        return Number(source.text) !== 0 && !Number.isNaN(Number(source.text))
      default:
        return undefined
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const operation of graph.operations.values()) {
      let truth: boolean | undefined
      if (operation.family === 'property' && operation.internalMethod === 'get' && operation.normalResult === 'undefined') truth = false
      else if (operation.family === 'computation' && operation.form === 'logical') {
        const left = read(operation.operands.find((operand) => operand.role === 'left')?.source)
        const right = read(operation.operands.find((operand) => operand.role === 'right')?.source)
        if (operation.operator === '&&') truth = left === false || right === false ? false : left === true ? right : undefined
        if (operation.operator === '||') truth = left === true || right === true ? true : left === false ? right : undefined
      }
      if (truth === undefined) continue
      for (const result of operation.results) {
        if (result.role !== 'value' || facts.has(result.id)) continue
        facts.set(result.id, truth)
        changed = true
      }
    }
  }
  return facts
}

/**
 * Remove impossible control-flow edges before liveness and certification.
 * Evaluation of the condition is preserved, including calls and throws. This
 * pass uses normal-result facts, never a cast's destination type as evidence
 * that the cast's block is unreachable.
 */
export const pruneProvenBranches = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  graph: Pick<SemanticGraph, 'operations'>,
  slotDrift: readonly SlotDrift[] = []
): { readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>; readonly slotDrift: readonly SlotDrift[] } => {
  const semantic = provenResultTruthiness(graph)
  if (semantic.size === 0) return { bodies, slotDrift }
  const absentReads = new Set<SemanticResultId>()
  for (const operation of graph.operations.values()) {
    if (operation.family === 'property' && operation.internalMethod === 'get' && operation.normalResult === 'undefined')
      for (const result of operation.results) if (result.role === 'value') absentReads.add(result.id)
  }
  const output = new Map(bodies)
  const removedBlocks = new Set<IrBlockId>()
  let changedAny = false
  for (const [id, body] of bodies) {
    // These regions have entry/cleanup edges beyond ordinary terminators.
    // Keep their whole CFG until those edges have an explicit pruning recipe.
    const protectedFlow = Boolean(
      body.tryRegions.length || body.iteratorCloseRegions?.length || body.generator || body.generatorPrologueBoundary
    )
    const facts = new Map<string, boolean>()
    const operations = [...body.blocks.values()].flatMap((block) => block.operations)
    for (const operation of operations) {
      if (operation.kind !== 'get' && operation.kind !== 'phi') continue
      const truth = semantic.get(operation.lineage)
      if (truth !== undefined) facts.set(operation.result.id, truth)
    }
    for (const operation of operations) {
      if (operation.kind !== 'test' || operation.predicate !== 'to-boolean') continue
      const truth = facts.get(operation.value.value)
      if (truth !== undefined) facts.set(operation.result.id, truth)
    }
    const blocks = new Map(body.blocks)
    const expandedValues = new Map(body.values)
    let ordinal = 0
    let changed = false
    for (const [blockId, original] of blocks) {
      const operations = original.operations.flatMap((operation): IrNonTerminatorOperation[] => {
        if (
          operation.kind !== 'get' ||
          !absentReads.has(operation.lineage) ||
          operation.result.representation.kind !== 'undefined' ||
          !primitiveOrNullish(operation.receiver.representation)
        )
          return [operation]
        // The base/key evaluations are separate SSA operations and remain.
        // A nullable receiver retains GetV's RequireObjectCoercible step.
        // The existing IR primitive preserves its TypeError without boxing.
        changed = true
        const result: IrNonTerminatorOperation[] = []
        if (!nonNullPrimitive(operation.receiver.representation)) {
          while (expandedValues.has(irValueId(body.owner, ordinal))) ordinal++
          const checked = irValueId(body.owner, ordinal++)
          expandedValues.set(checked, operation.receiver.representation)
          result.push({
            kind: 'compute',
            lineage: operation.lineage,
            form: 'require-object-coercible',
            operator: 'RequireObjectCoercible',
            operands: [operation.receiver],
            result: { id: checked, representation: operation.receiver.representation }
          })
        }
        result.push({
          kind: 'constant' as const,
          lineage: operation.lineage,
          literal: 'undefined' as const,
          text: 'undefined',
          result: operation.result
        })
        return result
      })
      const block = { ...original, operations }
      blocks.set(blockId, block)
      if (protectedFlow || block.terminator.kind !== 'branch') continue
      const truth = facts.get(block.terminator.condition.value)
      if (truth === undefined) continue
      blocks.set(blockId, {
        ...block,
        terminator: {
          kind: 'jump',
          lineage: block.terminator.lineage,
          target: truth ? block.terminator.whenTrue : block.terminator.whenFalse
        }
      })
      changed = true
    }
    if (!changed) continue
    // Replacing a proven, non-throwing lookup does not change any region's
    // control flow. Keep that operation-level simplification even when this
    // pass cannot yet remove the region's exceptional or cleanup edges.
    if (protectedFlow) {
      output.set(id, { ...body, blocks, values: expandedValues })
      changedAny = true
      continue
    }
    const live = new Set([body.entry])
    const pending = [body.entry]
    while (pending.length) {
      const block = blocks.get(pending.pop()!)!
      for (const target of successorsOfTerminator(block.terminator))
        if (!live.has(target)) {
          live.add(target)
          pending.push(target)
        }
    }
    const retained = new Map<typeof body.entry, IrBlock>()
    const values = new Map<IrValueId, Representation>()
    for (const blockId of body.blockOrder) {
      if (!live.has(blockId)) {
        removedBlocks.add(blockId)
        continue
      }
      const block = blocks.get(blockId)!
      const next: IrBlock = {
        ...block,
        operations: block.operations.map((operation) =>
          operation.kind === 'phi'
            ? {
                ...operation,
                incoming: operation.incoming.filter(
                  (edge) => live.has(edge.block) && successorsOfTerminator(blocks.get(edge.block)!.terminator).includes(blockId)
                )
              }
            : operation
        )
      }
      retained.set(blockId, next)
      for (const operation of allOperationsOf(next)) {
        const result = resultOfIrOperation(operation)
        if (result) values.set(result.id, result.representation)
      }
    }
    const pruned = { ...body, blocks: retained, blockOrder: body.blockOrder.filter((block) => live.has(block)), values }
    const violations = verifyIrBody(pruned)
    if (violations.length) throw new Error(`Proven branch pruning produced invalid IR: ${JSON.stringify(violations)}`)
    output.set(id, pruned)
    changedAny = true
  }
  // Lowering records failed slot conversions before this CFG exists. Drop
  // only rows attached to blocks this pass has proved unreachable; unrelated
  // and surviving failures still reach the unchanged certification guard.
  return {
    bodies: changedAny ? output : bodies,
    slotDrift: removedBlocks.size ? slotDrift.filter((row) => !removedBlocks.has(row.block)) : slotDrift
  }
}
