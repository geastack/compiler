import ts from 'typescript'

const transparentExpression = (node: ts.Expression): ts.Expression => {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

const classDeclarationOf = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.ClassLikeDeclaration | null => {
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.find((candidate) => ts.isClassLike(candidate))
  return declaration && ts.isClassLike(declaration) ? declaration : null
}

/**
 * A const whose initializer is a class value hidden only by type assertions.
 * The assertions allocate nothing and the const cannot change, so reading the
 * inner class preserves the runtime identity used by heritage and `super()`.
 */
export const transparentConstClassAliasTarget = (checker: ts.TypeChecker, node: ts.Expression): ts.Identifier | null => {
  if (!ts.isIdentifier(node)) return null
  const symbol = checker.getSymbolAtLocation(node)
  const declaration = symbol?.valueDeclaration
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
  if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return null
  const target = transparentExpression(declaration.initializer)
  if (!ts.isIdentifier(target)) return null
  const targetSymbol = checker.getSymbolAtLocation(target)
  return targetSymbol && classDeclarationOf(checker, targetSymbol) ? target : null
}
