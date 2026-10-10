import ts from 'typescript'
import { inheritedImplementationOf } from './merged-declaration.js'

/**
 * The method body a member call runs when it returns an array NO OTHER
 * REFERENCE holds: every `return` hands back an array literal, or a local
 * initialized with one that the body only fills, indexes and measures.
 *
 * This is the one fact that makes converting an `array-object` between two
 * element carriers sound. A conversion between them has to allocate, and for
 * a mutable array a second array loses every write through the other alias
 * (`array-object-call-argument-aliasing`). A call result proven fresh has no
 * other alias: the callee dropped its own reference when it returned, so the
 * converted array is the only one the program can ever observe, and a
 * one-time element-wise copy at the call is indistinguishable from the
 * callee having built it at the caller's element type.
 *
 * An `async` body qualifies the same way: its promise settles with the
 * array its `return` names, and that array is still held by nothing else.
 * A generic cursor's `async toArray()` is the shape this exists for -- it
 * builds `const array: T[] = []`, pushes every item and returns it, while the
 * cursor class is folded onto its `any` copy (`specialization.ts`'s
 * reinterpreted classes), so the body hands back `any[]` where the caller's
 * view declares `Info[]`.
 *
 * Deliberately syntactic and small. Any use of the local outside the listed
 * forms -- passing it as an argument, storing it, capturing it in a closure,
 * a method whose result aliases it (`reverse`, `sort`), iteration protocol
 * hooks -- refuses, and a refusal only keeps the conversion refused. The key
 * is returned alongside so lowering can confirm the call it runs really
 * reaches this body: an override in the receiver's family, or a prototype
 * write, would run a different body the proof never saw.
 */
export const unsharedArrayResultBodyOf = (checker: ts.TypeChecker, node: ts.CallExpression): ts.MethodDeclaration | null => {
  if (ts.isOptionalChain(node)) return null
  const callee = skipParentheses(node.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return null
  const member = checker.getSymbolAtLocation(callee.name)
  if (!member) return null
  const implementation = inheritedImplementationOf(checker, member) ?? member
  const bodies = (implementation.declarations ?? []).filter(
    (declaration): declaration is ts.MethodDeclaration =>
      ts.isMethodDeclaration(declaration) && declaration.body !== undefined && ts.isClassLike(declaration.parent)
  )
  const body = bodies.length === 1 ? bodies[0]! : null
  if (!body || body.asteriskToken !== undefined) return null
  return returnsFreshArray(checker, body) ? body : null
}

const returnsFreshArray = (checker: ts.TypeChecker, body: ts.MethodDeclaration): boolean => {
  const returns: ts.Expression[] = []
  let bare = false
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(skipParentheses(node.expression))
      else bare = true
    }
    ts.forEachChild(node, collect)
  }
  ts.forEachChild(body.body!, collect)
  if (bare || returns.length === 0) return false
  return returns.every((expression) => ts.isArrayLiteralExpression(expression) || freshLocal(checker, body, expression))
}

const freshLocal = (checker: ts.TypeChecker, body: ts.MethodDeclaration, expression: ts.Expression): boolean => {
  if (!ts.isIdentifier(expression)) return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
  if (!declaration.initializer || !ts.isArrayLiteralExpression(skipParentheses(declaration.initializer))) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false
  if (enclosingFunction(declaration) !== body) return false
  let admitted = true
  const visit = (node: ts.Node): void => {
    if (!admitted) return
    if (ts.isIdentifier(node) && node !== declaration.name && checker.getSymbolAtLocation(node) === symbol) {
      admitted = enclosingFunction(node) === body && nonEscapingUse(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body.body!, visit)
  return admitted
}

/** A use that reads, fills or measures the array and hands no reference to it anywhere. */
const nonEscapingUse = (use: ts.Identifier): boolean => {
  const parent = use.parent
  if (ts.isReturnStatement(parent)) return true
  if (ts.isParenthesizedExpression(parent)) return false
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use && ts.isIdentifier(parent.name)) {
    const name = parent.name.text
    if (name === 'length') return !isAssignmentTarget(parent)
    const call = parent.parent
    return (name === 'push' || name === 'unshift') && ts.isCallExpression(call) && call.expression === parent
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === use) return true
  return false
}

const isAssignmentTarget = (node: ts.Node): boolean =>
  ts.isBinaryExpression(node.parent) &&
  node.parent.left === node &&
  node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment

const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  return current
}

const skipParentheses = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ? skipParentheses(node.expression)
    : node
