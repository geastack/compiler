import ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import { cellCandidatesOf } from '../candidates.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { combineTypesByJoin, statedTypeOf } from './shared.js'

type ReturnLikeDeclaration =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.GetAccessorDeclaration

const isReturnLikeCandidate = (node: ts.Node): node is ReturnLikeDeclaration =>
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node)) &&
  node.body !== undefined &&
  node.type === undefined

/**
 * The RETURN domain: `return-bindings.ts`'s question, restated as one
 * evidence rule over the shared flow index's `return` edge, exactly the way
 * `parameter-bindings.ts` restates as `call-argument`.
 *
 * `flow/model.ts` already resolves a `return expr` to its ENCLOSING
 * function's return cell (the value-flow survey's `RET: Y` column), so
 * `flow.writesToDeclaration(declaration)` needs no recursion tracking of its
 * own here -- unlike `return-bindings.ts`'s `resolvedReturnTypeOf`, which
 * exists mainly to CALL a not-yet-settled callee's return from a parameter
 * census, a question this policy does not answer at all (that is
 * `parameter-bindings.ts`'s own internal fixpoint, item 8 of the edge
 * matrix, and not a write-join over one cell's own writes).
 *
 * `checkerAt` reads the SIGNATURE's return type, not
 * `checker.getTypeAtLocation(declaration)` -- the latter is the function's
 * own callable type (`() => number`), and this domain's cell is what the
 * body produces, not the function object itself. This is the one place the
 * "checker" primitive is not a plain `getTypeAtLocation` call, because the
 * declaration node names two different cells depending on who reads it: the
 * ALLOCATION producer wants the callable, this domain wants the result.
 */
export const createReturnCellPolicy = (checker: ts.TypeChecker, reachable: ProgramReachability): CellEvidencePolicy => ({
  domain: 'return',
  candidatesOf: (files) => cellCandidatesOf(reachable, files, isReturnLikeCandidate),
  statedAt: (declaration) => statedTypeOf(checker, (declaration as ReturnLikeDeclaration).type),
  checkerAt: (declaration) => {
    const signature = checker.getSignatureFromDeclaration(declaration as ReturnLikeDeclaration)
    return cellType(signature ? signature.getReturnType() : checker.getTypeAtLocation(declaration))
  },
  rules: rulesFor([['return', (write): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)]]),
  combine: combineTypesByJoin(checker)
})
