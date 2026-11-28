import type ts from '#typescript'

/**
 * The checker's own union constructor, where the checker has one.
 *
 * `getUnionType` is internal to TypeScript's checker -- not on its public
 * `TypeChecker` -- so a checker may lack it, and every caller treats "no union
 * constructor" as "no answer". The typescript-go facade's checker declares it,
 * so a native build reads a typed member rather than one found through a cast.
 */
export const checkerHasUnion = (checker: ts.TypeChecker): boolean => 'getUnionType' in checker && typeof checker.getUnionType === 'function'

/** The union of `types` as the checker builds it, or `null` when it has no union constructor. */
export const checkerUnionOf = (checker: ts.TypeChecker, types: readonly ts.Type[]): ts.Type | null => {
  if (!('getUnionType' in checker) || typeof checker.getUnionType !== 'function') return null
  const union: ts.Type = checker.getUnionType(types)
  return union
}
