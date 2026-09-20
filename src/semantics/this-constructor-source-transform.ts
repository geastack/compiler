import ts from 'typescript'

/**
 * `new this.constructor(...)`, three's universal clone idiom
 * (`clone() { return new this.constructor().copy( this ); }`), rewritten so
 * the checker's OWN answer for the expression is TypeScript's `this` type,
 * instead of `any`.
 *
 * ## The fact this states
 *
 * Inside a class body, `this.constructor` denotes that class's own
 * constructor -- not an inference, a language guarantee for a constructor
 * that is never reassigned. `new this.constructor()` therefore produces an
 * instance of the class currently executing: TypeScript's `this` type,
 * exactly the type that stays correct when a subclass inherits the method
 * without overriding it (`new this.constructor()` on a `Derived` produces a
 * `Derived`, not the `Base` the method is textually declared on) -- which is
 * exactly why three's classes lean on this idiom for `clone()`.
 *
 * TypeScript itself does not draw this conclusion: `Object`'s ambient
 * `constructor: Function` (`lib.es5.d.ts`) types every `.constructor` access
 * as the bare `Function` interface, which the checker special-cases as
 * callable/constructible with argument and result type `any` -- so
 * `new this.constructor()` types as `any`, and everything downstream of a
 * `clone()` call inherits it. Measured on the three.js app: 100 boxed carriers root at
 * that one `lib.es5.d.ts` declaration; the 34 clone-idiom call sites (three's
 * math/core classes) account for on the order of 80-90 boxed operations per
 * program once the `new`, the `.copy(this)` call, and the `return` around
 * each are all counted (`.scratch/fleet/w3/tmp/clone-census.mjs`).
 *
 * ## Why a source transform, not a census rule
 *
 * `derived-expression-type.ts`'s `memberTypeOf` is the ONE place all four
 * per-kind censuses (parameter/local/return/field-bindings) resolve a member
 * read through, so it looks like the natural home -- but it cannot fix this.
 * `new this.constructor()`'s callee needs a type that HAS a construct
 * signature returning `this`, and no real TypeScript value has one: the
 * class's own "static side" (`typeof ClassName`) has a construct signature,
 * but its return type is the LITERAL class, not the polymorphic `this` a
 * subclass needs -- substituting it would be a silent narrowing bug the
 * moment a subclass inherits `clone()` without overriding it. The only sound
 * answer is `this` itself, and the only place a construct signature can
 * genuinely return `this` is a construct signature the checker synthesizes
 * for us. TypeScript already knows how, for exactly one spelling: casting
 * the callee to a constructor type that names `this` as its return type
 * (`x as new (...args: any[]) => this`) -- verified against the checker
 * directly: `checker.getTypeAtLocation` on the resulting `new` expression
 * reports `this`, and a `Derived` instance calling an inherited `clone()`
 * comes back typed `Derived`, not `Base`.
 *
 * That is a fact about the EXPRESSION's shape, expressible only by rewriting
 * the expression itself -- there is no lever in the census (which only reads
 * types the checker already assigns) that can hand a real value a construct
 * signature it does not have. So this runs here, pre-checker, the same way
 * `definePropertySourceTransform` rewrites a call the checker has no special
 * knowledge of into a form its EXISTING inference already understands
 * unmodified.
 *
 * ## The guard
 *
 * Only `new this.constructor(...)` -- the receiver must be the literal
 * `this` keyword (never a captured alias like `const self = this`, never
 * `obj.constructor`), and `this` must resolve, at the point of use, to a
 * class instance: the nearest enclosing function that actually BINDS `this`
 * (skipping arrow functions, which inherit it) must be a method, accessor,
 * or constructor declared directly on a class. A `this.constructor` reached
 * through a plain nested `function`, or used outside any class, is left
 * untouched -- refusing rather than guessing which `this` it would have been
 * bound to at a call site this transform cannot see.
 *
 * The rule holds only while `constructor` is never reassigned -- rare, but
 * real (`Foo.prototype.constructor = Bar`, `instance.constructor = Bar`) --
 * so any file containing such an assignment is left alone in its entirety:
 * this transform does not attempt to prove which classes a reassignment can
 * and cannot reach, only that the file as a whole no longer states the fact
 * it exists to state.
 *
 * ## Why text, and why splicing
 *
 * Text in, text out, spliced from the end backward so an earlier match's
 * offsets are never invalidated by a later match's replacement -- the same
 * discipline `definePropertySourceTransform` documents for the same reason.
 * Only the callee (`this.constructor`) is replaced; the call's arguments and
 * everything chained onto the `new` expression (three's `.copy( this )`
 * included) are left exactly as written.
 */

interface Candidate {
  readonly calleeStart: number
  readonly calleeEnd: number
  readonly replacement: string
}

/** `this.constructor` -- the literal receiver, never an alias or a plain object. */
const isThisConstructorAccess = (node: ts.Expression): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === 'constructor'

/**
 * The nearest function that actually BINDS `this` for `node`, skipping
 * arrow functions (which inherit `this` from their enclosing scope rather
 * than rebinding it) -- `null` when `node` sits at the top level of a file
 * with no such function at all.
 */
const thisBindingBoundary = (node: ts.Node): ts.Node | null => {
  let n: ts.Node | undefined = node.parent
  while (n) {
    if (ts.isArrowFunction(n)) {
      n = n.parent
      continue
    }
    if (
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessor(n) ||
      ts.isSetAccessor(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n)
    )
      return n
    n = n.parent
  }
  return null
}

/**
 * Whether `node`'s `this` is a class instance: its nearest `this`-binding
 * function is a method/accessor/constructor declared directly on a class,
 * never a plain `function` (whose `this` a caller could bind to anything)
 * and never one with no class parent at all (an object-literal method, a
 * free function).
 */
const isClassInstanceThis = (node: ts.Node): boolean => {
  const boundary = thisBindingBoundary(node)
  if (!boundary) return false
  if (ts.isFunctionDeclaration(boundary) || ts.isFunctionExpression(boundary)) return false
  return boundary.parent !== undefined && ts.isClassLike(boundary.parent)
}

/**
 * Whether `file` anywhere assigns to a `.constructor` property -- the one
 * case that would make `this.constructor` not denote the class's own
 * constructor at runtime. Scanned whole-file, conservatively: a single
 * reassignment anywhere disqualifies every occurrence in the file, rather
 * than this transform trying to prove which classes it can and cannot reach.
 */
const fileReassignsConstructor = (file: ts.SourceFile): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'constructor'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * How to spell the cast, in a language the file is actually written in.
 *
 * `x as T` is TypeScript syntax. Splicing it into a `.js` file makes the
 * checker report "Type assertion expressions can only be used in TypeScript
 * files" for every rewritten site -- it recovers and still infers the type, so
 * the measurement looked clean, but the transform was writing source the
 * language does not have. JavaScript's own spelling for the same assertion is
 * a parenthesised JSDoc type cast, which `checkJs` reads with identical
 * meaning and no diagnostic. Every three.js file this transform touches is
 * `.js`; a TypeScript class reaches the same rule through `as`.
 */
const castTo = (fileName: string, expression: string, type: string): string =>
  fileName.endsWith('.ts') || fileName.endsWith('.tsx') ? `(${expression} as ${type})` : `(/** @type {${type}} */ (${expression}))`

const candidatesIn = (file: ts.SourceFile): readonly Candidate[] => {
  const found: Candidate[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && isThisConstructorAccess(node.expression) && isClassInstanceThis(node)) {
      found.push({
        calleeStart: node.expression.getStart(file),
        calleeEnd: node.expression.end,
        replacement: castTo(file.fileName, node.expression.getText(file), 'new (...args: any[]) => this')
      })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

const scriptKindOf = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export const thisConstructorSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  // A file that never spells `.constructor` cannot contain the idiom -- one
  // substring test is what a file this transform has nothing to do with costs.
  if (!input.text.includes('.constructor')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
  if (fileReassignsConstructor(file)) return null
  const candidates = candidatesIn(file)
  if (candidates.length === 0) return null
  let rewritten = input.text
  // Spliced from the end so every earlier candidate's range is still the
  // range it was measured at -- see the module comment.
  for (const candidate of [...candidates].reverse()) {
    rewritten = rewritten.slice(0, candidate.calleeStart) + candidate.replacement + rewritten.slice(candidate.calleeEnd)
  }
  return rewritten
}
