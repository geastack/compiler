import type ts from '#typescript'
import { operationId, semanticResultId } from '../../../identity/ids.js'
import type { CitationFacts } from './references.js'

/** A literal condition has no ordinary operation. The conditional producer
 * publishes this value coordinate; subtree gating cites exactly that result. */
export const constantConditionalGuardId = (condition: ts.Expression, facts: CitationFacts) =>
  operationId(facts.identities.nodeIdOf(condition), 'computation', 0)

export const constantConditionalGuardResult = (condition: ts.Expression, facts: CitationFacts) =>
  semanticResultId(constantConditionalGuardId(condition, facts), 'value')
