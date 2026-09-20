import type { SemanticGraph } from '../../semantics/model/graph.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { SemanticOperation } from '../../semantics/model/operations.js'

/** Only direct calls are implemented: an extracted builtin must not bind itself to the original function. */
export const isDirectFunctionSourceRead = (graph: SemanticGraph, operation: SemanticOperation): boolean => {
  if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) return false
  const key = operandOf(operation, 'key')
  const receiver = operandOf(operation, 'receiver')
  if (key?.source.kind !== 'constant' || key.source.text !== 'toString' || receiver?.source.kind !== 'result') return false
  const result = operation.results.find((candidate) => candidate.role === 'value')
  if (!result) return false
  let calls = 0
  for (const edge of graph.edges) {
    if (edge.kind !== 'value' || edge.result !== result.id) continue
    const user = graph.operations.get(edge.to)
    if (edge.role !== 'callee' || user?.family !== 'invocation' || user.internalMethod !== 'call' || user.optionalChain) return false
    const supplied = operandOf(user, 'receiver')
    if (supplied?.source.kind !== 'result' || supplied.source.result !== receiver.source.result) return false
    if (user.operands.some((operand) => operand.role === 'spread-argument')) return false
    calls++
  }
  return calls > 0
}
