import ts from '#typescript'

/**
 * `#node-parent`: parents a synthesized node. TypeScript's public API declares
 * `parent` read-only and exports no setter, so the JavaScript compiler writes
 * the field through a structural view.
 */
export const setNodeParent = (child: ts.Node, parent: ts.Node): void => {
  ;(child as { parent: ts.Node }).parent = parent
}

/**
 * A synthesized `void 0` placed at the end of `at` and parented to it, so
 * `getSourceFile()`, `getStart()` and `getText()` answer for it.
 */
export const voidZeroAt = (at: ts.Node): ts.VoidExpression => {
  const value = ts.factory.createVoidZero()
  ts.setTextRange(value.expression, { pos: at.end, end: at.end })
  ts.setTextRange(value, { pos: at.end, end: at.end })
  setNodeParent(value.expression, value)
  setNodeParent(value, at)
  return value
}
