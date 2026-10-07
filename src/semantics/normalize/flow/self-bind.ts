import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { sourceClassKeyReadPlanOf, type SourceClassFamilyQuery } from './source-class-data.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'

/** The syntactic and checker half of a self-bind; `provenSelfBindOf` adds the proof-state half. */
export interface SelfBindShape {
  readonly store: ts.BinaryExpression
  readonly destination: ts.PropertyAccessExpression
  readonly source: ts.PropertyAccessExpression
  readonly bind: ts.PropertyAccessExpression
  readonly key: string
  /** The destination's object, the bound source's object and the bound receiver, in that order. */
  readonly receivers: readonly ts.Expression[]
}

/**
 * Two mentions denote one object only when they are the same lexical `this`
 * or the same `const` binding. Anything a write could retarget between the
 * destination's evaluation and the bind call is a different receiver.
 */
const sameReceiver = (flow: ValueFlowIndex, left: ts.Expression, right: ts.Expression): boolean => {
  if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = flow.receiverOwnerOf(left)
    return owner !== null && owner === flow.receiverOwnerOf(right)
  }
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right)) return false
  const declaration = flow.targetOf(left)?.declaration
  return (
    declaration !== undefined &&
    declaration !== null &&
    ts.isVariableDeclaration(declaration) &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0 &&
    flow.targetOf(right)?.declaration === declaration
  )
}

/**
 * `x.m = x.m.bind(x)`: the slot keeps a function bound to the very object
 * that owns the slot. Three's `Renderer` does this so the listener it adds and
 * later removes is one identity. A bound argument prefix changes the callee's
 * arguments, and another receiver changes its `this`, so both stay open.
 */
const selfBindShapeOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, call: ts.CallExpression): SelfBindShape | null => {
  const argument = call.arguments[0]
  if (call.questionDotToken || call.arguments.length !== 1 || !argument || ts.isSpreadElement(argument)) return null
  const bind = call.expression
  if (!ts.isPropertyAccessExpression(bind) || bind.questionDotToken || !ts.isIdentifier(bind.name) || bind.name.text !== 'bind') return null
  const source = bind.expression
  if (!ts.isPropertyAccessExpression(source) || source.questionDotToken || !ts.isIdentifier(source.name)) return null
  let held: ts.Node = call
  while (ts.isParenthesizedExpression(held.parent)) held = held.parent
  const store = held.parent
  if (!ts.isBinaryExpression(store) || store.right !== held || store.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null
  const destination = store.left
  if (!ts.isPropertyAccessExpression(destination) || !ts.isIdentifier(destination.name)) return null
  // The same standard-library test `unwrapExplicitThisCall` makes of
  // `.call`/`.apply`: a program's own `bind` member is not this intrinsic.
  const method = checker.getSymbolAtLocation(bind.name)
  if (!method?.declarations?.length || !method.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  if (checker.getSignaturesOfType(checker.getTypeAtLocation(source), ts.SignatureKind.Call).length === 0) return null
  // One object and one key are one slot. The symbols cannot say so: the
  // JavaScript binder gives `this.m = ...` its own symbol beside the method's.
  if (destination.name.text !== source.name.text) return null
  const receivers = [destination.expression, source.expression, argument]
  if (!sameReceiver(flow, receivers[0]!, receivers[1]!) || !sameReceiver(flow, receivers[0]!, receivers[2]!)) return null
  return { store, destination, source, bind, key: destination.name.text, receivers }
}
export interface ProvenSelfBind extends SelfBindShape {
  /** The slot's canonical declaration, which `memberImplementationsOf` enumerates the family from. */
  readonly slot: ts.Declaration
}
/**
 * The self-bind fact every self-bind proof consumes: `x.m = x.m.bind(x)`
 * with the intrinsic `bind` intact and a store that runs no setter (the
 * descriptor authority's `writeBodies` over the receiver family `familyOf`
 * names). The slot then holds either one of its own implementations or one
 * bound to the slot's own object, so the store adds no body, binding calls
 * nothing, and the receiver reaches only the `this` of the slot's bodies. The
 * ledger obligation is owed by each consuming proof, which is why only the
 * syntactic half is cached.
 */
export const provenSelfBindWith = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  familyOf: (object: ts.Expression) => SourceClassFamilyQuery
): ProvenSelfBind | null => {
  let value = expression
  while (ts.isParenthesizedExpression(value)) value = value.expression
  if (!ts.isCallExpression(value)) return null
  const shape = selfBindShapeAt(checker, flow, value)
  if (shape === null) return null
  const method = checker.getSymbolAtLocation(shape.bind.name)
  if (!method || flow.writesToSymbol(method).length > 0) return null
  if (deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys('Function', { names: [shape.bind.name.text] }, value) !== true)
    return null
  const symbol = checker.getSymbolAtLocation(shape.source.name)
  const slot = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  if (slot === undefined) return null
  const plan = sourceClassKeyReadPlanOf(checker, flow, familyOf(shape.destination.expression), shape.key)
  return plan !== null && plan.writeBodies !== null && plan.writeBodies.length === 0 ? { ...shape, slot } : null
}
const selfBindShapes = new WeakMap<ValueFlowIndex, Map<ts.CallExpression, SelfBindShape | null>>()
const selfBindShapeAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, call: ts.CallExpression): SelfBindShape | null => {
  let shapes = selfBindShapes.get(flow)
  if (!shapes) selfBindShapes.set(flow, (shapes = new Map()))
  let shape = shapes.get(call)
  if (shape === undefined) shapes.set(call, (shape = selfBindShapeOf(checker, flow, call)))
  return shape
}
/**
 * Every key some write self-binds, by key alone: the JavaScript binder files
 * `this.m = ...` under its own declaration, so no member symbol lists them all.
 */
const selfBoundKeys = new WeakMap<ValueFlowIndex, ReadonlySet<string>>()
export const selfBoundKeysOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): ReadonlySet<string> => {
  let keys = selfBoundKeys.get(flow)
  if (keys) return keys
  const found = new Set<string>()
  for (const write of flow.allWrites) {
    let value = write.value
    while (value && ts.isParenthesizedExpression(value)) value = value.expression
    const shape = value && ts.isCallExpression(value) ? selfBindShapeAt(checker, flow, value) : null
    if (shape !== null) found.add(shape.key)
  }
  selfBoundKeys.set(flow, (keys = found))
  return keys
}
