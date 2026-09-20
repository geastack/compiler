import type { OperationId } from '../identity/ids.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import type { IrBlockId } from './model.js'

/**
 * Where a `break` or `continue` lands.
 *
 * The graph states it as a completion edge, so both answers -- which operation
 * the transfer targets, and which block that operation was lowered into -- are
 * read from that one edge rather than re-derived from the syntax the transfer
 * sat in. A forward transfer to an operation this owner has not lowered yet is
 * refused rather than pointed at a block that does not exist.
 */

/** The operation a `break`/`continue` transfers to, as the graph states it. */
export const completionTargetOf = (graph: SemanticGraph, from: OperationId, completion: 'break' | 'continue'): OperationId | null => {
  const edge = graph.edges.find(
    (candidate) => candidate.kind === 'completion' && candidate.from === from && candidate.completion === completion
  )
  return edge ? edge.to : null
}

export const findCompletionTargetBlock = (
  graph: SemanticGraph,
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  from: OperationId,
  completion: 'break' | 'continue'
): IrBlockId => {
  const edge = graph.edges.find(
    (candidate) => candidate.kind === 'completion' && candidate.from === from && candidate.completion === completion
  )
  if (!edge) throw new IrLoweringBlockedError(`no completion edge of kind "${completion}" names a target for this control operation`)
  const target = blockStarts.get(edge.to)
  if (!target) {
    throw new IrLoweringBlockedError(
      `the "${completion}" target has not been lowered to a block yet; a forward transfer to a not-yet-processed operation is not supported`
    )
  }
  return target
}
