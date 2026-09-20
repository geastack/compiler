import ts from 'typescript'

/** Only the colon form with a noncomputed __proto__ key sets an object's prototype. */
export const isObjectLiteralPrototypeSetter = (node: ts.Node): boolean =>
  ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) && node.name.text === '__proto__'

/** Literal syntax denotes a pattern only in an assignment target position. */
export const isAssignmentPattern = (node: ts.Node): boolean => {
  let current = node
  let parent: ts.Node | undefined = node.parent
  while (parent) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === current) return true
    if (ts.isForOfStatement(parent) && parent.initializer === current) return true
    if (
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isSpreadElement(parent)
    ) {
      current = parent
      parent = parent.parent
      continue
    }
    return false
  }
  return false
}

export type ObjectAssignmentElement = ts.PropertyAssignment | ts.ShorthandPropertyAssignment

export const isObjectAssignmentElement = (node: ts.Node): node is ObjectAssignmentElement =>
  (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
  node.parent !== undefined &&
  ts.isObjectLiteralExpression(node.parent) &&
  isAssignmentPattern(node.parent)

/** A target reference is evaluated, but its old value is never read. */
export const objectAssignmentElementOfTarget = (node: ts.Node): ObjectAssignmentElement | null => {
  let current = node
  while (current.parent && ts.isParenthesizedExpression(current.parent)) current = current.parent
  const parent = current.parent
  if (!parent || !isObjectAssignmentElement(parent)) return null
  return (ts.isPropertyAssignment(parent) ? parent.initializer : parent.name) === current ? parent : null
}

/** Nested patterns and loop-head patterns have separate source protocols. */
export const objectAssignmentSource = (pattern: ts.ObjectLiteralExpression): ts.Expression | null => {
  const parent = pattern.parent
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === pattern
    ? parent.right
    : null
}

/** The array pattern's own top-level source -- the array-literal twin of `objectAssignmentSource`. */
export const arrayAssignmentSource = (pattern: ts.ArrayLiteralExpression): ts.Expression | null => {
  const parent = pattern.parent
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === pattern
    ? parent.right
    : null
}

/**
 * Whether `node` is a direct element of an array-literal assignment pattern:
 * a bare target, a defaulted target's whole `=` expression, a rest target's
 * whole `...` spread, an elision, or a nested pattern. Used to keep these
 * wrapper shapes out of their ordinary census families (`=` is otherwise
 * `computation`, `...` is otherwise `protocol`) -- the pattern's own
 * candidate is the sole producer of whatever operations they key.
 */
export const isArrayAssignmentPatternElement = (node: ts.Node): boolean => {
  const parent = node.parent
  return (
    parent !== undefined &&
    ts.isArrayLiteralExpression(parent) &&
    isAssignmentPattern(parent) &&
    parent.elements.includes(node as ts.Expression)
  )
}

export interface ArrayAssignmentTarget {
  readonly pattern: ts.ArrayLiteralExpression
  readonly position: number
  /**
   * Whichever node the array pattern's own contribution keys its
   * extraction/default operations on: the target itself for a bare element,
   * the enclosing `=`/`...` node otherwise.
   */
  readonly keyNode: ts.Expression
  readonly defaulted: boolean
}

/**
 * The array-pattern position a write target belongs to, whether written bare
 * (`[a] = x`), defaulted (`[a = 1] = x`) or as the rest target (`[...a] = x`).
 *
 * A write candidate recomputes `keyNode` and `defaulted` rather than looking
 * them up, the same predictive-citation discipline `citeBoundElementValue`
 * uses for a binding pattern's element: the pattern's own contribution mints
 * its extraction/default operations from exactly these two facts, so a
 * second, independent computation of them here is sound only because both
 * sides derive them from the same syntax rather than one publishing and the
 * other guessing.
 */
export const arrayAssignmentTargetOf = (node: ts.Node): ArrayAssignmentTarget | null => {
  const asElement = (candidate: ts.Node): { readonly pattern: ts.ArrayLiteralExpression; readonly position: number } | null => {
    const parent = candidate.parent
    if (!parent || !ts.isArrayLiteralExpression(parent) || !isAssignmentPattern(parent)) return null
    const position = parent.elements.indexOf(candidate as ts.Expression)
    return position < 0 ? null : { pattern: parent, position }
  }
  if (!ts.isExpression(node)) return null
  const own = asElement(node)
  if (own) return { pattern: own.pattern, position: own.position, keyNode: node, defaulted: false }
  const parent = node.parent
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node) {
    const wrapper = asElement(parent)
    if (wrapper) return { pattern: wrapper.pattern, position: wrapper.position, keyNode: parent, defaulted: true }
  }
  if (parent && ts.isSpreadElement(parent) && parent.expression === node) {
    const wrapper = asElement(parent)
    if (wrapper) return { pattern: wrapper.pattern, position: wrapper.position, keyNode: parent, defaulted: false }
  }
  return null
}

/**
 * A "simple" array assignment write target -- a name or a property reference,
 * never a nested pattern (which gets its own recursive `destructuring`
 * candidate the same way a nested binding pattern does).
 */
export const arrayAssignmentWriteTargetOf = (node: ts.Node): ArrayAssignmentTarget | null => {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
  return arrayAssignmentTargetOf(node)
}

/**
 * The literal a nested array-pattern's OWN elements are drawn from -- either
 * the top-level source (`arrayAssignmentSource`), or, when `pattern` is
 * itself one element of an ENCLOSING pattern (`[a, [b]] = [1, [2]]`), that
 * enclosing pattern's own literal element at the same position, recursively.
 * Stops the moment either the outer source or the recovered element is not
 * itself a literal -- there is no sound way to index INTO an arbitrary
 * expression's type without `checker.createArrayType`, which is
 * checker-internal (`structural-array-element.ts`'s header documents the
 * identical wall for `never[]`).
 *
 * Shared between `local-bindings.ts` (recovering a bare element's evidence
 * expression) and `structural-array-element.ts` (recovering a REST target's
 * source, which needs the pattern's source as a whole rather than one
 * position of it) -- both ask the same "what literal is this pattern reading
 * from" question and must never derive two different answers for it.
 */
export const arrayAssignmentPatternSourceExpression = (pattern: ts.ArrayLiteralExpression): ts.Expression | null => {
  const direct = arrayAssignmentSource(pattern)
  if (direct) return direct
  const nested = arrayAssignmentTargetOf(pattern)
  if (!nested || ts.isSpreadElement(nested.keyNode)) return null
  const outerSource = arrayAssignmentPatternSourceExpression(nested.pattern)
  if (!outerSource || !ts.isArrayLiteralExpression(outerSource)) return null
  const element = outerSource.elements[nested.position]
  return element && !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) ? element : null
}
