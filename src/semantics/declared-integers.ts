import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/**
 * The opt-in machine integers: a binding annotated `int` (64-bit) or `i32`
 * (32-bit) is held in that integer, not in a double.
 *
 * Both are declared by `@geastack/core` as branded Numbers
 * (`number & { readonly [brand]?: never }`), so under Node they ARE numbers and
 * every assignment type-checks without a cast. The annotation is the program
 * accepting integer semantics for that binding: a store truncates toward zero,
 * arithmetic stays in the integer and wraps at its width, and `/` whose answer
 * only ever lands in such a binding divides in the integers. That is what makes
 * them the safe fallback the magnitude census cannot reach on its own -- it
 * narrows a Number only where it can PROVE the double and the integer agree,
 * and an unbounded recurrence (`v = 3 * v + 1`) never proves that.
 *
 * Matched by alias name, as the brand is erased by every transform that runs
 * before this: the checker reads the original program.
 */
export type DeclaredIntegerWidth = 'int64' | 'int32'

const widthByAlias: ReadonlyMap<string, DeclaredIntegerWidth> = new Map([
  ['int', 'int64'],
  ['i64', 'int64'],
  ['int64', 'int64'],
  ['i32', 'int32'],
  ['int32', 'int32']
])

/** The width a type annotation opts its binding into, or `null` for an ordinary Number. */
export const declaredIntegerWidthOf = (type: ts.Type): DeclaredIntegerWidth | null => {
  const width = type.aliasSymbol ? widthByAlias.get(type.aliasSymbol.name) : undefined
  if (width === undefined) return null
  // Only the branded-Number shape: a program's own `type int = string` is not an opt-in.
  const members = type.isIntersection() ? type.types : [type]
  return members.some((member) => (member.flags & ts.TypeFlags.Number) !== 0) ? width : null
}

export const censusDeclaredIntegers = (
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identities: IdentityTable
): ReadonlyMap<DeclarationId, DeclaredIntegerWidth> => {
  const declared = new Map<DeclarationId, DeclaredIntegerWidth>()
  for (const file of sourceFiles) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
        const width = declaredIntegerWidthOf(node.type ? checker.getTypeFromTypeNode(node.type) : checker.getTypeAtLocation(node))
        if (width !== null) declared.set(identities.declarationIdOf(node), width)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return declared
}
