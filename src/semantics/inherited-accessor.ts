import ts from 'typescript'
import { heritageClassOrInterfaceOf } from './normalize/flow/model.js'

/**
 * JS assignment inference can publish a subclass Property symbol even when
 * `this.x = value` invokes an inherited accessor. That symbol describes a
 * write, not a new own field. Explicit class fields still define own storage.
 */
export const inheritedAccessorOfAssignment = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | null => {
  const declarations = symbol.declarations
  if (
    !declarations?.length ||
    !declarations.every((node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  )
    return null
  let owner: ts.Node | undefined = declarations[0]?.parent
  while (owner && !ts.isClassLike(owner)) owner = owner.parent
  if (!owner || !ts.isClassLike(owner)) return null
  const type = checker.getTypeAtLocation(owner)
  if (!type.isClassOrInterface()) return null
  const seen = new Set<ts.Type>()
  const find = (base: ts.BaseType): ts.Symbol | null => {
    if (seen.has(base)) return null
    seen.add(base)
    const property = checker.getPropertyOfType(base, symbol.name)
    if (property) {
      if ((property.flags & ts.SymbolFlags.Accessor) !== 0) return property
      // An actual intervening data declaration shadows the older accessor.
      if (!property.declarations?.every((node) => ts.isBinaryExpression(node))) return null
    }
    const declared = heritageClassOrInterfaceOf(base)
    for (const ancestor of declared === null ? [] : checker.getBaseTypes(declared)) {
      const found = find(ancestor)
      if (found) return found
    }
    return null
  }
  for (const base of checker.getBaseTypes(type)) {
    const found = find(base)
    if (found) return found
  }
  return null
}
