import ts from 'typescript'

/**
 * A JSDoc `@returns` statement widened by the `null`/`undefined` its own
 * function body returns.
 *
 * In a JavaScript file the checker reads a JSDoc tag as the function's type
 * and never verifies the body against it. avvio's time tree writes
 *
 * ```js
 * /** @returns {TimeTreeNode} *\/
 * [kGetParent] (parent) {
 *   if (parent === null) return null
 *   ...
 * ```
 *
 * so every caller and the body's own return slot were typed `TimeTreeNode`
 * while the function hands back `null` -- a value no carrier of that type can
 * hold. A checked file would have reported the contradiction and never reached
 * this compiler, so meeting one proves the statement unverified, and the
 * values the body returns are what its callers receive.
 *
 * The fact is stated where the checker reads it, in the tag itself, so the
 * body, every call site and every census read one answer: `{TimeTreeNode}`
 * becomes `{(TimeTreeNode)|null}`. Only a literal `null`, `undefined`, `void`
 * expression or bare `return` in the function's own body counts; any other
 * returned value keeps the statement's authority. A statement that already
 * admits the value (a `null`/`undefined` arm, `?T`, `*`, `any`, `unknown`) is
 * left as written, and a generator or `async` function, whose returns do not
 * reach its callers directly, is not touched.
 */

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

type FunctionWithBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration | ts.ArrowFunction

const isFunctionWithBlock = (node: ts.Node): node is FunctionWithBody =>
  (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) &&
  node.body !== undefined &&
  ts.isBlock(node.body)

/** Whether the stated type already admits a value of this kind. */
const admits = (type: ts.TypeNode, kind: ts.SyntaxKind.NullKeyword | ts.SyntaxKind.UndefinedKeyword): boolean => {
  if (ts.isParenthesizedTypeNode(type)) return admits(type.type, kind)
  if (ts.isUnionTypeNode(type)) return type.types.some((arm) => admits(arm, kind))
  if (ts.isJSDocNullableType(type) || ts.isJSDocAllType(type) || ts.isJSDocUnknownType(type)) return true
  if (kind === ts.SyntaxKind.UndefinedKeyword && (ts.isJSDocOptionalType(type) || type.kind === ts.SyntaxKind.VoidKeyword)) return true
  if (type.kind === ts.SyntaxKind.AnyKeyword || type.kind === ts.SyntaxKind.UnknownKeyword) return true
  if (ts.isLiteralTypeNode(type)) return type.literal.kind === kind
  return type.kind === kind
}

/** The nullish kinds the function's own `return`s hand back. */
const returnedNullishKinds = (body: ts.Block): { readonly null: boolean; readonly undefined: boolean } => {
  let returnsNull = false
  let returnsUndefined = false
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isReturnStatement(node)) {
      let value = node.expression
      while (value && ts.isParenthesizedExpression(value)) value = value.expression
      if (value === undefined || ts.isVoidExpression(value)) returnsUndefined = true
      else if (value.kind === ts.SyntaxKind.NullKeyword) returnsNull = true
      else if (ts.isIdentifier(value) && value.text === 'undefined') returnsUndefined = true
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return { null: returnsNull, undefined: returnsUndefined }
}

export const jsdocNullishReturnTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName)) return null
  // One substring test is what a file with no return tag costs.
  if (!input.text.includes('@return')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionWithBlock(node) && !node.asteriskToken && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) === 0) {
      const type = ts.getJSDocReturnTag(node)?.typeExpression?.type
      if (type && node.body && ts.isBlock(node.body)) {
        const returned = returnedNullishKinds(node.body)
        const added = [
          ...(returned.null && !admits(type, ts.SyntaxKind.NullKeyword) ? ['null'] : []),
          ...(returned.undefined && !admits(type, ts.SyntaxKind.UndefinedKeyword) ? ['undefined'] : [])
        ]
        if (added.length > 0) {
          const start = type.getStart(file)
          const end = type.getEnd()
          edits.push({ start, end, text: `(${input.text.slice(start, end)})|${added.join('|')}` })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (edits.length === 0) return null
  // Spliced from the end so every earlier range is still the range it was
  // measured at, exactly as `definePropertySourceTransform` does.
  let rewritten = input.text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
  }
  return rewritten
}
