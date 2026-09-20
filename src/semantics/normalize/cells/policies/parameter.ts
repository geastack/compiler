import ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import { cellCandidatesOf } from '../candidates.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { checkerTypeAt, combineTypesByJoin, statedTypeOf } from './shared.js'

/**
 * The PARAMETER domain: `parameter-bindings.ts`'s question ("the type a
 * parameter the program never annotated is actually called with"), restated
 * as one evidence rule over the shared flow index's `call-argument` edge.
 *
 * `flow/model.ts` already resolves an argument to the callee's parameter slot
 * wherever the walk could name the callee (the value-flow survey's callee row), so
 * this policy does no call-site resolution of its own -- it reads
 * `flow.writesToDeclaration(parameter)` and asks only "does this edge state a
 * value", which is the one thing a `CellEvidenceRule` may ask.
 *
 * `parameter-bindings.ts` additionally refuses a parameter that escapes as a
 * value to an unresolved caller, is itself reassigned, or whose call sites'
 * types merely differ rather than provably agreeing (`widestOf`'s guard) --
 * none of that policy is re-implemented here. `joinOfWrites` (via
 * `combineTypesByJoin`) already returns `null` on genuine disagreement, so
 * soundness against a wrong join is unaffected; what is not yet ported is the
 * ESCAPE refusal, so this policy's write-join can be more OPTIMISTIC than the
 * existing census's about a parameter whose name leaks somewhere this domain
 * does not itself track. That is safe for phase 4.1 -- nothing downstream
 * reads this table -- and is exactly the "not yet a policy" gap this
 * refactor's report calls out for phase 4.2 to close before anything is
 * wired to replace `parameter-bindings.ts`.
 */
export const createParameterCellPolicy = (checker: ts.TypeChecker, reachable: ProgramReachability): CellEvidencePolicy => ({
  domain: 'parameter',
  candidatesOf: (files) =>
    cellCandidatesOf(
      reachable,
      files,
      (node): node is ts.ParameterDeclaration =>
        ts.isParameter(node) && node.type === undefined && ts.isIdentifier(node.name) && node.dotDotDotToken === undefined
    ),
  statedAt: (declaration) => statedTypeOf(checker, (declaration as ts.ParameterDeclaration).type),
  checkerAt: checkerTypeAt(checker),
  rules: rulesFor([
    ['call-argument', (write): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)]
  ]),
  combine: combineTypesByJoin(checker)
})
