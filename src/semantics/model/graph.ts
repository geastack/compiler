import type { OperationFamily, OperationId, RegionId, SemanticResultId, StructuralTypeId } from '../../identity/ids.js'
import { operationOfResult } from '../../identity/ids.js'
import type { SemanticEdge } from './edges.js'
import { edgeSource } from './edges.js'
import type { FamilyReport } from './coverage.js'
import { validateFamilyReport } from './coverage.js'
import type { SemanticOperation } from './operations.js'
import type { SemanticCaller } from './operands.js'
import type { StructuralType } from './structural-types.js'

/**
 * The sealed semantic-operation graph.
 *
 * This is the frontend/backend boundary. Everything after it consumes these
 * four tables and the coverage reports; nothing after it may open a TypeScript
 * AST or ask the checker a question. That restriction is the whole point: it is
 * what stops two layers from answering the same question differently.
 */

/** A non-function execution context. */
export interface SemanticRegion {
  readonly id: RegionId
  readonly role: 'module-body' | 'field-initializer' | 'static-block' | 'class-evaluation' | 'global'
  /** The executable subtree, distinct from the declaration that owns it. */
  readonly bodyNode: string
  readonly caller: SemanticCaller | null
}

export interface SemanticGraph {
  readonly regions: ReadonlyMap<RegionId, SemanticRegion>
  readonly structuralTypes: ReadonlyMap<StructuralTypeId, StructuralType>
  readonly operations: ReadonlyMap<OperationId, SemanticOperation>
  readonly edges: readonly SemanticEdge[]
  readonly coverage: ReadonlyMap<OperationFamily, FamilyReport>
  /** Every published result, so a consumer never re-derives one from an operation. */
  readonly results: ReadonlyMap<SemanticResultId, OperationId>
}

/** Adjacency built once from the edge table, for authority-connected traversal. */
export interface SemanticConnectivity {
  readonly outgoing: ReadonlyMap<OperationId, readonly OperationId[]>
  readonly incoming: ReadonlyMap<OperationId, readonly OperationId[]>
}

export const buildConnectivity = (graph: SemanticGraph): SemanticConnectivity => {
  const outgoing = new Map<OperationId, OperationId[]>()
  const incoming = new Map<OperationId, OperationId[]>()
  for (const operation of graph.operations.keys()) {
    outgoing.set(operation, [])
    incoming.set(operation, [])
  }
  const link = (from: OperationId, to: OperationId): void => {
    outgoing.get(from)?.push(to)
    incoming.get(to)?.push(from)
  }
  for (const edge of graph.edges) link(edgeSource(edge, operationOfResult), edge.to)

  // An operand naming another operation's result is an authority link, whether
  // or not an edge was also minted for it. Reading only the edge table would put
  // a call and its own callee in different components, which makes a component
  // one operation and per-component publication meaningless.
  for (const [id, operation] of graph.operations) {
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result') continue
      const producer = graph.results.get(operand.source.result)
      if (producer !== undefined && producer !== id) link(producer, id)
    }
  }
  return { outgoing, incoming }
}

/**
 * The authority-connected component containing `seed`.
 *
 * Traversal is undirected because a diagnostic must reach the producer that
 * failed as well as every consumer left without an answer. The result is sorted
 * so before/after component counts are comparable across runs.
 */
export const authorityComponent = (connectivity: SemanticConnectivity, seed: OperationId): readonly OperationId[] => {
  const seen = new Set<OperationId>([seed])
  const pending = [seed]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    for (const neighbour of [...(connectivity.outgoing.get(current) ?? []), ...(connectivity.incoming.get(current) ?? [])]) {
      if (seen.has(neighbour)) continue
      seen.add(neighbour)
      pending.push(neighbour)
    }
  }
  return [...seen].sort()
}

/**
 * The partition of one sealed graph, computed once for it.
 *
 * Three stages independently ask for this same answer -- carrier publication,
 * the capability census, and the diagnostic sweep -- and each was paying for its
 * own full connectivity build plus a sort of every operation identity in the
 * program. It is a pure function of a graph that is sealed before any of them
 * runs, so the second and third callers were re-deriving a fact that could not
 * have changed. Remembered by the graph rather than threaded through three
 * signatures because the graph is the thing the answer belongs to, and because
 * a `WeakMap` cannot outlive the compilation that built it.
 */
const partitions = new WeakMap<SemanticGraph, readonly (readonly OperationId[])[]>()

export const partitionAuthorityComponents = (graph: SemanticGraph): readonly (readonly OperationId[])[] => {
  const remembered = partitions.get(graph)
  if (remembered) return remembered
  const computed = computeAuthorityPartition(graph)
  partitions.set(graph, computed)
  return computed
}

const computeAuthorityPartition = (graph: SemanticGraph): readonly (readonly OperationId[])[] => {
  const connectivity = buildConnectivity(graph)
  const assigned = new Set<OperationId>()
  const components: (readonly OperationId[])[] = []
  for (const operation of [...graph.operations.keys()].sort()) {
    if (assigned.has(operation)) continue
    const component = authorityComponent(connectivity, operation)
    for (const member of component) assigned.add(member)
    components.push(component)
  }
  return components
}

/**
 * Structural validation of a sealed graph.
 *
 * Every check here is an invariant a consumer would otherwise have to re-prove.
 * A dangling edge, an unpublished result, or a family whose census does not add
 * up is a producer defect, and finding it at the boundary is far cheaper than
 * finding it as a wrong answer in emitted C++.
 */
export const validateGraph = (graph: SemanticGraph): void => {
  for (const report of graph.coverage.values()) validateFamilyReport(report)

  for (const [id, operation] of graph.operations) {
    if (operation.id !== id) throw new Error(`operation table key ${id} disagrees with operation identity ${operation.id}`)
    for (const result of operation.results) {
      const owner = graph.results.get(result.id)
      if (owner !== id) throw new Error(`result ${result.id} of operation ${id} is registered to ${owner ?? 'nothing'}`)
      if (!graph.structuralTypes.has(result.type))
        throw new Error(`result ${result.id} names structural type ${result.type} that is not interned`)
    }
    for (const operand of operation.operands) {
      if (!graph.structuralTypes.has(operand.type)) {
        throw new Error(`operand ${operand.role}#${operand.ordinal} of ${id} names structural type ${operand.type} that is not interned`)
      }
      if (operand.source.kind !== 'result') continue
      if (!graph.results.has(operand.source.result)) {
        throw new Error(`operand ${operand.role}#${operand.ordinal} of ${id} consumes unpublished result ${operand.source.result}`)
      }
    }
  }

  for (const edge of graph.edges) {
    const from = edgeSource(edge, operationOfResult)
    if (!graph.operations.has(from)) throw new Error(`edge of kind ${edge.kind} originates at unknown operation ${from}`)
    if (!graph.operations.has(edge.to)) throw new Error(`edge of kind ${edge.kind} terminates at unknown operation ${edge.to}`)
  }
}
