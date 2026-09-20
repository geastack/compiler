import type ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import type { ObjectBagIdentity } from '../../object-bag-bindings.js'
import { createBagCellPolicy } from './bag.js'
import { createCollectionCellPolicy } from './collection.js'
import { createFieldCellPolicy } from './field.js'
import { createLocalCellPolicy } from './local.js'
import { createParameterCellPolicy } from './parameter.js'
import { createReturnCellPolicy } from './return.js'
import type { CellEvidencePolicy } from '../policy.js'

export { createParameterCellPolicy } from './parameter.js'
export { createReturnCellPolicy } from './return.js'
export { createLocalCellPolicy } from './local.js'
export { createFieldCellPolicy } from './field.js'
export { createCollectionCellPolicy } from './collection.js'
export { createBagCellPolicy } from './bag.js'

/**
 * Five of the six domains are ported to an evidence policy as of this phase:
 * parameter, return, local, field (already `ts.Type`-space censuses), and now
 * collection (`CollectionTypeArguments`'s independent key/value pair -- see
 * `collection.ts`'s own header for what was and was not carried over).
 *
 * Porting `collection` needed a real extension to the shape, not a policy
 * bent to fit the existing one: `combine` used to receive a flat
 * `CellValue[]`, discarding which write and which slot produced each one, so
 * nothing could join K and V independently. `CellEvidenceContribution`
 * (`policy.ts`) pairs the value back with its `ValueWrite`, and `writesOf`
 * (also `policy.ts`) lets a policy widen WHERE evidence is gathered from
 * (`collection.ts`'s alias-closure walk) without forcing every other domain
 * to pay for a closure it never needed. Both are honest widenings of the
 * question `CellEvidencePolicy` can state, not a narrower reading of
 * `collection-bindings.ts`'s own question -- see `collection.ts` for the
 * three pieces of that census deliberately left unported and why each is
 * safe for this table's current, diagnostic-only readership.
 *
 * BAG is now here too, and the obstacle that kept it out was never "needs a
 * slot-aware rule" -- the frontend's evidence-policy tables
 * records the full history. `object-bag-bindings.ts`'s identity (which
 * declarations name the SAME bag) is not decided per write or even per
 * declaration -- it is the fixed point of a whole-program worklist
 * (`bagOf`/`returnsBag`, propagated through assignments, provably-exhaustive
 * `return`s, and one layer of callee-alias unwrapping, with `conflicted`/
 * `ungrounded` bookkeeping deciding which candidates survive), and a
 * `candidatesOf` that enumerates nodes by a per-node syntactic test --
 * everything this table's `cellCandidatesOf` walk assumes -- cannot state
 * "one candidate becomes known to be one cell only once a closure over the
 * WHOLE program has converged." The fix taken was the second of the two
 * choices this header used to weigh: `object-bag-bindings.ts` now publishes
 * that fixpoint as `ObjectBagCensus.identity` (`ObjectBagIdentity`), and
 * `bag.ts`'s policy consumes it rather than reimplementing it -- `bagIdentity`
 * is threaded in as a construction-time argument, not discovered via `files`,
 * because the fixpoint needs the whole program already settled before any
 * single node can be called a candidate.
 */
export const defaultCellEvidencePolicies = (
  checker: ts.TypeChecker,
  reachable: ProgramReachability,
  bagIdentity: ObjectBagIdentity
): readonly CellEvidencePolicy[] => [
  createParameterCellPolicy(checker, reachable),
  createReturnCellPolicy(checker, reachable),
  createLocalCellPolicy(checker, reachable),
  createFieldCellPolicy(checker, reachable),
  createCollectionCellPolicy(checker, reachable),
  createBagCellPolicy(checker, bagIdentity)
]
