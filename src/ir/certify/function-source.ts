import type { SemanticResultId } from '../../identity/ids.js'
import { producerEdges, type SemanticEdges, type ValueEdge } from '../../semantics/model/edges.js'
import type { SemanticGraph } from '../../semantics/model/graph.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'

/** The members whose read certification asks for every value user of the read. */
const directCallMemberKeys: ReadonlySet<string> = new Set<string>(['toString', 'call', 'apply', 'bind'])

interface DirectCallMemberUsers {
  readonly edges: SemanticEdges
  readonly operations: SemanticGraph['operations']
  readonly candidates: ReadonlySet<SemanticResultId>
  readonly users: ReadonlyMap<SemanticResultId, readonly ValueEdge[]>
}

const directCallMemberUsers = new WeakMap<SemanticGraph, DirectCallMemberUsers>()

/**
 * The producers' value edges citing `result`, in table order -- the
 * subsequence a scan of `producerEdges` filtered to that result yields.
 *
 * Each `.toString`/`.call`/`.apply`/`.bind` read used to scan the whole edge
 * table for its users, so certification cost those reads times every edge of
 * the program. One scan now indexes the users of every such read; a result
 * that is not one (an operation outside this graph) is still answered by the
 * full scan.
 */
export const directCallMemberUsersOf = (graph: SemanticGraph, result: SemanticResultId): readonly ValueEdge[] => {
  let index = directCallMemberUsers.get(graph)
  if (index === undefined || index.edges !== graph.edges || index.operations !== graph.operations) {
    const candidates = new Set<SemanticResultId>()
    for (const operation of graph.operations.values()) {
      if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) continue
      const key = operandOf(operation, 'key')
      if (key?.source.kind !== 'constant' || !directCallMemberKeys.has(key.source.text)) continue
      for (const candidate of operation.results) if (candidate.role === 'value') candidates.add(candidate.id)
    }
    const users = new Map<SemanticResultId, ValueEdge[]>()
    for (const edge of producerEdges(graph.edges)) {
      if (edge.kind !== 'value' || !candidates.has(edge.result)) continue
      const known = users.get(edge.result)
      if (known) known.push(edge)
      else users.set(edge.result, [edge])
    }
    index = { edges: graph.edges, operations: graph.operations, candidates, users }
    directCallMemberUsers.set(graph, index)
  }
  if (index.candidates.has(result)) return index.users.get(result) ?? []
  const scanned: ValueEdge[] = []
  for (const edge of producerEdges(graph.edges)) if (edge.kind === 'value' && edge.result === result) scanned.push(edge)
  return scanned
}

/** Only direct calls are implemented: an extracted builtin must not bind itself to the original function. */
export const isDirectFunctionSourceRead = (graph: SemanticGraph, operation: SemanticOperation): boolean => {
  if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) return false
  const key = operandOf(operation, 'key')
  const receiver = operandOf(operation, 'receiver')
  if (key?.source.kind !== 'constant' || key.source.text !== 'toString' || receiver?.source.kind !== 'result') return false
  const result = operation.results.find((candidate) => candidate.role === 'value')
  if (!result) return false
  let calls = 0
  for (const edge of directCallMemberUsersOf(graph, result.id)) {
    const user = graph.operations.get(edge.to)
    if (edge.role !== 'callee' || user?.family !== 'invocation' || user.internalMethod !== 'call' || user.optionalChain) return false
    const supplied = operandOf(user, 'receiver')
    if (supplied?.source.kind !== 'result' || supplied.source.result !== receiver.source.result) return false
    if (user.operands.some((operand) => operand.role === 'spread-argument')) return false
    calls++
  }
  return calls > 0
}
