import ts from 'typescript'

/**
 * `function listen (options, cb = undefined)` in a JavaScript file, with
 * `cb` stated as the untyped parameter it is.
 *
 * ## The fact this states
 *
 * A default initializer runs only when the argument is `undefined`
 * (ECMA-262 10.2.11 step 26), so `= undefined` replaces `undefined` with
 * `undefined`: the parameter's values are exactly those of the same
 * parameter written without it. What the initializer does change is
 * `Function.prototype.length`, which is why the source keeps it.
 *
 * TypeScript nonetheless types such a parameter from its initializer. With
 * `strictNullChecks` the answer is the unit type `undefined` -- the value of
 * the default, not the domain of the parameter -- so a TypeScript importer
 * that passes a callback is refused: fastify's `listen(listenOptions = {…},
 * cb = undefined)` rejects `app.listen(opts, (err, address) => …)` with
 * TS2345. (Without `strictNullChecks` TypeScript widens that initializer to
 * `any`, which is the answer this restores.) The parameter's real domain is
 * the parameter census's to find, from its call sites, exactly as it is for
 * an unannotated JavaScript parameter.
 *
 * ## The guard
 *
 * A `.js`/`.mjs`/`.cjs` file that declares nothing named `undefined` (so the
 * initializer is the global's value); an identifier parameter, not a rest,
 * whose initializer is the bare identifier `undefined`; no inline JSDoc type
 * and no `@param` tag for it, and no `@type` on the function, which would
 * state the whole signature. The tag is placed where the checker reads a
 * function's tags: on a declaration or method itself, or on the statement,
 * variable statement or property that a function expression is the value of.
 * Any other shape is left as written, and TypeScript's own answer stands.
 *
 * Text in, text out, spliced from the end backward. The block is inserted
 * before the function's own text, never inside it, so `toString()` of every
 * function is unchanged.
 */

interface Edit {
  readonly at: number
  readonly text: string
}

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

const bindsItsName = (node: ts.Node): boolean =>
  ts.isVariableDeclaration(node) ||
  ts.isParameter(node) ||
  ts.isBindingElement(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isClassDeclaration(node) ||
  ts.isClassExpression(node) ||
  ts.isImportClause(node) ||
  ts.isImportSpecifier(node) ||
  ts.isNamespaceImport(node) ||
  ts.isImportEqualsDeclaration(node)

const declaresUndefined = (file: ts.SourceFile): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isIdentifier(node) &&
      node.text === 'undefined' &&
      bindsItsName(node.parent) &&
      (node.parent as { readonly name?: ts.Node }).name === node
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The node whose leading JSDoc the checker reads for this function's tags, or `null` for a shape this transform does not claim. */
const tagHostOf = (fn: ts.SignatureDeclaration): ts.Node | null => {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn)) return fn
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return null
  const parent = fn.parent
  if (ts.isPropertyAssignment(parent) && parent.initializer === fn) return parent
  if (ts.isVariableDeclaration(parent) && parent.initializer === fn) {
    const list = parent.parent
    return ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent) ? list.parent : null
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === fn &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isExpressionStatement(parent.parent)
  )
    return parent.parent
  return null
}

const editsIn = (file: ts.SourceFile, text: string): readonly Edit[] => {
  const edits: Edit[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'parameters' in node) {
      const names = node.parameters.flatMap((parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.dotDotDotToken === undefined &&
        parameter.initializer !== undefined &&
        ts.isIdentifier(parameter.initializer) &&
        parameter.initializer.text === 'undefined' &&
        parameter.type === undefined &&
        ts.getJSDocType(parameter) === undefined &&
        ts.getJSDocParameterTags(parameter).length === 0
          ? [parameter.name.text]
          : []
      )
      const host = names.length > 0 ? tagHostOf(node) : null
      if (host !== null && ts.getJSDocTypeTag(node) === undefined && ts.getJSDocTypeTag(host) === undefined) {
        // Into the function's last JSDoc block when it has one: a second block
        // between a `@param` block and its function detaches the first one's
        // parameter types (`newCalleeClassTagSourceTransform` states the same).
        const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
        const last = docs[docs.length - 1]
        if (last) {
          edits.push({ at: last.end - 2, text: names.map((name) => ` @param {any} [${name}] `).join('') })
        } else {
          const start = host.getStart(file)
          const lineStart = file.getLineStarts()[file.getLineAndCharacterOfPosition(start).line] ?? start
          const indent = text.slice(lineStart, start).replace(/[^\t ]/g, '')
          const lines = names.map((name) => `${indent} * @param {any} [${name}]`)
          edits.push({ at: start, text: `/**\n${lines.join('\n')}\n${indent} */\n${indent}` })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return edits
}

export const undefinedDefaultParameterTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName) || !input.text.includes('undefined')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (declaresUndefined(file)) return null
  const edits = editsIn(file, input.text)
  if (edits.length === 0) return null
  let rewritten = input.text
  for (const edit of [...edits].sort((left, right) => right.at - left.at)) {
    rewritten = `${rewritten.slice(0, edit.at)}${edit.text}${rewritten.slice(edit.at)}`
  }
  return rewritten
}
