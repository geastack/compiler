import ts from 'typescript'

/**
 * The wrappers that erase at compile time.
 *
 * Parentheses change grouping only; `as`, `satisfies`, `<T>x`, and `!` are
 * assertions the runtime never evaluates as a step of their own. A producer
 * that built an operand from the wrapper instead of the wrapped expression
 * would cite a family the census never assigned, and the citation would name a
 * result nobody publishes.
 *
 * This lives alone, importing nothing but `typescript`, because three producers
 * had grown three private copies of it and the copies had already drifted: one
 * saw through `satisfies` and another did not, so the same expression was two
 * different expressions depending on which producer asked. A rule this small is
 * exactly the kind that gets re-typed rather than imported, and the drift is
 * silent -- so there is one, and it is the only one.
 */
export const unwrapErased = (node: ts.Node): ts.Node => {
  let current = node
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression
      continue
    }
    return current
  }
}

/** The same rule where the caller already knows it holds an expression. */
export const unwrapErasedExpression = (expression: ts.Expression): ts.Expression => unwrapErased(expression) as ts.Expression

/**
 * Whether one of the erased wrappers around `expression` is a type assertion
 * that names a type -- `SemanticOperand.asserted`. `as any`/`as unknown`
 * assert nothing about which arm a value holds, so they do not count; `!` and
 * `satisfies` are not assertions of a type at all.
 */
export const assertsType = (expression: ts.Expression, checker: ts.TypeChecker): boolean => {
  let current: ts.Node = expression
  for (;;) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      if ((checker.getTypeFromTypeNode(current.type).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return true
    } else if (!ts.isParenthesizedExpression(current) && !ts.isNonNullExpression(current) && !ts.isSatisfiesExpression(current)) {
      return false
    }
    current = current.expression
  }
}

/**
 * The node whose PARENT decides this expression's syntactic position.
 *
 * `unwrapErased` answers "which expression really produces this value"; this
 * answers the mirror question, "which node really occupies this value's place
 * in its parent". `l[1]! += 5` is an assignment whose target is the element
 * access, but the access's own `parent` is the `!`, so a producer that read
 * `node.parent` to learn its position saw a `NonNullExpression` and concluded
 * it was in no assignment at all. The store was then published by nobody --
 * neither this family nor the binding family, which correctly declines a
 * property target -- and `l[1]! = 9` compiled to nothing at all. Silently: a
 * dropped write is not a diagnostic, it is a wrong answer.
 *
 * The walk is the exact inverse of `unwrapErased`'s, and stops at the same
 * five wrappers, so the two can never disagree about which nodes erase.
 */
export const outermostErasureOf = (node: ts.Node): ts.Node => {
  let current = node
  for (;;) {
    const parent: ts.Node | undefined = current.parent
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent
      continue
    }
    return current
  }
}

/**
 * The call-like expression this node is invoked through, seeing past the same
 * erasable wrappers `unwrapErased` sees through -- `(arr.map)(cb)` invokes
 * `arr.map` exactly as `arr.map(cb)` does, so a parenthesized or asserted
 * callee must resolve to the same call as an unwrapped one.
 *
 * One position question asked of `outermostErasureOf`'s answer: it finds the
 * node the call would actually see, and this asks whether that node is the
 * call's callee. It exists so a property access's own published value type can
 * ask "am I being invoked, and by which call" without a producer inventing its
 * own walk -- the exact kind of small, easily-drifted rule `unwrapErased`'s own
 * comment warns about.
 */
export const enclosingCallIfCallee = (node: ts.Node): ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression | null => {
  const current = outermostErasureOf(node)
  const parent: ts.Node | undefined = current.parent
  if (parent === undefined) return null
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === current) return parent
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === current) return parent
  return null
}
