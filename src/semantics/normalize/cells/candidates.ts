import ts from 'typescript'
import { isAmbientDeclaration } from '../../ambient.js'
import { forEachReachableStatement, type ProgramReachability } from '../reachability.js'

/**
 * Every reachable node in the program that `test` admits -- one walk shared
 * by every domain's `candidatesOf`, instead of the six private walks
 * the value-flow survey measured (9, 4, 6, 7, 6 and 8 of them). A policy states
 * WHAT shape of declaration it is looking for; it never re-derives which part
 * of the program it is allowed to look at.
 *
 * Mirrors `census.ts`'s own walk: an ambient module's body describes host
 * values none of which execute, a type annotation contains no operations
 * (except the one a heritage clause's expression really evaluates), and a
 * class member the program never names is exactly as dead as an unreferenced
 * top-level declaration -- `reachability.ts` is the one authority on the
 * latter two, asked here for the identical reason `census.ts` asks it.
 */
export const cellCandidatesOf = <T extends ts.Node>(
  reachable: ProgramReachability,
  files: readonly ts.SourceFile[],
  test: (node: ts.Node) => node is T
): T[] => {
  const found: T[] = []
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && isAmbientDeclaration(node)) return
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
      if (reachable.memberIsPruned(node)) return
      if (test(node)) found.push(node)
      ts.forEachChild(node, visit)
    }
    forEachReachableStatement(reachable, file, visit)
  }
  return found
}
