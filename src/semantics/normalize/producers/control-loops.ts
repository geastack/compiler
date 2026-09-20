import ts from 'typescript'
import { normalCompletion, pureEffects, type SemanticOperand } from '../../model/operands.js'
import type { ControlOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { resolveExpressionOperand } from './boundary.js'
import { blocked, mintOperationId, operand } from './mint.js'

/**
 * The two loops driven by a boolean test -- `while`/counted `for`, and
 * `do`/`while` -- extracted from `control.ts` so that one file does not carry
 * both the whole control family and the block shapes its loops need.
 *
 * They are one module because they are one decision stated twice: the same
 * condition, cited the same way from the same producer, differing only in
 * which end of the iteration it sits at. `for`-`of`/`for`-`in` stay in
 * `control.ts` with `mintIteratorSteps`, since their iteration is a protocol
 * rather than a test.
 */

/** A loop this producer cannot serve, as the contribution its family returns. */
const blockedContribution = (candidate: CensusCandidate, reason: string): CandidateContribution => ({
  kind: 'blocked',
  blocker: blocked(candidate.id, 'control', reason, null)
})

export const contributeLoopCondition = (
  context: ProducerContext,
  candidate: CensusCandidate,
  condition: ts.Expression | undefined
): CandidateContribution | { readonly operand: SemanticOperand | null } => {
  if (!condition) return { operand: null }
  const guard = resolveExpressionOperand(context, condition)
  if (!guard) return blockedContribution(candidate, 'no normalized operation identifies the loop condition value')
  return { operand: operand('condition', 0, guard.source, guard.type) }
}

export const contributePlainLoop = (
  context: ProducerContext,
  candidate: CensusCandidate,
  condition: ts.Expression | undefined
): CandidateContribution => {
  const resolvedCondition = contributeLoopCondition(context, candidate, condition)
  if ('kind' in resolvedCondition) return resolvedCondition
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'loop',
    caller: candidate.caller,
    operands: resolvedCondition.operand ? [resolvedCondition.operand] : [],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

/**
 * `do { body } while (cond)` -- the one tail-tested loop the language spells.
 *
 * Structurally this is `contributePlainLoop` with the test moved to the other
 * end, and that is the whole of the difference: the same `'condition'` operand
 * naming the same citable result, minted under `'loop-tail'` so every consumer
 * that has to place a block knows which end the test sits at. The body is not
 * gated on the condition at all (`gating.ts` puts it in the loop scope with no
 * guard above it), which is exactly ECMA-262 14.7.2's `DoWhileLoopEvaluation`:
 * the statement runs, and only then is the expression evaluated to decide
 * whether to repeat.
 *
 * A condition that is a compile-time constant publishes no result to cite, so
 * there is nothing for the back edge's branch to test. `while (true)` is the
 * one such loop with a correct shape anyway -- an unconditional back edge --
 * and it reaches this producer with no operand at all, exactly as a head-tested
 * `while (true)` does. Every other constant (`while (false)` most of all) would
 * need a folded exit this loop shape does not build, and is refused by name
 * rather than compiled into a loop that never ends.
 */
export const contributeTailTestedLoop = (
  context: ProducerContext,
  candidate: CensusCandidate,
  condition: ts.Expression
): CandidateContribution => {
  const resolvedCondition = contributeLoopCondition(context, candidate, condition)
  if ('kind' in resolvedCondition) return resolvedCondition
  const conditionOperand = resolvedCondition.operand
  const alwaysTrue = condition.kind === ts.SyntaxKind.TrueKeyword
  if (conditionOperand && conditionOperand.source.kind !== 'result' && !alwaysTrue) {
    return blockedContribution(
      candidate,
      'a do-while whose condition is a compile-time constant other than `true` needs a folded exit the tail-tested loop shape does not build'
    )
  }
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'loop-tail',
    caller: candidate.caller,
    // A constant `true` carries no operand, so the back edge stays
    // unconditional -- the same shape `while (true)` already lowers to.
    operands: conditionOperand && conditionOperand.source.kind === 'result' ? [conditionOperand] : [],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}
