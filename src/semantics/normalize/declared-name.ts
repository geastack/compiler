import ts from '#typescript'

/**
 * The node's own `name` member, for every node kind that declares one.
 *
 * Narrowed kind by kind rather than read through a structural cast
 * (`(node as { name?: ts.Node }).name`): a natively compiled compiler builds a
 * cast's view from the static class -- the facade's base node class, which
 * declares no `name` -- so the cast read `undefined` for every node there,
 * while node read the member. `ts.getNameOfDeclaration` is not this question
 * either: it answers an `export default x`'s expression and an assignment
 * declaration's left side, neither of which is a `name` member.
 */
export const declaredNameOf = (node: ts.Node): ts.Node | undefined => {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isMetaProperty(node) ||
    ts.isEnumMember(node)
  )
    return node.name
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isNamespaceExport(node) ||
    ts.isImportSpecifier(node) ||
    ts.isExportSpecifier(node) ||
    ts.isTypeParameterDeclaration(node)
  )
    return node.name
  if (ts.isJsxAttribute(node) || ts.isJsxNamespacedName(node)) return node.name
  if (ts.isJSDocParameterTag(node) || ts.isJSDocPropertyTag(node) || ts.isJSDocTypedefTag(node) || ts.isJSDocCallbackTag(node))
    return node.name
  // `export as namespace`, named tuple members and JSDoc link/see names are
  // left out: the native facade states no guard for them, and none of them is
  // a value reference either asker cares about.
  return undefined
}
