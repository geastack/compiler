/**
 * Which write-discovery census refused.
 *
 * The same six domains `cells/` registers as evidence policies, plus
 * `jsdoc-type-name`, the one smaller census that publishes a refusal
 * vocabulary of its own. A domain is spelled once, here, because it is half of
 * a refusal's key and a domain spelled twice is two vocabularies.
 */
export type CensusDomain = 'parameter' | 'return' | 'local' | 'field' | 'collection' | 'bag' | 'jsdoc-type-name'

/**
 * `census:<domain>:<root>` -- the ROOT, never the prose.
 *
 * A refusal's key is what groups it with the others that share a cause, so it
 * must name the cause and nothing else: no node text, no type spelling, no
 * count, nothing that varies between two instances of one defect. The prose
 * belongs in `reason`, where it can name the specific node. This is the same
 * split `cells/model.ts`'s `CellRefusalKey` already makes, and the same reason
 * `parameter-bindings.ts` keyed its count map by reason rather than by site.
 */
export type CensusRefusalKey = `census:${CensusDomain}:${string}`

/**
 * A census refusal in the compiler's one refusal vocabulary
 * (`ir/refusal.ts`'s `Refusal`).
 *
 * These used to be eight private `ReadonlyMap<string, number>`s of hand-written
 * prose -- a count per reason, with no owner, reaching `CompileResult` only as
 * `censusAccounting` and never joining `CompileResult.refusals` the way every
 * other stage's refusals do. A count says a cell went untyped; it cannot say
 * WHICH cell, so nothing downstream could act on one and nothing did. Carrying
 * the owner is what makes a census refusal the same kind of object as an ABI
 * blocker or a print refusal, and lets one list answer "what did this
 * compilation refuse, and where" (the frontend is replaced, not instrumented).
 *
 * Declared here rather than as an `ir/refusal.ts` `Refusal` for the reason
 * `cells/model.ts` already gives for `CellRefusal`: the frontend settles long
 * before there is a plan to certify against, and semantics must not import the
 * IR to name its own refusals. `compiler.ts` sees both layers and is where the
 * two lists join.
 */
export interface CensusRefusal {
  readonly stage: 'census'
  readonly key: CensusRefusalKey
  readonly reason: string
  readonly owner: string
}

/**
 * State a refusal.
 *
 * `owner` is the declaration, node or symbol the refusal is attributed to,
 * already rendered -- the census knows how to name its own subject and the
 * refusal list must not depend on an identity table to read one.
 */
export const censusRefusal = (domain: CensusDomain, root: string, reason: string, owner: string): CensusRefusal => ({
  stage: 'census',
  key: `census:${domain}:${root}`,
  reason,
  owner
})

/**
 * The count-per-reason map the censuses used to publish, derived.
 *
 * Kept because instruments already read that shape, and DERIVED rather than
 * maintained beside the list so the two cannot disagree -- a count that drifts
 * from the refusals it counts is the two-authorities defect this refactor
 * exists to remove, in miniature.
 */
export const censusRefusalCounts = (refusals: readonly CensusRefusal[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const refusal of refusals) counts.set(refusal.key, (counts.get(refusal.key) ?? 0) + 1)
  return counts
}
