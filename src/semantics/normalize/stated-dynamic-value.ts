import ts from '#typescript'

/**
 * Whether `node` evaluates to a value a census STATED dynamic although the
 * checker types it -- a read of a field widened by `widenDynamicallyWrittenFields`,
 * a cell holding one, or a member read or method result off one. The checker
 * still answers such a node from the field's narrow inference, so every
 * consumer that asks the checker first must ask this beside it, or it lays out
 * a typed slot for the boxed value and converts it through the same checked
 * unbox the widening removed from the field.
 */
export const readsStatedDynamicValue = (statedTypeAt: (node: ts.Node) => ts.Type | null, node: ts.Node, depth = 0): boolean => {
  if (depth > 16) return false
  const stated = statedTypeAt(node)
  if (stated) return (stated.flags & ts.TypeFlags.Any) !== 0
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
    return readsStatedDynamicValue(statedTypeAt, node.expression, depth + 1)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return readsStatedDynamicValue(statedTypeAt, node.expression, depth + 1)
  if (ts.isCallExpression(node))
    return (
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
      readsStatedDynamicValue(statedTypeAt, node.expression.expression, depth + 1)
    )
  if (ts.isConditionalExpression(node))
    return (
      readsStatedDynamicValue(statedTypeAt, node.whenTrue, depth + 1) || readsStatedDynamicValue(statedTypeAt, node.whenFalse, depth + 1)
    )
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      // `+` over a dynamic operand is a string or a number, decided at run time.
      operator === ts.SyntaxKind.PlusToken
    )
      return readsStatedDynamicValue(statedTypeAt, node.left, depth + 1) || readsStatedDynamicValue(statedTypeAt, node.right, depth + 1)
  }
  return false
}
