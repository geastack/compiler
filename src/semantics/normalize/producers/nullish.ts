import ts from '#typescript'
import type { ValueFlowIndex } from '../flow/model.js'

/**
 * Whether a type can never be `null` or `undefined`.
 *
 * `any`/`unknown` do not count: neither rules out either value, so a proof
 * built on them is not a proof. `void` does not count either -- a `void` in a
 * stored position is `undefined`, and treating it as a non-nullish type is how
 * an absent value passes for a present one.
 *
 * Two questions in this compiler turn on it, and they must agree. A property
 * access asks it of a receiver to decide whether the `[[Get]]` can throw
 * (`properties.ts`), and both halves of an optional chain ask it of a declared
 * type to decide whether the `undefined` the checker put on their result is the
 * operator's own -- and so removable -- or the declaration's, and not.
 */
export const excludesNullish = (type: ts.Type): boolean => {
  const constituents = type.isUnion() ? type.types : [type]
  const nullishOrUnproven =
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Conditional |
    ts.TypeFlags.IndexedAccess
  return constituents.every((member) => (member.flags & nullishOrUnproven) === 0)
}

/** Whether a checker type explicitly has an `undefined` constituent. */
export const includesUndefined = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) return true
  return type.isUnion() && type.types.some(includesUndefined)
}

/** Whether a consumer of this checker type has a home for `undefined`: an explicit `undefined` constituent, or `unknown`/`any`. */
export const holdsUndefined = (type: ts.Type): boolean =>
  (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || includesUndefined(type)

export const withoutParentheses = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? withoutParentheses(expression.expression) : expression

const untypedLocalNamed = (checker: ts.TypeChecker, name: ts.Node): ts.VariableDeclaration | null => {
  if (!ts.isIdentifier(name)) return null
  const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration
  return declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.type === undefined &&
    ts.getJSDocType(declaration) === undefined
    ? declaration
    : null
}

export const untypedLocalWrittenBy = (checker: ts.TypeChecker, value: ts.Expression): ts.VariableDeclaration | null => {
  let inner: ts.Node = value
  let parent = inner.parent
  while (parent && ts.isParenthesizedExpression(parent)) {
    inner = parent
    parent = parent.parent
  }
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === inner) return untypedLocalNamed(checker, parent.name)
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === inner)
    return untypedLocalNamed(checker, parent.left)
  return null
}

export const soleWriteOf = (flow: ValueFlowIndex, local: ts.VariableDeclaration): ts.Expression | null => {
  const writes = flow.writesToDeclaration(local).filter((write) => write.slot === 'whole')
  const write = writes[0]
  if (writes.length !== 1 || write === undefined) return null
  return write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment' ? write.value : null
}

export const isSymbolKey = (key: ts.Type): boolean =>
  (key.isUnion() ? key.types : [key]).every((part) => (part.flags & ts.TypeFlags.ESSymbolLike) !== 0)

const hasIndexSignatureFor = (checker: ts.TypeChecker, receiver: ts.Type, key: ts.Type | null): boolean => {
  if (key !== null && isSymbolKey(key)) return checker.getIndexInfosOfType(receiver).some((info) => isSymbolKey(info.keyType))
  const kind = key !== null && (key.flags & ts.TypeFlags.NumberLike) !== 0 ? ts.IndexKind.Number : ts.IndexKind.String
  return checker.getIndexTypeOfType(receiver, kind) !== undefined
}

export const isDictionaryRead = (
  checker: ts.TypeChecker,
  read: ts.Expression
): read is ts.ElementAccessExpression | ts.PropertyAccessExpression => {
  if (!ts.isElementAccessExpression(read) && !ts.isPropertyAccessExpression(read)) return false
  const key = ts.isElementAccessExpression(read) ? checker.getTypeAtLocation(read.argumentExpression) : null
  const name = ts.isPropertyAccessExpression(read)
    ? read.name.text
    : ts.isStringLiteralLike(read.argumentExpression) || ts.isNumericLiteral(read.argumentExpression)
      ? read.argumentExpression.text
      : null
  const receiver = checker.getTypeAtLocation(read.expression)
  return (receiver.isUnion() ? receiver.types : [receiver]).every((part) => {
    const member = checker.getNonNullableType(part)
    return (
      !checker.isArrayType(member) &&
      !checker.isTupleType(member) &&
      hasIndexSignatureFor(checker, member, key) &&
      (name === null || checker.getPropertyOfType(member, name) === undefined)
    )
  })
}

export const dictionaryReadHeldBy = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  visited: ReadonlySet<ts.VariableDeclaration> = new Set()
): ts.ElementAccessExpression | ts.PropertyAccessExpression | null => {
  const inner = withoutParentheses(expression)
  if (isDictionaryRead(checker, inner)) return inner
  const local = untypedLocalNamed(checker, inner)
  if (local === null || visited.has(local)) return null
  const value = soleWriteOf(flow, local)
  return value === null ? null : dictionaryReadHeldBy(checker, flow, value, new Set([...visited, local]))
}

/**
 * Whether the position consuming this expression has a home for `undefined`:
 * the checker's contextual type names `undefined`, or is `unknown`/`any` --
 * except the `any` the checker reports for an untyped local's assignment.
 *
 * A missing key is `undefined`, and such a destination can hold it. An
 * index-signature read publishes its absence there
 * (`observablyAbsentElementTypeOf` in properties.ts); an unannotated local
 * holding such a read is widened for a use there
 * (`registerObservedIndexedAbsence` in local-bindings.ts); and an argument
 * there adds `undefined` to its parameter (`passesAbsentIndexRead` in
 * parameter-bindings.ts). The three ask this one question so that
 * `f(dict[key])` and `const v = dict[key]; f(v)` cannot answer differently.
 */
export const flowsIntoUndefinedHome = (checker: ts.TypeChecker, node: ts.Expression): boolean => {
  const contextual = checker.getContextualType(node)
  if (contextual === undefined) return false
  return includesUndefined(contextual) || (holdsUndefined(contextual) && untypedLocalWrittenBy(checker, node) === null)
}

/** Whether `typeof` takes this expression as its operand: it answers `"undefined"` for an absent read without consuming the value (ECMA-262 13.5.3). */
const typeofTakesItsOperand = (inner: ts.Node, parent: ts.Node): boolean => ts.isTypeOfExpression(parent) && parent.expression === inner

/**
 * Whether an expression sits where ECMA-262 turns its value into a BOOLEAN --
 * `ToBoolean` of whatever it evaluated to -- or into a type tag (`typeof`),
 * rather than where the value itself is consumed.
 *
 * These are test positions that can observe an `undefined` no type mentions.
 * Equality with `undefined` is the other direct observation. See
 * `observablyAbsentElementTypeOf` in properties.ts for why the widening is bounded to them.
 */
export const testsItsOperand = (node: ts.Expression): boolean => {
  let inner: ts.Node = node
  let parent = inner.parent
  while (parent && ts.isParenthesizedExpression(parent)) {
    inner = parent
    parent = parent.parent
  }
  if (!parent) return false
  if (typeofTakesItsOperand(inner, parent)) return true
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === inner
  if (ts.isForStatement(parent)) return parent.condition === inner
  if (ts.isConditionalExpression(parent)) return parent.condition === inner
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind
    const tested =
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    return tested && parent.left === inner
  }
  // `?.` IS a test of its base, and the one that consumes nothing on the
  // absent branch: ECMA-262 13.3.9.1 evaluates the whole chain to `undefined`
  // without ever performing the `[[Get]]`. `root.children[3]?.value` therefore
  // needs the same widening `if (array[i])` gets -- without it the base's
  // carrier says never-absent, the chain's guard folds to `if (true)`, and
  // `elementAt` aborts on the read the program wrote `?.` precisely to avoid.
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) {
    return parent.expression === inner && ts.isOptionalChain(parent) && parent.questionDotToken !== undefined
  }
  return false
}
