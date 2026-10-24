import ts from '#typescript'

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
