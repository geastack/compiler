import ts from 'typescript'
import { isStrictContext } from '../producers/shared.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import type { ValueFlowIndex } from './model.js'

export type SourceInvocationReceiverFact =
  | { readonly kind: 'expression'; readonly expression: ts.Expression; readonly conversion: 'identity' | 'sloppy-this' }
  | { readonly kind: 'undefined'; readonly reason: 'strict-direct' | 'strict-missing-this-argument' }
  | {
      readonly kind: 'global-object'
      readonly reason: 'sloppy-direct' | 'sloppy-missing-this-argument' | 'sloppy-nullish-this-argument'
      readonly expression?: ts.Expression
    }
  | { readonly kind: 'lexical'; readonly source: 'arrow'; readonly owner: ts.Node | null }
  | { readonly kind: 'lexical'; readonly source: 'super-member'; readonly owner: ts.Node; readonly static: boolean }
  | { readonly kind: 'lexical'; readonly source: 'super-constructor'; readonly owner: ts.Node }
  | { readonly kind: 'constructed'; readonly call: ts.NewExpression }
  | { readonly kind: 'unsupported'; readonly reason: 'unindexed-call' | 'unresolved-super-home' | 'nullish-member-base' }

const unwrapped = (expression: ts.Expression): ts.Expression => {
  let current = unwrapErasedExpression(expression)
  while (ts.isParenthesizedExpression(current)) current = unwrapErasedExpression(current.expression)
  return current
}

const definitelyNullish = (flow: ValueFlowIndex, expression: ts.Expression): boolean => {
  const value = unwrapped(expression)
  if (value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)) return true
  if (!ts.isIdentifier(value) || value.text !== 'undefined') return false
  const declaration = flow.targetOf(value)?.declaration
  return !declaration || declaration.getSourceFile().hasNoDefaultLib
}

const lexicalOwnerOf = (flow: ValueFlowIndex, body: ts.ArrowFunction): ts.Node | null => {
  let indexedOwner: ts.Node | null = null
  const findIndexedReference = (node: ts.Node): void => {
    if (indexedOwner) return
    if (node !== body && (ts.isClassLike(node) || (ts.isFunctionLike(node) && !ts.isArrowFunction(node)))) return
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      indexedOwner = flow.receiverOwnerOf(node)
      if (indexedOwner) return
    }
    ts.forEachChild(node, findIndexedReference)
  }
  findIndexedReference(body.body)
  if (indexedOwner) return indexedOwner

  let branch: ts.Node = body
  for (let current: ts.Node | undefined = body.parent; current; branch = current, current = current.parent) {
    if (
      (ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.name === branch
    )
      continue
    if (ts.isArrowFunction(current)) continue
    if (ts.isFunctionLike(current) || ts.isPropertyDeclaration(current) || ts.isClassStaticBlockDeclaration(current)) return current
    if (ts.isSourceFile(current)) return current
  }
  return null
}

/** Project only JavaScript's receiver binding rules for one already-admitted
 * invocation/body pair. It deliberately states coercion; proving the source
 * value is a native object belongs to the consumer's existing graph proof. */
export const sourceInvocationReceiverOf = (
  flow: ValueFlowIndex,
  call: ts.CallExpression | ts.NewExpression,
  body: ts.SignatureDeclaration
): SourceInvocationReceiverFact => {
  const site = flow.callSiteOf(call)
  if (!site) return { kind: 'unsupported', reason: 'unindexed-call' }
  const operands = site.operands
  if (ts.isNewExpression(call)) return { kind: 'constructed', call }

  if (operands.dispatch.kind === 'super-constructor') {
    return operands.dispatch.home
      ? { kind: 'lexical', source: 'super-constructor', owner: operands.dispatch.home }
      : { kind: 'unsupported', reason: 'unresolved-super-home' }
  }
  if (ts.isArrowFunction(body)) return { kind: 'lexical', source: 'arrow', owner: lexicalOwnerOf(flow, body) }
  const strict = isStrictContext(body, flow.buildIsStrict)
  if (operands.explicitThis) {
    const receiver = operands.receiver
    if (receiver === null)
      return strict
        ? { kind: 'undefined', reason: 'strict-missing-this-argument' }
        : { kind: 'global-object', reason: 'sloppy-missing-this-argument' }
    if (definitelyNullish(flow, receiver) && !strict)
      return { kind: 'global-object', reason: 'sloppy-nullish-this-argument', expression: receiver }
    return { kind: 'expression', expression: receiver, conversion: strict ? 'identity' : 'sloppy-this' }
  }

  if (operands.dispatch.kind === 'lexical-super') {
    return operands.dispatch.home
      ? { kind: 'lexical', source: 'super-member', owner: operands.dispatch.home, static: operands.dispatch.static }
      : { kind: 'unsupported', reason: 'unresolved-super-home' }
  }

  if (operands.dispatch.kind === 'member') {
    const receiver = operands.receiver
    if (receiver === null) return { kind: 'unsupported', reason: 'unindexed-call' }
    if (definitelyNullish(flow, receiver)) return { kind: 'unsupported', reason: 'nullish-member-base' }
    return { kind: 'expression', expression: receiver, conversion: strict ? 'identity' : 'sloppy-this' }
  }

  return strict ? { kind: 'undefined', reason: 'strict-direct' } : { kind: 'global-object', reason: 'sloppy-direct' }
}
