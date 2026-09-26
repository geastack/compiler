import ts from 'typescript'
import { constantTruthinessOf } from './constant-literal.js'

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
/**
 * A sufficient proof that evaluation cannot produce a normal completion.
 * ECMA-262 (2025), StatementList and IfStatement evaluation: a statement list
 * completes abruptly as soon as one of its statements does, and an if can
 * complete normally if either arm can. Unknown forms stay unproven; in
 * particular a nested loop can consume a break, and a finally can override a
 * pending return.
 *
 * Switch guard chains need this completion fact, not the spelling of the final
 * statement. A block wrapping a return and an if whose arms both return cannot
 * fall through any more than a bare return can.
 */
export const alwaysAbrupt = (statement: ts.Statement | undefined): boolean => {
  if (!statement) return false
  if (ts.isBlock(statement)) return statement.statements.some(alwaysAbrupt)
  if (ts.isIfStatement(statement)) {
    const constant = constantTruthinessOf(statement.expression)
    if (constant === true) return alwaysAbrupt(statement.thenStatement)
    if (constant === false) return alwaysAbrupt(statement.elseStatement)
    return alwaysAbrupt(statement.thenStatement) && alwaysAbrupt(statement.elseStatement)
  }
  return (
    ts.isBreakStatement(statement) || ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement)
  )
}

/**
 * The statements of a list in the order the language evaluates them.
 *
 * Function declarations come first, wherever they are written: they are
 * instantiated when the enclosing body is entered (ECMA-262 FunctionDeclaration-
 * Instantiation, GlobalDeclarationInstantiation, BlockDeclarationInstantiation),
 * so a read of one inside a conditional arm written above it reads an object
 * that already exists rather than one whose allocation has to be scheduled into
 * that arm. Then every other statement up to and including the first that
 * always completes abruptly, and none after it: `return x; y()` never
 * evaluates `y()`, and a statement that is never evaluated has no operation to
 * publish.
 */
export const evaluatedStatementsOf = (statements: readonly ts.Statement[]): readonly ts.Statement[] => {
  const evaluated: ts.Statement[] = statements.filter(ts.isFunctionDeclaration)
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement)) continue
    evaluated.push(statement)
    if (alwaysAbrupt(statement)) break
  }
  return evaluated
}

export const forEachEvaluationChild = (node: ts.Node, visit: (child: ts.Node) => void): void => {
  if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    if (ts.isCaseClause(node)) visit(node.expression)
    for (const statement of evaluatedStatementsOf(node.statements)) visit(statement)
    return
  }
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
  // A constant condition rules one arm out statically; that arm is never
  // evaluated -- see `constantTruthinessOf`.
  if (ts.isIfStatement(node)) {
    visit(node.expression)
    const constant = constantTruthinessOf(node.expression)
    if (constant !== false) visit(node.thenStatement)
    if (node.elseStatement && constant !== true) visit(node.elseStatement)
    return
  }
  if (ts.isConditionalExpression(node)) {
    visit(node.condition)
    const constant = constantTruthinessOf(node.condition)
    if (constant !== false) visit(node.whenTrue)
    if (constant !== true) visit(node.whenFalse)
    return
  }
  if (ts.isForStatement(node)) {
    if (node.initializer) visit(node.initializer)
    if (node.condition) visit(node.condition)
    if (node.condition && constantTruthinessOf(node.condition) === false) return
    visit(node.statement)
    if (node.incrementor) visit(node.incrementor)
    return
  }
  if (ts.isWhileStatement(node)) {
    visit(node.expression)
    if (constantTruthinessOf(node.expression) !== false) visit(node.statement)
    return
  }
  ts.forEachChild(node, visit)
}
