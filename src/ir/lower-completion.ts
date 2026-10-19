import type { OperationId } from '../identity/ids.js'
import { edgesOfKind } from '../semantics/model/edges.js'
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
 *
 * A transfer leaving a try-with-finally states two completion edges: the
 * interception, to the clause's `finally-region` boundary, and the transfer
 * itself. The jump is the transfer; the clause runs because the jump leaves
 * the try region, which the emitter reroutes through the clause (the scope
 * guard, or the exit dispatch of a finally that suspends).
 */

const transferEdgeOf = (graph: SemanticGraph, from: OperationId, completion: 'break' | 'continue') => {
  for (const candidate of edgesOfKind(graph.edges, 'completion')) {
    if (candidate.from !== from || candidate.completion !== completion) continue
    const target = graph.operations.get(candidate.to)
    if (!(target?.family === 'boundary' && target.boundary === 'finally-region')) return candidate
  }
  return undefined
}

/** The operation a `break`/`continue` transfers to, as the graph states it. */
export const completionTargetOf = (graph: SemanticGraph, from: OperationId, completion: 'break' | 'continue'): OperationId | null =>
  transferEdgeOf(graph, from, completion)?.to ?? null

export const findCompletionTargetBlock = (
  graph: SemanticGraph,
  blockStarts: ReadonlyMap<OperationId, IrBlockId>,
  from: OperationId,
  completion: 'break' | 'continue'
): IrBlockId => {
  const edge = transferEdgeOf(graph, from, completion)
  if (!edge) throw new IrLoweringBlockedError(`no completion edge of kind "${completion}" names a target for this control operation`)
  const target = blockStarts.get(edge.to)
  if (!target) {
    throw new IrLoweringBlockedError(
      `the "${completion}" target has not been lowered to a block yet; a forward transfer to a not-yet-processed operation is not supported`
    )
  }
  return target
}
