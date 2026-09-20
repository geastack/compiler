import ts from 'typescript'

/**
 * `o[Symbol.iterator] = function () { ... }` on an object-literal-declared
 * holder in a JavaScript file, with the function parenthesised so the
 * binder stops reading it as an expando member declaration.
 *
 * ## The fact this states
 *
 * In a `.js` file, TypeScript's binder treats a function-valued assignment
 * to a member of a variable initialised with an object literal as a
 * DECLARATION of that member (the "expando" rule that types
 * `var o = {}; o.next = function () {}`). When the member's name is a
 * well-known symbol (`Symbol.iterator`, `Symbol.toPrimitive`, ...), that
 * declaration is late-bound, and resolving it walks from the function
 * expression to its parent's symbol -- which an object literal's expando
 * table does not carry. `getFunctionExpressionParentSymbolOrSymbol` then
 * calls `getLateBoundSymbol` on `undefined`, and the checker throws
 * `Cannot read properties of undefined (reading 'flags')` from
 * `getMembersOfSymbol` inside the FIRST `getTypeAtLocation` that touches the
 * holder. Measured on the 2026-09-05 test262 sample: 23 cases crash the
 * compiler this way, every one of them a hand-rolled iterable of exactly
 * this shape (`var iterable = {}; iterable[Symbol.iterator] = function ...`,
 * `harness/testTypedArray.js`-style protocol objects included).
 *
 * The program's meaning is unchanged by parentheses: `o[k] = (function () {})`
 * evaluates identically at runtime. What changes is that the binder's expando
 * test asks `isFunctionExpression(initializer)` on the syntax as written, and
 * a parenthesised function is not one -- so the assignment binds as an
 * ordinary element write, the holder's symbol table stays whatever the
 * object literal stated, and the checker answers every later question about
 * it instead of throwing. The census then sees a plain dynamic element write
 * and refuses on its own terms ("the source declares no @@iterator/next
 * chain this can read an element type from"), which is the honest verdict
 * for a protocol the compiler cannot yet type -- a refusal with a reason,
 * where before there was a stack trace.
 *
 * ## The guard
 *
 * Only the shape that crashes, verified case by case against the checker:
 * a `.js` file; a plain `=`; a left-hand element access whose key is a
 * property read off the `Symbol` identifier; a right-hand function
 * expression or arrow (a class expression, a string key, an identifier key
 * bound to a symbol, and a holder that is a function, a parameter, or `this`
 * all resolve without crashing and are left as written); and a holder whose
 * root identifier this file declares with an object-literal initialiser
 * (`var`/`let`/`const`), reached directly or through property reads
 * (`o.x[Symbol.iterator]` crashes the same way). A function-declared holder
 * (`F[Symbol.iterator] = ...`, `F.prototype[Symbol.iterator] = ...`) keeps
 * its expando declaration: there the binder finds the parent symbol and the
 * member it declares is real typing information this transform must not
 * erase.
 *
 * Text in, text out, spliced from the end backward so earlier offsets stay
 * valid -- the same discipline the other transforms in this directory
 * document. Only two parentheses are inserted, around the function, so no
 * other node in the file changes its text.
 */

interface Candidate {
  readonly start: number
  readonly end: number
}

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

/** `Symbol.<name>` -- a well-known symbol read straight off the global `Symbol`. */
const isWellKnownSymbolKey = (key: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(key) && ts.isIdentifier(key.expression) && key.expression.text === 'Symbol'

/**
 * The identifier a member chain is rooted at, walking property reads only:
 * `o` for `o`, `o.x` and `o.x.y`; `null` for a chain that passes through a
 * call, an element read, `this`, or anything else this transform does not
 * claim to understand.
 */
const chainRootOf = (holder: ts.Expression): ts.Identifier | null => {
  let node: ts.Expression = holder
  while (ts.isPropertyAccessExpression(node)) node = node.expression
  return ts.isIdentifier(node) ? node : null
}

/**
 * Every identifier this file declares with an object-literal initialiser, by
 * name -- collected once per file so each candidate costs one set lookup.
 * Scoping is deliberately ignored: a same-named shadow with a non-literal
 * initialiser would at worst parenthesise a function on a holder the checker
 * could have bound, and a parenthesised function is still a correct program.
 */
const objectLiteralDeclarationsIn = (file: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer))
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

const candidatesIn = (file: ts.SourceFile): readonly Candidate[] => {
  const holders = objectLiteralDeclarationsIn(file)
  if (holders.size === 0) return []
  const found: Candidate[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isWellKnownSymbolKey(node.left.argumentExpression) &&
      (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))
    ) {
      const root = chainRootOf(node.left.expression)
      if (root && holders.has(root.text)) found.push({ start: node.right.getStart(file), end: node.right.end })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

export const symbolKeyedExpandoSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName) || !input.text.includes('[Symbol.')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const candidates = candidatesIn(file)
  if (candidates.length === 0) return null
  let rewritten = input.text
  for (const candidate of [...candidates].reverse()) {
    rewritten = `${rewritten.slice(0, candidate.start)}(${rewritten.slice(candidate.start, candidate.end)})${rewritten.slice(candidate.end)}`
  }
  return rewritten
}
