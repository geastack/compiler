import type { OperationFamily, OperationId, RegionId, SemanticResultId } from '../../identity/ids.js'
import { operationFamilies } from '../../identity/ids.js'
import type { SemanticEdge } from '../model/edges.js'
import { edgeSource } from '../model/edges.js'
import type { SemanticGraph, SemanticRegion } from '../model/graph.js'
import { validateGraph } from '../model/graph.js'
import type { SemanticOperation } from '../model/operations.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { ProgramCensus } from './census.js'
import type { FamilyProducer } from './contribution.js'
import { publishProgram } from './contribution.js'
import type { CensusCandidate } from './census.js'

/**
 * The normalization driver.
 *
 * Producers are passed in rather than imported so that this driver cannot
 * acquire a hidden dependency on one family's implementation, and so a family
 * can be exercised in isolation. Every censused family either has a producer or
 * is reported `not-installed` with its complete candidate list -- there is no
 * third state where a family quietly contributes nothing.
 */

export interface NormalizationInput {
  readonly census: ProgramCensus
  readonly types: StructuralTypeTable
  /**
   * The producers for one monomorphized copy, given a candidate belonging to
   * it. A program with no generics asks this once and gets one set; a program
   * that instantiates a generic twice gets two, each resolving that generic's
   * type parameters as its own copy binds them.
   */
  readonly producers: (candidate: CensusCandidate) => readonly FamilyProducer[]
  /**
   * What distinguishes one monomorphized copy from another, for the purpose of
   * reusing a producer set.
   *
   * Supplied rather than derived, because deriving it needs the owner half of a
   * specialization path and this driver cannot see an AST. It must NOT be
   * `specializationKey`: that is an identity *suffix*, where the owner is
   * deliberately redundant because a node's own identity already says which
   * generic encloses it. Here the owner is the entire question -- two unrelated
   * generics each instantiated once both have ordinal path `0`, and a cache
   * keyed on that alone hands the second one the first one's view of which
   * nodes are inside a copy. Every identity that view then mints for a node it
   * does not recognize comes out unspecialized, so a body and the allocation
   * that gives it a calling convention end up disagreeing about which copy they
   * belong to.
   */
  readonly copyKey: (candidate: CensusCandidate) => string
  /**
   * The conditional edges no single producer can state, computed once every
   * operation exists. Kept as a callback so this driver still cannot see an
   * AST: it hands over the published operations and receives edges back.
   */
  readonly gates: (operations: ReadonlyMap<OperationId, SemanticOperation>) => readonly SemanticEdge[]
}

export interface NormalizationResult {
  readonly graph: SemanticGraph
  /** Families with no producer, reported rather than omitted. */
  readonly uninstalledFamilies: readonly OperationFamily[]
}

export const normalizeProgram = (input: NormalizationInput): NormalizationResult => {
  // One producer set per copy, built on first use and reused: the set is a
  // dozen closures and rebuilding it per candidate would rebuild it thousands
  // of times for one answer.
  const byCopy = new Map<string, ReadonlyMap<OperationFamily, FamilyProducer>>()
  const producersFor = (candidate: CensusCandidate): ReadonlyMap<OperationFamily, FamilyProducer> => {
    const key = input.copyKey(candidate)
    const cached = byCopy.get(key)
    if (cached) return cached
    const built = new Map(input.producers(candidate).map((producer) => [producer.family, producer]))
    byCopy.set(key, built)
    return built
  }
  const published = publishProgram(operationFamilies, producersFor, input.census.byFamily)

  const operations = new Map<OperationId, SemanticOperation>()
  const results = new Map<SemanticResultId, OperationId>()
  for (const operation of published.operations) {
    if (operations.has(operation.id)) {
      throw new Error(`operation ${operation.id} was published twice; one source operation must mint one identity`)
    }
    operations.set(operation.id, operation)
    for (const result of operation.results) {
      if (results.has(result.id)) throw new Error(`result ${result.id} was published twice`)
      results.set(result.id, operation.id)
    }
  }

  const regions = new Map<RegionId, SemanticRegion>()
  for (const region of input.census.regions.values()) regions.set(region.id, region)

  // An edge whose endpoints were withheld would dangle. Dropping it here keeps
  // the sealed graph internally consistent instead of leaving validation to
  // discover a half-published component -- the withholding itself is already
  // reported as a blocker, so nothing is hidden by this.
  const reaches = (edge: SemanticEdge): boolean => {
    if (!operations.has(edge.to)) return false
    if (edge.kind === 'value') return results.has(edge.result)
    if (edge.kind === 'conditional') return results.has(edge.guard)
    if (edge.kind === 'loop') return operations.has(edge.loop)
    return operations.has(edgeSource(edge, (result) => results.get(result) ?? ('' as OperationId)))
  }

  const graph: SemanticGraph = {
    regions,
    structuralTypes: input.types.seal(),
    operations,
    edges: [...published.edges, ...input.gates(operations)].filter(reaches),
    coverage: published.reports,
    results
  }

  validateGraph(graph)
  return {
    graph,
    uninstalledFamilies: operationFamilies.filter((family) => {
      const candidates = input.census.byFamily.get(family) ?? []
      const first = candidates[0]
      return first !== undefined && !producersFor(first).has(family)
    })
  }
}
