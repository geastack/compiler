import type ts from '#typescript'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import type { ComputationOperation } from '../../model/operations.js'
import { normalCompletion } from '../../model/operands.js'
import { authenticatedIntrinsicAccessorGetterOf } from '../intrinsic-accessor-getter.js'
import { intrinsicAccessorGetterOperator } from '../../model/intrinsic-accessor-getters.js'
import { mintOperationId, mintResult } from './mint.js'

/**
 * The authenticated chain's one operation: the builtin getter function itself
 * (`intrinsic-accessor-getter.ts` states why the links publish nothing).
 *
 * The identity stays the property candidate's, as `ObjectTag` keeps the
 * invocation's: whatever reads the `.get` value already cites that node.
 * Nothing in the chain can throw once authenticated -- every link is a
 * standard static on an intact intrinsic, and the descriptor is always
 * present -- and nothing it reads is program state.
 */
export const contributeIntrinsicAccessorGetter = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.Node
): CandidateContribution | null => {
  const chain = authenticatedIntrinsicAccessorGetterOf(context, node)
  if (chain === null) return null
  const id = mintOperationId(context.ordinals, candidate.id, 'property')
  const operation: ComputationOperation = {
    id,
    family: 'computation',
    caller: candidate.caller,
    form: 'unary',
    operator: intrinsicAccessorGetterOperator(chain.getter),
    operands: [],
    results: [mintResult(id, 'value', context.types.typeAt(node))],
    completion: normalCompletion,
    effects: { readsMutableState: false, writesMutableState: false, allocates: false, callsUserCode: false },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}
