import ts from 'typescript'
import { resolve } from 'path'

/**
 * The JavaScript functions whose `this` their callers supply although the
 * checker types it as an instance: `@this {any}` to write before each, per
 * file, as insertions into the text the first program parsed.
 *
 * ## The fact this states
 *
 * TypeScript treats a JavaScript function that assigns `this.x` as a
 * constructor and types its `this` as the instance it imagines that
 * constructor building -- a heuristic about the spelling. For a function the
 * program never constructs, `this` is whatever the caller passes: fastify's
 * `listen` assigns through `this` inside an arrow and is only ever called as
 * the fastify instance's own method. Typed as the imagined instance, every
 * call had to convert the real receiver into that layout, which only a
 * member-wise rebuild could do (refused for a receiver, `ir/lower-operands.ts`).
 *
 * Whether the program constructs a function is a whole-program fact, so it is
 * read from the first program's checker: a function is constructed when some
 * `new` expression's callee, or some class's `extends` clause, has it among
 * the declarations of its type -- across files and through `require` alike.
 * The second program is built with the tag in place, so the checker's own
 * `this` in the body (arrows included) is the caller-supplied one, and
 * `structural-receiver.ts` takes a stated `@this` as the call convention's
 * receiver.
 *
 * ## The guard
 *
 * A JavaScript function declaration, or a function expression that
 * initializes a single variable; with a `this.<name> =` or `this[<key>] =`
 * assignment in its own scope (arrows included, nested functions not) -- the
 * shape the heuristic keys on; no `@class`, `@constructor` or `@this` of its
 * own; and never constructed. A prototype member, an object literal member or
 * an instance-member assignment is left alone: the checker types its `this`
 * by where it is installed. The tag goes before the function's text, never
 * inside it, so `toString()` is unchanged.
 */
export const unconstructedThisInsertions = (
  program: ts.Program
): ReadonlyMap<string, readonly { readonly at: number; readonly text: string }[]> => {
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile)
  // The candidates first, from syntax alone: a program with none never asks
  // the checker anything here, so preparing it cannot perturb the order in
  // which the compile's own checker queries later create types.
  const candidates: {
    readonly file: ts.SourceFile
    readonly fn: ts.FunctionDeclaration | ts.FunctionExpression
    readonly host: ts.Node
  }[] = []
  for (const file of files) {
    if (!isJavaScriptPath(file.fileName)) continue
    const consider = (fn: ts.FunctionDeclaration | ts.FunctionExpression, host: ts.Node): void => {
      if (fn.body && assignsThisMember(fn.body) && !statesItsOwnThis(host, fn)) candidates.push({ file, fn, host })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node)) consider(node, node)
      if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const initializer = node.declarationList.declarations[0]?.initializer
        if (initializer && ts.isFunctionExpression(initializer)) consider(initializer, node)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  const found = new Map<string, { at: number; text: string }[]>()
  if (candidates.length === 0) return found
  const checker = program.getTypeChecker()
  const constructed = new Set<ts.Declaration>()
  const noteConstructed = (callee: ts.Expression): void => {
    for (const declaration of checker.getTypeAtLocation(callee).getSymbol()?.declarations ?? []) constructed.add(declaration)
  }
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) noteConstructed(node.expression)
      if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword)
        for (const type of node.types) noteConstructed(type.expression)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  for (const { file, fn, host } of candidates) {
    if (constructed.has(fn) || (ts.isFunctionExpression(fn) && ts.isVariableDeclaration(fn.parent) && constructed.has(fn.parent))) continue
    // Into the function's last JSDoc block when it has one: a second block
    // between a `@param` block and its function detaches the first one's
    // parameter types, exactly as `newCalleeClassTagSourceTransform` states.
    const docs = ts.getJSDocCommentsAndTags(fn).filter(ts.isJSDoc)
    const last = docs[docs.length - 1]
    const insertions = found.get(resolve(file.fileName)) ?? []
    insertions.push(last ? { at: last.end - 2, text: ' @this {any} ' } : { at: host.getStart(file), text: '/** @this {any} */ ' })
    found.set(resolve(file.fileName), insertions)
  }
  return found
}

/** The text with each insertion placed at its offset, spliced from the end so earlier offsets stay valid. */
export const withInsertions = (text: string, insertions: readonly { readonly at: number; readonly text: string }[]): string => {
  let rewritten = text
  for (const insertion of [...insertions].sort((left, right) => right.at - left.at)) {
    rewritten = `${rewritten.slice(0, insertion.at)}${insertion.text}${rewritten.slice(insertion.at)}`
  }
  return rewritten
}

const isJavaScriptPath = (fileName: string): boolean => /\.(?:js|mjs|cjs)$/.test(fileName)

const assignsThisMember = (body: ts.Node): boolean => {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      found = true
      return
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node) || ts.isMethodDeclaration(node)) return
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return found
}

const statesItsOwnThis = (host: ts.Node, fn: ts.Node): boolean =>
  [...ts.getJSDocTags(host), ...(host === fn ? [] : ts.getJSDocTags(fn))].some(
    (tag) => ts.isJSDocClassTag(tag) || ts.isJSDocThisTag(tag) || tag.tagName.text === 'constructor'
  )
