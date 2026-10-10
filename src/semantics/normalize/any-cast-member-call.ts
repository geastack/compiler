import ts from 'typescript'

/**
 * A method called through an `as any` receiver whose result the program
 * immediately states: `const matchers: MatcherMap<T> = (this as any)
 * .buildAllMatchers()`.
 *
 * Hono's RegExpRouter installs a free `match` function as its `match` field,
 * and that function calls back into the router through `this as any` because
 * its declared receiver (`R extends Router<T>`) names no such method. The `as`
 * erases the static type and nothing else: the receiver is still the router
 * carrier, and the read and call dispatch over its classes exactly as a typed
 * member call does. Typed `any`, the read boxed the method, the call published
 * every router's fields to a dynamic call, and the result was unboxed into the
 * binding the program states anyway.
 *
 * The call takes the stated slot's type, and its callee is a callable taking
 * the erased receiver and returning it, or `undefined` -- a receiver class with no
 * such member answers `undefined` and the call throws the TypeError calling it
 * throws. Nothing here asserts that a receiver class returns the stated type:
 * each class's method is converted into that callable where it is read, and a
 * method whose result has no conversion into the slot refuses there.
 *
 * Fail-closed: only a non-optional property call with no arguments, on an
 * `as any` operand the checker types as something other than `any`/`unknown`,
 * whose result initializes a binding with a stated type or is returned from a
 * function with a stated, non-async, non-generator return.
 */
export interface AnyCastMemberCall {
  readonly call: ts.CallExpression
  readonly read: ts.PropertyAccessExpression
  /** The receiver the `as any` erased: what the method is read off and called on. */
  readonly receiver: ts.Expression
  /** The type the program states for the call's result. */
  readonly stated: ts.Type
}

const unwrapParens = (node: ts.Expression): ts.Expression => {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

const isAnyKeyword = (node: ts.TypeNode): boolean => node.kind === ts.SyntaxKind.AnyKeyword

const statedResultOf = (checker: ts.TypeChecker, call: ts.CallExpression): ts.Type | null => {
  let value: ts.Node = call
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent
  const parent = value.parent
  if (ts.isVariableDeclaration(parent) && parent.initializer === value && parent.type) return checker.getTypeFromTypeNode(parent.type)
  if (ts.isReturnStatement(parent) && parent.expression === value) {
    let owner: ts.Node | undefined = parent.parent
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
    if (!owner || !ts.isFunctionLike(owner) || !owner.type || ts.isConstructorDeclaration(owner)) return null
    const modifiers = ts.canHaveModifiers(owner) ? ts.getModifiers(owner) : undefined
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null
    if ('asteriskToken' in owner && owner.asteriskToken !== undefined) return null
    return checker.getTypeFromTypeNode(owner.type)
  }
  return null
}

export const anyCastMemberCallOf = (checker: ts.TypeChecker, node: ts.Node): AnyCastMemberCall | null => {
  const read = ts.isCallExpression(node) ? unwrapParens(node.expression) : node
  if (!ts.isPropertyAccessExpression(read) || read.questionDotToken !== undefined || !ts.isIdentifier(read.name)) return null
  let callee: ts.Node = read
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent
  const call = callee.parent
  if (!ts.isCallExpression(call) || call.expression !== callee || call.questionDotToken !== undefined) return null
  if (ts.isCallExpression(node) && node !== call) return null
  if (call.arguments.length !== 0 || call.typeArguments !== undefined) return null
  const receiver = unwrapParens(read.expression)
  if (!(ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)) || !isAnyKeyword(receiver.type)) return null
  const erased = checker.getTypeAtLocation(receiver.expression)
  if ((erased.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
  const stated = statedResultOf(checker, call)
  if (stated === null || (stated.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void)) !== 0) return null
  return { call, read, receiver: receiver.expression, stated }
}
