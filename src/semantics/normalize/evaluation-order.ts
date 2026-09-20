import ts from 'typescript'

/**
 * A node's children in the order the language evaluates them.
 *
 * `ts.forEachChild` yields children in *source* order, which for almost every
 * node is also evaluation order. A `for` statement is the exception the language
 * itself defines: the incrementor is written before the body and runs after it.
 * Walking source order there would give the incrementor a smaller evaluation
 * index than the body, and any scheduler that breaks a tie by that index would
 * then run `i++` before the statement that reads `i`.
 *
 * This is the one authority on that order. Both the census (which stamps the
 * index) and the gating pass (which stamps scope membership) walk through it, so
 * neither can disagree with the other about when something runs.
 */
export const forEachEvaluationChild = (node: ts.Node, visit: (child: ts.Node) => void): void => {
  // Destructuring evaluates its RHS before evaluating any target reference.
  // An ordinary assignment still evaluates its LHS reference first.
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))
  ) {
    visit(node.right)
    visit(node.left)
    return
  }
  if (ts.isForStatement(node)) {
    if (node.initializer) visit(node.initializer)
    if (node.condition) visit(node.condition)
    visit(node.statement)
    if (node.incrementor) visit(node.incrementor)
    return
  }
  ts.forEachChild(node, visit)
}
