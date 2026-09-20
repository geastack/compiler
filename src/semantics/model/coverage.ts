import type { NodeId, OperationFamily, OperationId } from '../../identity/ids.js'

/**
 * Per-family coverage.
 *
 * An empty complete family and a family that was never installed are different
 * states, and conflating them is how a missing producer reads as "nothing to
 * do". A consumer may read a family only when its coverage is `complete`; a
 * `partial` family has published authoritative components but has not finished
 * its census, and `not-installed` has published nothing at all.
 */
export type FamilyCoverage = 'complete' | 'partial' | 'not-installed'

/**
 * A censused candidate that did not become a graph operation.
 *
 * The census is what makes "not installed" measurable. Every source site that
 * belongs to a family is either an operation or a blocker with a stated reason;
 * a site that is neither has been silently dropped.
 */
export interface CensusBlocker {
  readonly source: NodeId
  readonly family: OperationFamily
  /** Why this candidate could not be normalized. Stated as a missing capability. */
  readonly reason: string
  /** The primitive family whose absence blocks it, when one is identified. */
  readonly missingPrimitive: PrimitiveFamily | null
}

/**
 * The reusable primitive families. Every supported behavior reduces to one of
 * these; a proposed behavior that fits none of them is not yet designed.
 */
export const primitiveFamilies = [
  /** Values and CFG: truthiness, equality, typeof, joins, evaluation order. */
  'P0',
  /** Objects and properties: the object internal methods over any carrier. */
  'P1',
  /** Callables and closures: call, allocation, capture, escape. */
  'P2',
  /** Specialization and narrowing: one authority-connected fixed point. */
  'P3',
  /** Iterables and collections: iterator protocol plus Array/Map/Set. */
  'P4',
  /** Proxy and Reflect over the same object substrate. */
  'P5',
  /** Constructors and classes: newable values and construction semantics. */
  'P6',
  /** External host adapter: genuinely external, manifest-authenticated operations. */
  'H0'
] as const

export type PrimitiveFamily = (typeof primitiveFamilies)[number]

/**
 * The dependency order between primitive families.
 *
 * A family may only be built on families it depends on. P6 does not depend on
 * P5: ordinary construction must work before Proxy reuses it, and inverting
 * that is how proxies end up with a private construction path.
 */
export const primitiveDependencies: Readonly<Record<PrimitiveFamily, readonly PrimitiveFamily[]>> = Object.freeze({
  P0: [],
  P1: ['P0'],
  P2: ['P0'],
  P3: ['P0', 'P1', 'P2'],
  P4: ['P1', 'P3'],
  P6: ['P1', 'P2', 'P3'],
  P5: ['P1', 'P2', 'P3', 'P6'],
  H0: ['P1', 'P2']
})

/** What one family published, and what it could not. */
export interface FamilyReport {
  readonly family: OperationFamily
  readonly coverage: FamilyCoverage
  readonly operations: readonly OperationId[]
  readonly blockers: readonly CensusBlocker[]
  /** Candidates that contributed at least one operation. */
  readonly publishedCandidates: number
  /** Every candidate the census found, whether or not it became an operation. */
  readonly censusedCandidates: number
}

/**
 * Fail closed when a consumer reads a family that has not finished.
 *
 * The throw is the point: a consumer that treats `partial` as `complete` will
 * quietly compile a program whose missing operations were never lowered.
 */
export const requireCompleteFamily = (report: FamilyReport, consumer: string): void => {
  if (report.coverage === 'complete') return
  throw new Error(
    `${consumer} read family ${report.family} whose coverage is ${report.coverage}: ` +
      `${report.operations.length} operation(s) published, ${report.blockers.length} blocker(s) of ${report.censusedCandidates} candidate(s)`
  )
}

/**
 * A family is internally consistent when every candidate it censused either
 * published or is a stated blocker.
 *
 * The count is of CANDIDATES, not operations. One candidate can mint several
 * operations -- a compound assignment is a get, a computation and a set -- so
 * balancing operations against candidates would be a check that passes by
 * construction and proves nothing.
 */
export const validateFamilyReport = (report: FamilyReport): void => {
  const accounted = report.publishedCandidates + report.blockers.length
  if (accounted !== report.censusedCandidates) {
    throw new Error(
      `family ${report.family} censused ${report.censusedCandidates} candidate(s) but accounted for ${accounted}: ` +
        'every candidate must publish or become a stated blocker'
    )
  }
  if (report.coverage === 'complete' && report.blockers.length > 0) {
    throw new Error(`family ${report.family} claims complete coverage while holding ${report.blockers.length} blocker(s)`)
  }
  if (report.coverage === 'not-installed' && report.publishedCandidates > 0) {
    throw new Error(`family ${report.family} claims not-installed while ${report.publishedCandidates} candidate(s) published`)
  }
}
