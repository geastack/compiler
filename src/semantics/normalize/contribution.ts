import type { OperationFamily, SemanticResultId } from '../../identity/ids.js'
import type { CensusBlocker, FamilyCoverage, FamilyReport } from '../model/coverage.js'
import type { SemanticEdge } from '../model/edges.js'
import type { SemanticOperation } from '../model/operations.js'
import type { CensusCandidate } from './census.js'

/**
 * Publication transactions.
 *
 * Publication is transactional at the smallest complete authority-connected
 * component -- never at family scope. Family-global all-or-nothing publication
 * is forbidden precisely because it lets one blocked construct suppress an
 * unrelated one that was fully proven, which then reads as "the family is not
 * installed" and hides how much actually works.
 *
 * The scope that matters is the program, not the family. Producers cite each
 * other across families -- an invocation's callee is a reference, a loop's
 * element is a protocol result -- so a citation's producer often lives in a
 * different family than the citing operation. Deciding what commits one family
 * at a time cannot see those edges, and publishes operations whose operands name
 * results nobody published.
 */

/** What one candidate produced: operations and edges, or the reason it could not. */
export type CandidateContribution =
  | { readonly kind: 'operations'; readonly operations: readonly SemanticOperation[]; readonly edges: readonly SemanticEdge[] }
  | { readonly kind: 'blocked'; readonly blocker: CensusBlocker }

/** A family producer: it sees the census and returns one contribution per candidate. */
export interface FamilyProducer {
  readonly family: OperationFamily
  readonly contribute: (candidate: CensusCandidate) => CandidateContribution
}

export interface ProgramPublication {
  readonly reports: ReadonlyMap<OperationFamily, FamilyReport>
  readonly operations: readonly SemanticOperation[]
  readonly edges: readonly SemanticEdge[]
}

interface PreparedCandidate {
  readonly family: OperationFamily
  readonly candidate: CensusCandidate
  readonly operations: readonly SemanticOperation[]
  readonly edges: readonly SemanticEdge[]
  live: boolean
}

const resultsOf = (prepared: readonly PreparedCandidate[]): ReadonlySet<SemanticResultId> => {
  const published = new Set<SemanticResultId>()
  for (const entry of prepared) {
    if (!entry.live) continue
    for (const operation of entry.operations) {
      for (const result of operation.results) published.add(result.id)
    }
  }
  return published
}

/** The first operand of `entry` naming a result nobody published, if any. */
const danglingCitation = (entry: PreparedCandidate, published: ReadonlySet<SemanticResultId>): SemanticResultId | null => {
  for (const operation of entry.operations) {
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result') continue
      if (!published.has(operand.source.result)) return operand.source.result
    }
  }
  return null
}

/**
 * Withhold every candidate whose operands cite a result no producer published.
 *
 * Producers cite each other by recomputing the identity a sibling family will
 * mint, which is correct -- identity is deterministic -- but it is a prediction,
 * and the sibling may have been blocked or never installed. Committing the
 * citing operation anyway publishes an operand pointing at nothing.
 *
 * Withholding one candidate removes its results, which can strand a second, so
 * this runs to a fixed point rather than in a single pass.
 *
 * Withholding an INVOCATION is different in kind, and is reported as a root
 * rather than as a derived consequence. A withheld value is a value the citing
 * operation then does without; a withheld call is a call the source performs and
 * the program does not, while still emitting -- the operands stay materialised
 * and the emitter renders them as `(void)` discards. Three's
 * `materials.refreshFogUniforms( m_uniforms, fog )` was dropped exactly this way
 * for want of a `dictionary -> native-record-ref` argument conversion, so
 * The three.js app rendered with no fog at all and nothing in the report said so:
 * `diagnostics/sweep.ts` grades every `withheld:` reason `derived`, and the
 * coverage report filters those out by default. Naming the dropped call keeps
 * the guard fail-closed -- a missing conversion stays a compile-time answer
 * instead of becoming a silently wrong picture.
 */
const withholdDanglingCitations = (prepared: readonly PreparedCandidate[], blockers: Map<CensusCandidate, CensusBlocker>): void => {
  let changed = true
  while (changed) {
    changed = false
    const published = resultsOf(prepared)
    for (const entry of prepared) {
      if (!entry.live) continue
      const dangling = danglingCitation(entry, published)
      if (dangling === null) continue
      entry.live = false
      const dropsInvocation = entry.operations.some((operation) => operation.family === 'invocation')
      blockers.set(entry.candidate, {
        source: entry.candidate.id,
        family: entry.family,
        reason: dropsInvocation
          ? `dropped invocation: cites result ${dangling}, which no installed producer publishes`
          : `withheld: cites result ${dangling}, which no installed producer publishes`,
        missingPrimitive: null
      })
      changed = true
    }
  }
}

const coverageOf = (published: number, blocked: number): FamilyCoverage =>
  blocked === 0 ? 'complete' : published > 0 ? 'partial' : 'not-installed'

/**
 * One candidate's contribution, with a producer's own failure turned into a
 * stated blocker.
 *
 * A producer that throws has met a construct it cannot model. That is exactly
 * what a blocker records, and letting the throw escape instead takes down the
 * whole compilation over one node -- so a program containing a single
 * unmodelled expression reports nothing at all, when it could have reported
 * every other gap it has. Nothing is hidden by this: a blocker refuses the
 * certificate just as loudly, and it names the candidate.
 */
const contributionOf = (producer: FamilyProducer, candidate: CensusCandidate): CandidateContribution => {
  try {
    return producer.contribute(candidate)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const detail = process.env['GEA_PRODUCER_STACK_DEBUG'] && error instanceof Error && error.stack ? error.stack : message
    return {
      kind: 'blocked',
      blocker: {
        source: candidate.id,
        family: producer.family,
        reason: `producer failed: ${detail}`,
        missingPrimitive: null
      }
    }
  }
}

/**
 * Run every installed producer over its census and commit what survives.
 *
 * A family with no producer is not skipped: every candidate it censused becomes
 * a stated blocker, so "no producer" and "no such construct in this program"
 * stay different answers.
 */
/**
 * Producers for one monomorphized copy.
 *
 * A copy needs its own producer set because a producer closes over the
 * structural mapper it will ask, and `T` resolves differently in each copy. The
 * alternative -- threading the copy through every `typeAt` call in every
 * producer -- would put the same forwarded argument in a hundred signatures to
 * express one fact that belongs to the candidate.
 *
 * What must NOT be per copy is the ordinal counters the context carries: two
 * copies minting from independent counters would hand two different operations
 * the same identity. The caller keeps one context and swaps only its mapper,
 * which is why this is a lookup rather than a factory.
 */
export type ProducersFor = (candidate: CensusCandidate) => ReadonlyMap<OperationFamily, FamilyProducer>

export const publishProgram = (
  families: readonly OperationFamily[],
  producersFor: ProducersFor,
  census: ReadonlyMap<OperationFamily, readonly CensusCandidate[]>
): ProgramPublication => {
  const prepared: PreparedCandidate[] = []
  const blockers = new Map<CensusCandidate, CensusBlocker>()
  const candidateCount = new Map<OperationFamily, number>()

  for (const family of families) {
    const candidates = census.get(family) ?? []
    candidateCount.set(family, candidates.length)
    for (const candidate of candidates) {
      const producer = producersFor(candidate).get(family)
      if (!producer) {
        blockers.set(candidate, {
          source: candidate.id,
          family,
          reason: `family ${family} has no installed producer`,
          missingPrimitive: null
        })
        prepared.push({ family, candidate, operations: [], edges: [], live: false })
        continue
      }
      const contribution = contributionOf(producer, candidate)
      if (contribution.kind === 'blocked') {
        blockers.set(candidate, contribution.blocker)
        prepared.push({ family, candidate, operations: [], edges: [], live: false })
        continue
      }
      prepared.push({ family, candidate, operations: contribution.operations, edges: contribution.edges, live: true })
    }
  }

  withholdDanglingCitations(prepared, blockers)

  const operations: SemanticOperation[] = []
  const edges: SemanticEdge[] = []
  const publishedByFamily = new Map<OperationFamily, number>()
  const operationsByFamily = new Map<OperationFamily, SemanticOperation[]>()

  for (const entry of prepared) {
    if (!entry.live) continue
    publishedByFamily.set(entry.family, (publishedByFamily.get(entry.family) ?? 0) + 1)
    operations.push(...entry.operations)
    edges.push(...entry.edges)
    for (const operation of entry.operations) {
      // Attribution follows the operation's own family, not the candidate's: a
      // loop candidate mints the protocol operations its iteration needs, and
      // those belong to the protocol family's coverage.
      const bucket = operationsByFamily.get(operation.family) ?? []
      bucket.push(operation)
      operationsByFamily.set(operation.family, bucket)
    }
  }

  const blockersByFamily = new Map<OperationFamily, CensusBlocker[]>()
  for (const blocker of blockers.values()) {
    const bucket = blockersByFamily.get(blocker.family) ?? []
    bucket.push(blocker)
    blockersByFamily.set(blocker.family, bucket)
  }

  const reports = new Map<OperationFamily, FamilyReport>()
  for (const family of families) {
    const familyBlockers = blockersByFamily.get(family) ?? []
    const published = publishedByFamily.get(family) ?? 0
    reports.set(family, {
      family,
      coverage: coverageOf(published, familyBlockers.length),
      operations: (operationsByFamily.get(family) ?? []).map((operation) => operation.id),
      blockers: familyBlockers,
      publishedCandidates: published,
      censusedCandidates: candidateCount.get(family) ?? 0
    })
  }

  return { reports, operations, edges }
}
