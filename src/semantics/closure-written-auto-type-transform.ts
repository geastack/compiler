import ts from 'typescript'

/**
 * A variable the checker auto-types, that a function nested in its
 * own scope writes, stated `any`.
 *
 * With no annotation and no initializer (or a literal `null`/`undefined` one),
 * the checker types such a variable from the writes its own control flow sees,
 * and a closure's writes are never among them:
 *
 * ```js
 * let res
 * const promise = new Promise((resolve) => { res = resolve })
 * return { promise, resolve: res }
 * ```
 *
 * types `res` `undefined` at the return, the literal `{ resolve: undefined }`
 * and every caller's `resolve` `undefined`, though the executor already ran --
 * so a live function was read, laid out and passed on as `undefined` (fastify's
 * `lib/promise.js` fallback). Nothing the checker can compute is the variable's
 * type, and `any` is the statement that says so; the censuses then join every
 * write, the closure's included. Only a variable its own scope also READS is
 * stated: that read is the one the flow type gets wrong, and `any` costs every
 * other read the narrowing its own write gave it (three.js's `WebGLRenderer`
 * keeps a `let shadowMap` its nested `initGLContext` writes and reads, and its
 * field stays a native reference).
 *
 * In a TypeScript file the declaration gains `: any`. In a JavaScript file a
 * `let` gains `= /** @type {any} *\/ (undefined)`, which is the same binding;
 * a `var` gains no initializer -- one could reset a value a hoisted closure
 * stored before the declaration ran -- so only a single-declaration `var`
 * statement is stated, by a JSDoc tag on the statement. A write inside a
 * nested function counts whether or not that function shadows the name; the
 * cost of a false positive is a box, never a wrong value.
 */

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')
const isTypeScriptFile = (fileName: string): boolean =>
  (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) && !fileName.endsWith('.d.ts')

const autoTyped = (declaration: ts.VariableDeclaration): boolean => {
  if (!ts.isIdentifier(declaration.name) || declaration.type || ts.getJSDocType(declaration)) return false
  const initializer = declaration.initializer
  if (initializer === undefined) return true
  let value = initializer
  while (ts.isParenthesizedExpression(value)) value = value.expression
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined')
}

/** Whether `name` is assigned inside a function nested in `scope`. */
const writtenByClosure = (scope: ts.Node, name: string): boolean => {
  let found = false
  const isTarget = (target: ts.Node): boolean => {
    if (ts.isIdentifier(target)) return target.text === name
    if (ts.isArrayLiteralExpression(target)) return target.elements.some(isTarget)
    if (ts.isObjectLiteralExpression(target))
      return target.properties.some(
        (property) =>
          (ts.isShorthandPropertyAssignment(property) && property.name.text === name) ||
          (ts.isPropertyAssignment(property) && isTarget(property.initializer)) ||
          (ts.isSpreadAssignment(property) && isTarget(property.expression))
      )
    if (ts.isSpreadElement(target)) return isTarget(target.expression)
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) return isTarget(target.left)
    return false
  }
  const visit = (node: ts.Node, nested: boolean): void => {
    if (found) return
    if (nested) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        isTarget(node.left)
      ) {
        found = true
        return
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        isTarget(node.operand)
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(node, (child) => visit(child, nested || ts.isFunctionLike(child)))
  }
  ts.forEachChild(scope, (child) => visit(child, ts.isFunctionLike(child)))
  return found
}

/**
 * Whether `name` is read in `scope`'s own flow -- outside every function
 * nested in it, and not as a plain `=` target. Only such a read sees the
 * checker's flow type without the closure's writes: a read inside a nested
 * function already gets the auto-typed `any`, and one after the write in the
 * writing function is narrowed by that write.
 */
const readInOwnFlow = (scope: ts.Node, name: string): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node)) return
    if (ts.isIdentifier(node) && node.text === name && isRead(node)) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(scope, visit)
  return found
}

const isRead = (identifier: ts.Identifier): boolean => {
  const parent = identifier.parent
  if (ts.isVariableDeclaration(parent) && parent.name === identifier) return false
  if (ts.isBinaryExpression(parent) && parent.left === identifier && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false
  if (ts.isQualifiedName(parent) && parent.right === identifier) return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === identifier)
    return false
  return true
}

export const closureWrittenAutoTypeTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  const javaScript = isJavaScriptFile(input.fileName)
  if (!javaScript && !isTypeScriptFile(input.fileName)) return null
  const file = ts.createSourceFile(
    input.fileName,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    javaScript ? ts.ScriptKind.JS : ts.ScriptKind.TS
  )
  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) === 0) {
      const list = node.declarationList
      const isLet = (list.flags & ts.NodeFlags.Let) !== 0
      const scope = isLet
        ? (ts.findAncestor(
            node.parent,
            (ancestor) => ts.isBlock(ancestor) || ts.isSourceFile(ancestor) || ts.isFunctionLike(ancestor) || ts.isCaseBlock(ancestor)
          ) ?? file)
        : (ts.findAncestor(node.parent, (ancestor) => ts.isFunctionLike(ancestor)) ?? file)
      const written = list.declarations.filter(
        (declaration) =>
          autoTyped(declaration) &&
          writtenByClosure(scope, (declaration.name as ts.Identifier).text) &&
          readInOwnFlow(scope, (declaration.name as ts.Identifier).text)
      )
      if (!javaScript) {
        for (const declaration of written) edits.push({ start: declaration.name.getEnd(), end: declaration.name.getEnd(), text: ': any' })
      } else if (isLet) {
        for (const declaration of written) {
          if (declaration.initializer) {
            const start = declaration.initializer.getStart(file)
            const end = declaration.initializer.getEnd()
            edits.push({ start, end, text: `/** @type {any} */ (${input.text.slice(start, end)})` })
          } else {
            edits.push({ start: declaration.name.getEnd(), end: declaration.name.getEnd(), text: ' = /** @type {any} */ (undefined)' })
          }
        }
      } else if (written.length === 1 && list.declarations.length === 1) {
        const start = node.getStart(file)
        edits.push({ start, end: start, text: '/** @type {any} */ ' })
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
