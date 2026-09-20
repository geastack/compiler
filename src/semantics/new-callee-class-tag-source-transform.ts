import ts from 'typescript'

/**
 * A plain JavaScript function the program constructs with `new`, tagged
 * `/** @class *\/` so the checker's own JS-constructor inference runs on it.
 *
 * ## The fact this states
 *
 * `function F() {}` followed by `new F()` is a constructor call: ECMA-262
 * gives every ordinary function a `[[Construct]]`, and the result is a fresh
 * object whose prototype is `F.prototype`. TypeScript's JavaScript inference
 * reaches the same conclusion, but only from EVIDENCE inside the function --
 * a `this.x = ...` assignment, a `F.prototype.m = ...` assignment, or a JSDoc
 * `@class`/`@constructor` tag. A constructor with nothing to initialise has
 * none of that evidence, so the checker types `new F()` as `any`, gives `F` no
 * construct signature, and this compiler then refuses the call with
 * "invocation result type any disagrees with selected return type void"
 * (`semantics/model/selected-signature.ts`). Measured on the 2026-09-05
 * test262 sample: 21 cases, every one `var F = function () {}; new F()` or
 * `function F() {} ... new F()` with an empty or field-free body.
 *
 * The program's meaning is unchanged by the tag -- JSDoc is a comment -- but
 * the checker's answer is: a tagged function gets exactly one construct
 * signature returning its (empty) instance type, which is the same inference
 * the checker already performs for the field-initialising form (a function
 * with top-level `this.x = ` writes). So the tag is the JavaScript spelling of a fact
 * the `new` expression already states, placed where the checker reads it;
 * it is not a type this compiler invented.
 *
 * ## The guard
 *
 * A JavaScript file only. A function is tagged when ALL of these hold:
 * - it is a `FunctionDeclaration`, or a `FunctionExpression` that is the
 *   whole initializer of a `var`/`let`/`const` declaration -- the two shapes
 *   `new F()` resolves to by name, and the two the checker's `@class`
 *   attachment is verified for;
 * - some `new F(...)` in the file names it, and NO plain `F(...)` call does:
 *   a `@class` function called without `new` is a checker error, and a
 *   function used both ways is a factory this transform must not speak for;
 * - its body has no top-level `return <expression>`: a function that returns
 *   a value from `new` is a factory typed by what it returns (the invocation
 *   producer's own rule), not a constructor of its own instance type;
 * - it carries no `@class`/`@constructor` tag already.
 *
 * Text in, text out, spliced from the end backward so earlier offsets stay
 * valid, as the other transforms in this directory do. The tag goes INSIDE
 * the function's last existing JSDoc block when it has one (a second block
 * between a `@param` block and the function detached the parameter types),
 * and in a fresh `/** @class *\/` block before the function otherwise.
 */

interface Candidate {
  /** Where the text goes: a fresh block before the function, or inside its last existing JSDoc block. */
  readonly at: number
  readonly text: string
}

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

const returnsAValue = (body: ts.Block): boolean =>
  body.statements.some((statement) => ts.isReturnStatement(statement) && statement.expression !== undefined)

const alreadyTagged = (node: ts.Node): boolean =>
  ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'class' || tag.tagName.text === 'constructor')

/** The functions `new F()` can name in this file, by name: declarations, and `var F = function () {}` initializers. */
const constructibleFunctionsIn = (file: ts.SourceFile): ReadonlyMap<string, ts.FunctionDeclaration | ts.FunctionExpression> => {
  const found = new Map<string, ts.FunctionDeclaration | ts.FunctionExpression>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) found.set(node.name.text, node)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isFunctionExpression(node.initializer) &&
      node.initializer.body
    ) {
      found.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const candidatesIn = (file: ts.SourceFile): readonly Candidate[] => {
  const functions = constructibleFunctionsIn(file)
  if (functions.size === 0) return []
  const constructed = new Set<string>()
  const called = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) constructed.add(node.expression.text)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const found: Candidate[] = []
  for (const [name, fn] of functions) {
    if (!constructed.has(name) || called.has(name)) continue
    if (!fn.body || returnsAValue(fn.body) || alreadyTagged(fn)) continue
    // Into an existing JSDoc block, never beside it: a second block placed
    // between a `@param` block and its function detached the first one's
    // parameter types (the checker read the parameters as implicit `any`).
    const docs = ts.getJSDocCommentsAndTags(fn).filter(ts.isJSDoc)
    const last = docs[docs.length - 1]
    found.push(last ? { at: last.end - 2, text: ' @class ' } : { at: fn.getStart(file), text: '/** @class */ ' })
  }
  return found.sort((a, b) => a.at - b.at)
}

export const newCalleeClassTagSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName) || !input.text.includes('new ')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const candidates = candidatesIn(file)
  if (candidates.length === 0) return null
  let rewritten = input.text
  for (const candidate of [...candidates].reverse()) {
    rewritten = `${rewritten.slice(0, candidate.at)}${candidate.text}${rewritten.slice(candidate.at)}`
  }
  return rewritten
}
