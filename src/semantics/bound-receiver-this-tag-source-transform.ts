import ts from 'typescript'

/**
 * A module function only ever run on one class's instance -- every reference
 * to it is `F.bind( this )`, `F.call( this, ... )` or `F.apply( this, ... )`
 * from that class's own instance code -- tagged `/** @this {C} *\/`.
 *
 * ## The fact this states
 *
 * three's XRManager keeps its session handlers as module functions and binds
 * each one in the constructor: `this._onSessionEnd = onSessionEnd.bind( this )`.
 * The bound function's `[[BoundThis]]` is that XRManager (10.4.1.3), and no
 * other reference can reach `onSessionEnd`, so `this` in its body is an
 * XRManager on every run. The checker cannot see that: a JS function whose
 * body writes `this.x = ...` is inferred to be a constructor, its `this` is its
 * own instance layout, and `onSessionEnd`'s `this._session` -- read before its
 * own `this._session = null` -- typed `undefined` instead of XRManager's
 * `@type {?XRSession}`, so storing the `null` back had no conversion.
 *
 * JSDoc `@this` is the checker's own spelling for a function's receiver, read
 * before the constructor inference (`tryGetThisTypeAt`). The tag names the
 * class the bind sites already name, so it is not a type this compiler
 * invented: every `this.x` in the body is then the class's published member.
 *
 * ## The guard
 *
 * A JavaScript file only. A function is tagged when ALL of these hold:
 * - it is a top-level, non-exported `FunctionDeclaration` with a body that
 *   reads `this` (an arrow inside it shares that `this`), and it carries no
 *   `@this`, `@class` or `@constructor` tag. Parameters are admitted: a
 *   function with a `this` type binds through lib's `OmitThisParameter`,
 *   whose `(...args: [layer?: any]) => R` is the bind protocol's own closed
 *   tuple and is flattened to positional slots (`isBuiltinBindParameter`);
 * - it has at least one reference, and every identifier spelled like it in
 *   the file (outside its own name and a property name) is the receiver of a
 *   `.bind`/`.call`/`.apply` call whose first argument is `this` -- so a
 *   shadowing local, a plain call, an export or a stored reference refuses;
 * - that `this` is, through arrows only, the instance of ONE class: a
 *   non-static constructor, method, accessor or field initializer of one
 *   named top-level class of the same file, whose name the function itself
 *   never spells (a local of that name would rebind the tag's type).
 *
 * Text in, text out, spliced from the end backward, as the other transforms
 * in this directory do. The tag goes inside the function's last JSDoc block
 * when it has one, so a `@param` block stays attached.
 */

const isJavaScriptFile = (fileName: string): boolean => fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')

const receiverTagged = (node: ts.Node): boolean =>
  ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'this' || tag.tagName.text === 'class' || tag.tagName.text === 'constructor')

/** Whether `body` reads `this` as its own receiver: through arrows, never through a nested function or class. */
const readsOwnThis = (body: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true
      return
    }
    if ((ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node)) return
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return found
}

/** The class whose instance a `this` expression denotes, through arrows only, or `null`. */
const instanceClassOfThis = (node: ts.Node): ts.ClassDeclaration | null => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current)) continue
    const isStatic =
      ts.canHaveModifiers(current) && (ts.getModifiers(current)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    if (
      (ts.isConstructorDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      !isStatic &&
      ts.isClassDeclaration(current.parent)
    ) {
      return current.parent
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isClassStaticBlockDeclaration(current) || ts.isSourceFile(current))
      return null
  }
  return null
}

/** The class `reference` is bound or called on when it is `F.bind( this )`, `F.call( this, ... )` or `F.apply( this, ... )`. */
const boundReceiverClassOf = (reference: ts.Identifier): ts.ClassDeclaration | null => {
  const access = reference.parent
  if (!ts.isPropertyAccessExpression(access) || access.expression !== reference || !ts.isIdentifier(access.name)) return null
  const member = access.name.text
  if (member !== 'bind' && member !== 'call' && member !== 'apply') return null
  const call = access.parent
  if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken) return null
  const receiver = call.arguments[0]
  if (!receiver || receiver.kind !== ts.SyntaxKind.ThisKeyword) return null
  return instanceClassOfThis(receiver)
}

/** Identifiers that name no binding: a member name after `.`, or a property, method or accessor name in a literal or class body. */
const isPropertyName = (node: ts.Identifier): boolean => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  )
}

const spells = (root: ts.Node, name: string): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === name) found = true
    else ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

interface Candidate {
  readonly at: number
  readonly text: string
}

const candidatesIn = (file: ts.SourceFile): readonly Candidate[] => {
  const functions = new Map<string, ts.FunctionDeclaration>()
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (receiverTagged(statement) || !readsOwnThis(statement.body)) continue
    functions.set(statement.name.text, statement)
  }
  if (functions.size === 0) return []
  // Two declarations of one name are one binding whose value is the last;
  // which body a reference reaches is then not this scan's to say.
  const declaredTwice = new Set<string>()
  const seen = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
    if (seen.has(statement.name.text)) declaredTwice.add(statement.name.text)
    seen.add(statement.name.text)
  }

  const receiverClass = new Map<string, ts.ClassDeclaration | null>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && functions.has(node.text) && !isPropertyName(node)) {
      const fn = functions.get(node.text) as ts.FunctionDeclaration
      if (node !== fn.name) {
        const bound = boundReceiverClassOf(node)
        const held = receiverClass.get(node.text)
        receiverClass.set(node.text, bound === null || (held !== undefined && held !== bound) ? null : bound)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  const found: Candidate[] = []
  for (const [name, fn] of functions) {
    const cls = receiverClass.get(name)
    if (!cls || !cls.name || declaredTwice.has(name)) continue
    if (!file.statements.includes(cls)) continue
    if (spells(fn, cls.name.text)) continue
    const tag = ` @this {${cls.name.text}} `
    const docs = ts.getJSDocCommentsAndTags(fn).filter(ts.isJSDoc)
    const last = docs[docs.length - 1]
    found.push(last ? { at: last.end - 2, text: tag } : { at: fn.getStart(file), text: `/**${tag}*/ ` })
  }
  return found.sort((a, b) => a.at - b.at)
}

export const boundReceiverThisTagSourceTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  if (!isJavaScriptFile(input.fileName) || !input.text.includes('this')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const candidates = candidatesIn(file)
  if (candidates.length === 0) return null
  let rewritten = input.text
  for (const candidate of [...candidates].reverse()) {
    rewritten = `${rewritten.slice(0, candidate.at)}${candidate.text}${rewritten.slice(candidate.at)}`
  }
  return rewritten
}
