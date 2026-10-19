import type { OperationFamily, OperationId, RegionId, SemanticResultId } from '../../identity/ids.js'
import { operationFamilies } from '../../identity/ids.js'
import { operationOfResult } from '../../identity/ids.js'
import type { GatedOperations, GateLink, GateScope, SemanticEdge, StatedEdge } from '../model/edges.js'
import { compactStatedEdges, edgeSource, edgesStatedBy, gateScopeSealer, SemanticEdgeTable } from '../model/edges.js'
import type { SemanticGraph, SemanticRegion } from '../model/graph.js'
import { PublishedResults, validateGraph } from '../model/graph.js'
import { internedText, internSealedFacts } from '../model/sealed-facts.js'
import type { SemanticOperation } from '../model/operations.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { ProgramCensus } from './census.js'
import type { FamilyProducer } from './contribution.js'
import { publishProgram } from './contribution.js'
import { createEvaluationOrdinals, createOrdinalCounter, type EvaluationOrdinals, type OrdinalCounter } from './producers/mint.js'
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

/**
 * The one pair of ordinal counters every producer mints from. Made by the
 * driver, which alone knows when minting is over: they hold an entry per
 * minted operation, and nothing reads them once every candidate has produced.
 */
export interface ProducerMinting {
  readonly ordinals: OrdinalCounter
  readonly evaluationOrdinals: EvaluationOrdinals
}

export interface NormalizationInput {
  /** Consumed: normalization takes every candidate out of it, leaving its regions. */
  readonly census: ProgramCensus
  readonly types: StructuralTypeTable
  /**
   * The producers for one monomorphized copy, given a candidate belonging to
   * it. A program with no generics asks this once and gets one set; a program
   * that instantiates a generic twice gets two, each resolving that generic's
   * type parameters as its own copy binds them.
   */
  readonly producers: (candidate: CensusCandidate, minting: ProducerMinting) => readonly FamilyProducer[]
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
   * AST: it hands over the published operations and receives each gated
   * operation's chain of scopes back -- one edge per link, stated once per chain.
   */
  readonly gates: (operations: ReadonlyMap<OperationId, SemanticOperation>) => GatedOperations
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
  let minting: ProducerMinting | null = { ordinals: createOrdinalCounter(), evaluationOrdinals: createEvaluationOrdinals() }
  const producersFor = (candidate: CensusCandidate): ReadonlyMap<OperationFamily, FamilyProducer> => {
    const key = input.copyKey(candidate)
    const cached = byCopy.get(key)
    if (cached) return cached
    if (minting === null) throw new Error('a producer set was asked for after minting ended')
    const built = new Map(input.producers(candidate, minting).map((producer) => [producer.family, producer]))
    byCopy.set(key, built)
    return built
  }
  // Normalization consumes the census. Each family's candidates go once that
  // family has produced; the census itself keeps none of them, nor does the
  // caller's view of it -- a 48K-line app's 211k candidates were otherwise
  // alive to the end of normalization, its peak. Only the first candidate of
  // each family is kept, to answer which families have no producer.
  const firstCandidates = new Map<OperationFamily, CensusCandidate>()
  const drained = new Map<OperationFamily, readonly CensusCandidate[]>()
  for (const [family, candidates] of input.census.byFamily) {
    drained.set(family, candidates)
    const first = candidates[0]
    if (first !== undefined) firstCandidates.set(family, first)
  }
  ;(input.census.byFamily as Map<OperationFamily, readonly CensusCandidate[]>).clear()
  ;(input.census.candidates as CensusCandidate[]).length = 0
  // Sealed as each candidate contributes rather than once all have: the
  // unsealed copies of every operation's identities and facts were otherwise
  // all alive together at the end of publication, the frontend's peak.
  const published = publishProgram(operationFamilies, producersFor, drained, internSealedFacts())
  // Every producer set exists by now -- each first candidate asked for its own
  // -- so this is answered from the cache, which then goes with the counters
  // its producers closed over, before the graph's tables are built.
  const uninstalledFamilies = operationFamilies.filter((family) => {
    const first = firstCandidates.get(family)
    return first !== undefined && !producersFor(first).has(family)
  })
  byCopy.clear()
  minting = null

  const operations = new Map<OperationId, SemanticOperation>()
  // Only a result whose identity does not name its own operation needs an
  // entry of its own; every other one is answered by the operation table.
  const foreignResults = new Map<SemanticResultId, OperationId>()
  let resultCount = 0
  for (const operation of published.operations) {
    if (operations.has(operation.id)) {
      throw new Error(`operation ${operation.id} was published twice; one source operation must mint one identity`)
    }
    operations.set(operation.id, operation)
  }
  for (const operation of operations.values()) {
    const { results } = operation
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!
      // Two results share an identity only within one operation, or when one
      // of them does not name its own publisher.
      for (let earlier = 0; earlier < index; earlier++)
        if (results[earlier]!.id === result.id) throw new Error(`result ${result.id} was published twice`)
      const named = operations.get(operationOfResult(result.id))
      if (named === operation) {
        if (foreignResults.has(result.id)) throw new Error(`result ${result.id} was published twice`)
      } else {
        if (foreignResults.has(result.id) || named?.results.some((other) => other.id === result.id))
          throw new Error(`result ${result.id} was published twice`)
        foreignResults.set(result.id, operation.id)
      }
      resultCount++
    }
  }
  const results = new PublishedResults(operations, foreignResults, resultCount)

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

  // The gating walk's links pass the same filter its materialized edges did,
  // decided once per shared chain rather than once per operation inside it.
  const linkReaches = (link: GateLink): boolean => {
    if (link.kind === 'guard') return results.has(link.guard)
    return operations.has(link.kind === 'region' ? link.region : link.loop)
  }
  const gated = input.gates(operations)
  const sealChain = gateScopeSealer()
  const sealedChains = new Map<readonly GateLink[], GateScope | null>()
  const gatedOperations: OperationId[] = []
  const innermostScopes: GateScope[] = []
  for (let index = 0; index < gated.operations.length; index++) {
    const chain = gated.chains[index]!
    // An operation that was withheld would be every edge's dangling `to`.
    const to = operations.get(gated.operations[index]!)?.id
    if (to === undefined) continue
    let innermost = sealedChains.get(chain)
    if (innermost === undefined) {
      const reaching = chain.filter(linkReaches)
      for (const link of reaching)
        if (link.kind === 'guard' && !Object.isFrozen(link)) (link as { guard: SemanticResultId }).guard = internedText(link.guard)
      innermost = sealChain(reaching)
      sealedChains.set(chain, innermost)
    }
    if (innermost === null) continue
    gatedOperations.push(to)
    innermostScopes.push(innermost)
  }

  // An operation standing for its value edges stands for them only while all
  // of them reach; otherwise the ones that do are stated one by one, which is
  // what filtering the uncompacted edges kept.
  const reachingEdges: StatedEdge[] = []
  for (const entry of published.edges) {
    if (!('family' in entry)) {
      if (reaches(entry)) reachingEdges.push(entry)
      continue
    }
    let all = true
    for (const edge of edgesStatedBy(entry))
      if (!reaches(edge)) {
        all = false
        break
      }
    if (all) reachingEdges.push(entry)
    else for (const edge of edgesStatedBy(entry)) if (reaches(edge)) reachingEdges.push(edge)
  }

  const graph: SemanticGraph = {
    regions,
    structuralTypes: input.types.seal(),
    operations,
    edges: new SemanticEdgeTable(
      compactStatedEdges(reachingEdges, (id) => operations.get(id)),
      {
        operations: gatedOperations,
        innermost: innermostScopes
      }
    ),
    coverage: published.reports,
    results
  }

  validateGraph(graph)
  return {
    graph,
    uninstalledFamilies
  }
}
