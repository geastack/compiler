import ts from 'typescript'
import type { ProgramReachability } from '../../reachability.js'
import { cellCandidatesOf } from '../candidates.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidencePolicy } from '../policy.js'
import { rulesFor } from '../policy.js'
import { combineTypesByJoin, statedTypeOf } from './shared.js'

const isUnannotatedUninitializedField = (node: ts.Node): node is ts.PropertyDeclaration =>
  ts.isPropertyDeclaration(node) && node.type === undefined && node.initializer === undefined

/**
 * The FIELD domain: `field-bindings.ts`'s question, restated over the shared
 * flow index's `property-assignment` edge.
 *
 * Scoped to an explicit `PropertyDeclaration` with no initializer -- the
 * the shape called note 16 ("a `PropertyDeclaration` WITH an
 * initializer is not a candidate at all"). What is NOT ported: a field TypeScript
 * infers purely from a JS constructor's `this.x = v` with no
 * `PropertyDeclaration` node at all ("TS JS-class
 * inference decl"). `field-bindings.ts` keys that case by SYMBOL because there
 * is no declaration node to key it by, and this policy interface keys every
 * candidate by a `ts.Declaration` for `identities.declarationIdOf` -- the same
 * "one answer language" constraint this whole table exists to hold everyone
 * to. Closing that gap needs either a synthetic per-symbol identity or
 * widening `CellEvidencePolicy.candidatesOf` to a symbol-keyed variant; left
 * for a later step rather than forced here. See the report for the exact
 * count this leaves unproven.
 *
 * `flow/model.ts` already resolves `this.x = v` (and a subclass's write, and
 * `this.a.b = v`'s outer member) to THIS declaration by symbol identity
 * (`FlowTarget.symbol`/`.declaration`, `flow/model.ts`'s own header), so no
 * receiver-walk of this policy's own is needed -- exactly the property
 * `parameter.ts` and `return.ts` already lean on for their own edges.
 */
export const createFieldCellPolicy = (checker: ts.TypeChecker, reachable: ProgramReachability): CellEvidencePolicy => ({
  domain: 'field',
  candidatesOf: (files) => cellCandidatesOf(reachable, files, isUnannotatedUninitializedField),
  statedAt: (declaration) => statedTypeOf(checker, (declaration as ts.PropertyDeclaration).type),
  checkerAt: (declaration) => cellType(checker.getTypeAtLocation(declaration)),
  rules: rulesFor([
    ['property-assignment', (write): CellValue | null => (write.value ? cellType(checker.getTypeAtLocation(write.value)) : null)]
  ]),
  combine: combineTypesByJoin(checker)
})
