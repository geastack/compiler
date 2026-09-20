import ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import { cellCandidatesOf } from '../candidates.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { combineTypesByJoin } from './shared.js'

const isUnannotatedUninitializedLocal = (node: ts.Node): node is ts.VariableDeclaration =>
  ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type === undefined && node.initializer === undefined

/**
 * The LOCAL domain: `local-bindings.ts`'s question ("an unannotated
 * `let`/`var` cell with no initializer, filled in by exactly the writes the
 * program makes to it"), restated over the shared flow index's
 * `identifier-assignment` and `logical-assignment` edges.
 *
 * `compound-assignment` (`x += 1`) is deliberately given no rule: per
 * `flow/model.ts`'s own doc, that edge states existence and a DERIVED value,
 * never a fresh one, so admitting it here would join the cell's own prior
 * (unknown) contents into its write-join. `rulesFor` skipping an edge is the
 * correct, sound default -- soundness cuts one way here:
 * missing evidence is a box, joining the wrong evidence is a silent
 * miscompile, and this domain refuses the second, never the first.
 */
export const createLocalCellPolicy = (checker: ts.TypeChecker, reachable: ProgramReachability): CellEvidencePolicy => {
  const valueRule = (write: { readonly value: ts.Expression | null }): CellValue | null =>
    write.value ? cellType(checker.getTypeAtLocation(write.value)) : null
  return {
    domain: 'local',
    candidatesOf: (files) => cellCandidatesOf(reachable, files, isUnannotatedUninitializedLocal),
    // Candidates have no annotation by construction; kept as a real read
    // rather than a constant `null` so a looser candidate set still gets a
    // correct answer instead of a silently stale one.
    statedAt: () => null,
    checkerAt: (declaration) => cellType(checker.getTypeAtLocation(declaration)),
    rules: rulesFor([
      ['identifier-assignment', valueRule],
      ['logical-assignment', valueRule]
    ]),
    combine: combineTypesByJoin(checker)
  }
}
