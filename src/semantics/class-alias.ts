import ts from 'typescript'

import { unwrapErasedExpression } from './normalize/producers/erasure.js'

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
  // An import names the alias through its own symbol, which has no value declaration of its own.
  const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  const declaration = resolved?.valueDeclaration
  return declaration && ts.isVariableDeclaration(declaration) ? transparentClassAliasDeclarationTarget(checker, declaration) : null
}

/**
 * The same answer asked of the `const` DECLARATION itself, so the cell and
 * every reference to it name one class (`structural.ts`'s
 * `physical-class-alias` rule reads both through here).
 */
export const transparentClassAliasDeclarationTarget = (
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration
): ts.Identifier | null => {
  if (!declaration.initializer) return null
  if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return null
  const target = unwrapErasedExpression(declaration.initializer)
  if (!ts.isIdentifier(target)) return null
  const targetSymbol = checker.getSymbolAtLocation(target)
  return targetSymbol && classDeclarationOf(checker, targetSymbol) ? target : null
}

/**
 * The class `extends` names, for IDENTITY: ancestry and layout. It follows a
 * transparent `const` alias anywhere, an imported one included, because the
 * question is which class declaration the base is.
 */
export const classHeritageTarget = (checker: ts.TypeChecker, expression: ts.Expression): ts.Expression => {
  const value = unwrapErasedExpression(expression)
  return transparentConstClassAliasTarget(checker, value) ?? value
}

/**
 * The class VALUE `extends` evaluates, for lowering: the alias target only when
 * it is in the same file, since an expression from another module has no
 * result in this owner. A URL module that exported
 * `const URLAlias = URL` showed it: a package's
 * `class LooseURL extends URL` resolved through that import to the
 * `URL` read inside the URL module, and lowering its module body refused
 * ("a value produced by a different owner needs capture lowering"). The import
 * itself reads the same class object through its binding.
 */
export const evaluatedClassHeritage = (checker: ts.TypeChecker, expression: ts.Expression): ts.Expression => {
  const value = unwrapErasedExpression(expression)
  const target = transparentConstClassAliasTarget(checker, value)
  return target !== null && target.getSourceFile() === value.getSourceFile() ? target : value
}

/**
 * The class symbol a read of a `const` alias of a GENERIC class denotes.
 *
 * JavaScript has one class object, so `const Alias = Generic` followed by
 * `new Alias<X>()` is `new Generic<X>()`. The alias cell cannot carry that: a
 * generic class is several physical classes, one per layout, and a single cell
 * holds one copy's constructor object, so a read at any other instantiation
 * needs a conversion between constructor objects that does not exist. Reading
 * the class itself lets every site name its own copy. A non-generic class has
 * one physical class and one constructor object, so its alias cell is exact and
 * stays a cell.
 */
export const genericClassAliasTargetSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | null => {
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
  const declaration = resolved.valueDeclaration
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null
  const target = transparentClassAliasDeclarationTarget(checker, declaration)
  if (!target) return null
  const targetSymbol = checker.getSymbolAtLocation(target)
  if (!targetSymbol) return null
  const classDeclaration = classDeclarationOf(checker, targetSymbol)
  return classDeclaration && (classDeclaration.typeParameters?.length ?? 0) > 0 ? targetSymbol : null
}
