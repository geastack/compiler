import ts from 'typescript'

/** The checker-synthesized trailing slot, keyed by its owning signature. */
export interface ImplicitArgumentsSlot {
  readonly ordinal: number
  readonly symbol: ts.Symbol
}

export const implicitArgumentsSlotOf = (signature: ts.Signature): ImplicitArgumentsSlot | null => {
  const parameters = signature.getParameters()
  const symbol = parameters[parameters.length - 1]
  if (!symbol || symbol.valueDeclaration || symbol.declarations?.length) return null
  if (parameters.slice(0, -1).some((parameter) => !parameter.valueDeclaration && !parameter.declarations?.length)) return null
  return { ordinal: parameters.length - 1, symbol }
}

export const isArgumentsObjectIdentifier = (node: ts.Node, checker: ts.TypeChecker): node is ts.Identifier => {
  if (!ts.isIdentifier(node) || node.text !== 'arguments') return false
  const symbol = checker.getSymbolAtLocation(node)
  return !!symbol && symbol.valueDeclaration === undefined && (symbol.declarations?.length ?? 0) === 0
}

export const isBodiedSignatureDeclaration = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

export const enclosingArgumentsFunction = (node: ts.Node): ts.FunctionLikeDeclaration | null => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue
    if (isBodiedSignatureDeclaration(parent)) return parent
  }
  return null
}

export const argumentsObjectPhantomOrdinalAt = (node: ts.Node, checker: ts.TypeChecker): number | null => {
  if (!isArgumentsObjectIdentifier(node, checker)) return null
  const owner = enclosingArgumentsFunction(node)
  const signature = owner ? checker.getSignatureFromDeclaration(owner) : undefined
  return signature ? (implicitArgumentsSlotOf(signature)?.ordinal ?? null) : null
}
