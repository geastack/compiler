import ts from 'typescript'

/**
 * The overload a call selects once an argument the checker saw as `any` is
 * read at the type the census proves for it, or `null` when that changes
 * nothing.
 *
 * The checker resolves an overloaded call argument by argument, and an `any`
 * argument is assignable to every candidate, so the first declared overload
 * wins whatever the value really is. thread-stream's
 * `Atomics.load(stream[kImpl].state, WRITE_INDEX)` reads a census-typed
 * `Int32Array` through an `any` receiver, and the checker picked
 * `(BigInt64Array | BigUint64Array, number) => bigint` -- the program then
 * subtracted a BigInt from a length. Re-asking the same question the checker
 * asks, with the census's answer for those arguments, is the checker's own
 * rule over better evidence, not a second overload resolver.
 *
 * Deliberately narrow, returning `null` unless the answer is certain: at least
 * one argument must be `any` to the checker and typed by the census; no
 * overload may be generic (its parameters are not public before
 * instantiation) or take a rest; exactly one overload may remain once every
 * overload a census-typed argument is disjoint from is set aside; and it must
 * differ from the checker's choice.
 *
 * Disjoint, not merely unassignable: an overload is ruled out only when no
 * value the argument can hold fits its parameter. A JavaScript caller's
 * `Atomics.load(view, index)` whose `index` holds `string | number` fits no
 * overload exactly -- the algorithm converts it -- yet the `Int32Array` view
 * still rules the BigInt overload out, and that is the whole question.
 */
type OverloadAnswer = { readonly kind: 'reselected'; readonly signature: ts.Signature } | { readonly kind: 'blind' }

/**
 * `reselected` when the census's argument types leave one overload, other
 * than the checker's; `blind` when they leave several whose returns differ --
 * an `any` argument the census could not type either, over an overload set
 * whose answer depends on it (`Atomics.load(view, i)` with `view` untyped:
 * `number` for an integer view, `bigint` for a BigInt one). The checker's
 * return there is the first declared overload's, a pick rather than a fact,
 * and the call's type is unresolved: lattice bottom, never the pick.
 */
const overloadAnswer = (
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  typeOf: (expression: ts.Expression) => ts.Type | null
): OverloadAnswer | null => {
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return null
  const loose = call.arguments.map((argument) => (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Any) !== 0)
  if (!loose.some(Boolean)) return null
  const resolved = checker.getResolvedSignature(call)
  if (!resolved?.declaration) return null
  const signatures = checker.getTypeAtLocation(call.expression).getCallSignatures()
  if (signatures.length < 2) return null
  // A generic overload's parameters are not public before instantiation, and
  // a rest overload's positions are not one parameter each: either could
  // admit the call without this test seeing it, so neither answer is certain.
  if (
    signatures.some(
      (signature) =>
        (signature.typeParameters?.length ?? 0) > 0 ||
        !signature.getDeclaration() ||
        signature.getDeclaration().parameters.some((parameter) => parameter.dotDotDotToken !== undefined)
    )
  )
    return null
  const evidence = call.arguments.map((argument, index) => {
    if (!loose[index]) return null
    const typed = typeOf(argument)
    return typed && (typed.flags & ts.TypeFlags.Any) === 0 ? checker.getNonNullableType(typed) : null
  })
  // What each `any` argument was read as, per call -- the question a
  // reselection that did not happen leaves open.
  if (process.env['GEA_OVERLOAD_DEBUG'] && call.getText().includes(process.env['GEA_OVERLOAD_DEBUG']))
    console.error(
      `[OVERLOAD] ${call.getText().slice(0, 80)} evidence=${evidence.map((type) => (type ? checker.typeToString(type) : '-')).join(',')}`
    )
  const admitted = signatures.filter((signature) => {
    const parameters = signature.getDeclaration().parameters
    const required = parameters.filter((parameter) => !parameter.questionToken && !parameter.initializer).length
    if (call.arguments.length < required || call.arguments.length > parameters.length) return false
    return evidence.every((type, index) => {
      if (type === null) return true
      const parameter = signature.getParameters()[index]
      if (parameter === undefined) return false
      const stated = checker.getTypeOfSymbolAtLocation(parameter, call)
      return (type.isUnion() ? type.types : [type]).some((arm) => checker.isTypeAssignableTo(arm, stated))
    })
  })
  // Several admitted where the checker's own pick is not among them: the one
  // whose stated parameters name the evidence's own types is the call's
  // (thread-stream's `Buffer.from(sharedArrayBuffer)` beside the ArrayBuffer
  // overload a SharedArrayBuffer is also assignable to).
  const named = (signature: ts.Signature): boolean =>
    evidence.every((type, index) => {
      if (type === null) return true
      const parameter = signature.getParameters()[index]
      const stated = parameter ? checker.getTypeOfSymbolAtLocation(parameter, call) : undefined
      return stated !== undefined && type.getSymbol() !== undefined && stated.getSymbol() === type.getSymbol()
    })
  const exact =
    admitted.length > 1 && !admitted.some((signature) => signature.getDeclaration() === resolved.declaration) ? admitted.filter(named) : []
  const only = exact.length === 1 ? exact[0] : admitted[0]
  if ((admitted.length === 1 || exact.length === 1) && only)
    return only.getDeclaration() === resolved.declaration ? null : { kind: 'reselected', signature: only }
  const returned = checker.getReturnTypeOfSignature(resolved)
  const agree = (other: ts.Type): boolean => checker.isTypeAssignableTo(other, returned) && checker.isTypeAssignableTo(returned, other)
  return admitted.length > 1 && !admitted.every((signature) => agree(checker.getReturnTypeOfSignature(signature)))
    ? { kind: 'blind' }
    : null
}

export const censusReselectedSignature = (
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  typeOf: (expression: ts.Expression) => ts.Type | null
): ts.Signature | null => {
  const answer = overloadAnswer(checker, call, typeOf)
  return answer?.kind === 'reselected' ? answer.signature : null
}

/** Whether the checker's return for this call is a blind pick among overloads -- see `overloadAnswer`. */
export const censusOverloadIsBlind = (
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  typeOf: (expression: ts.Expression) => ts.Type | null
): boolean => overloadAnswer(checker, call, typeOf)?.kind === 'blind'

/**
 * What a call returns under `overloadAnswer` -- the re-selected overload's
 * return, or `any` for a blind pick -- or `null` where the checker's choice
 * stands.
 */
export const censusReselectedCallResult = (
  checker: ts.TypeChecker,
  node: ts.Node,
  typeOf: (expression: ts.Expression) => ts.Type | null
): ts.Type | null => {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node)) return null
  const answer = overloadAnswer(checker, node, typeOf)
  if (answer === null) return null
  return answer.kind === 'blind' ? checker.getAnyType() : checker.getReturnTypeOfSignature(answer.signature)
}

const numericBinaryOperators: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken
])

/**
 * The type a census answer gives an expression whose checker type is only an
 * inference it replaced -- a call `censusReselectedCallResult` re-types, a
 * node `preferredTypeAt` answers, a numeric operator over one of those, or an
 * unannotated `const` initialized from any of them -- or `null` where the
 * checker's type stands.
 */
export const censusRetypedExpressionType = (
  checker: ts.TypeChecker,
  node: ts.Node,
  typeOf: (expression: ts.Expression) => ts.Type | null,
  preferredTypeAt: (node: ts.Node) => ts.Type | null,
  seen: ReadonlySet<ts.Node> = new Set()
): ts.Type | null => {
  let expression = node
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  if (seen.has(expression)) return null
  const direct =
    censusReselectedCallResult(checker, expression, typeOf) ?? (ts.isCallExpression(expression) ? preferredTypeAt(expression) : null)
  if (direct) return direct
  const retyped = (operand: ts.Expression): ts.Type | null =>
    censusRetypedExpressionType(checker, operand, typeOf, preferredTypeAt, new Set([...seen, expression]))
  // A numeric operator's result domain is its operands' (ECMA-262 13.15.3
  // ApplyStringOrNumericBinaryOperator: Number with Number, BigInt with
  // BigInt), so the checker's is only as good as the operand types it read.
  const operands = ts.isBinaryExpression(expression)
    ? numericBinaryOperators.has(expression.operatorToken.kind)
      ? [expression.left, expression.right]
      : null
    : ts.isPrefixUnaryExpression(expression) &&
        (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.TildeToken)
      ? [expression.operand]
      : null
  if (operands) {
    const replaced = operands.map(retyped)
    if (replaced.every((type) => type === null)) return null
    const types = operands.map((operand, position) => replaced[position] ?? typeOf(operand) ?? checker.getTypeAtLocation(operand))
    if (types.every((type) => (type.flags & ts.TypeFlags.NumberLike) !== 0)) return checker.getNumberType()
    if (types.every((type) => (type.flags & ts.TypeFlags.BigIntLike) !== 0)) return checker.getBigIntType()
    return checker.getAnyType()
  }
  if (!ts.isIdentifier(expression)) return null
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.type !== undefined ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  )
    return null
  return censusRetypedExpressionType(checker, declaration.initializer, typeOf, preferredTypeAt, new Set([...seen, expression]))
}
