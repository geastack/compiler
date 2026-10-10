import ts from 'typescript'

/**
 * Whether a function body treats `null` in parameter `parameter` exactly as it
 * treats the parameter's absence -- so a `null` an `any` argument smuggles
 * past the `T | undefined` check may enter as the absence
 * (`conversion/nodes.ts`'s `nullishOptionalFor`).
 *
 * A `merge(batch, result, err?: Error)` that only asks `if (err)` and reads
 * `err` again inside that branch is the shape: the `null` its caller's
 * `let thrownError = null` hands it behaves as no error either way. A body
 * that compares `value === undefined`, asks `typeof value`, or passes the
 * value on before narrowing it CAN tell them apart, and there the `null` must
 * stay a `null` (`dynamic-optional-absence-mismatch.ts`).
 *
 * Every read of the parameter is either in a position that answers the same
 * for both -- a truthiness test, `== null`/`!= null`, the left of `??`, the
 * base of `?.` -- or already narrowed by such a test (its flow type holds no
 * `undefined`). A parameter with no body to read it -- an overload, an
 * ambient declaration -- is never blind.
 */
export const isNullBlindParameter = (checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): boolean => {
  const owner = parameter.parent
  const body = ts.isFunctionLike(owner) ? (owner as ts.FunctionLikeDeclaration).body : undefined
  if (body === undefined || !ts.isIdentifier(parameter.name)) return false
  const symbol = checker.getSymbolAtLocation(parameter.name)
  if (symbol === undefined) return false
  let blind = true
  const visit = (node: ts.Node): void => {
    if (!blind) return
    if (ts.isIdentifier(node) && node !== parameter.name && checker.getSymbolAtLocation(node) === symbol && !isWrite(node)) {
      if (!answersAlike(node) && holdsUndefined(checker.getTypeAtLocation(node))) blind = false
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return blind
}

const holdsUndefined = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
  (type.isUnion() && type.types.some((member) => (member.flags & ts.TypeFlags.Undefined) !== 0))

const isWrite = (node: ts.Identifier): boolean =>
  ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken

const isNullish = (node: ts.Expression): boolean =>
  node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined')

/** Whether the value of `node` reaches only a place where `null` and `undefined` behave alike. */
const answersAlike = (node: ts.Expression): boolean => {
  const parent = node.parent
  if (ts.isParenthesizedExpression(parent)) return answersAlike(parent)
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === node
  if (ts.isForStatement(parent)) return parent.condition === node
  if (ts.isConditionalExpression(parent)) return parent.condition === node
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node)
    return parent.questionDotToken !== undefined
  if (ts.isCallExpression(parent) && parent.expression === node) return parent.questionDotToken !== undefined
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind
    const other = parent.left === node ? parent.right : parent.left
    if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) return isNullish(other)
    if (operator === ts.SyntaxKind.QuestionQuestionToken) return parent.left === node
    // `p && x` / `p || x` yield `p` itself when it decides, so the whole
    // expression must land where the two answer alike too.
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) return answersAlike(parent)
  }
  return false
}
