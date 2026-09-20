import type ts from 'typescript'
import { isUnusableEvidence, joinOfWrites } from '../../derived-expression-type.js'
import { cellType, type CellValue } from '../model.js'
import type { CellEvidenceContribution } from '../policy.js'

/**
 * The join itself, over plain `CellValue`s -- factored out of
 * `combineTypesByJoin` so `collection.ts`'s per-slot combine can apply the
 * SAME join twice (once for the key group, once for the value group)
 * instead of restating `joinOfWrites`'s unwrap-or-refuse rule a second time.
 */
export const joinCellTypeValues = (checker: ts.TypeChecker, values: readonly CellValue[]): ts.Type | null => {
  const types = values.flatMap((value) => (value.kind === 'type' ? [value.type] : []))
  if (types.length !== values.length) return null
  return joinOfWrites(checker, types)
}

/**
 * The combinator every `ts.Type`-space domain (parameter, return, local,
 * field) shares: the exact join `parameter-bindings.ts` and its siblings
 * already use over an argument/return/write set, reused rather than
 * re-derived -- `joinOfWrites` is a pure function these censuses already
 * export, and the rule to add exports only if a
 * policy needs to call an existing pure helper" is exactly this case.
 *
 * These four domains join their WHOLE cell into one answer, so the
 * `CellEvidenceContribution.write` half of each contribution (which slot,
 * which member) is simply not asked -- `collection`/`bag` are the two
 * domains where it is.
 */
export const combineTypesByJoin =
  (checker: ts.TypeChecker) =>
  (contributions: readonly CellEvidenceContribution[]): CellValue | null => {
    const joined = joinCellTypeValues(
      checker,
      contributions.map((contribution) => contribution.value)
    )
    return joined ? cellType(joined) : null
  }

/** The checker's own answer at a declaration, wrapped -- always present, the fallback of last resort. */
export const checkerTypeAt =
  (checker: ts.TypeChecker) =>
  (declaration: ts.Node): CellValue | null =>
    cellType(checker.getTypeAtLocation(declaration))

/**
 * The program's own annotation, when a declaration shape carries one and
 * states something usable -- `null` covers both "no annotation" and "the
 * annotation is `any`/`void`/`never`, i.e. states nothing more than the
 * checker's own vacuous answer would".
 */
export const statedTypeOf = (checker: ts.TypeChecker, typeNode: ts.TypeNode | undefined): CellValue | null => {
  if (!typeNode) return null
  const stated = checker.getTypeFromTypeNode(typeNode)
  return isUnusableEvidence(stated) ? null : cellType(stated)
}
