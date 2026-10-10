import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { localBindingValuesOf } from './value-provenance.js'
import { sourceCallableObjectOf, type SourceCallableObject } from './source-callable-own-data.js'
import { literalSourcePropertyKeyOf } from './source-property-key.js'
import { deferredIntrinsicProtocolLedgerOf } from '../deferred-intrinsic-protocols.js'
import { sourceDescriptorOwnProtocolOf } from './source-descriptor-protocol.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'

/** An exact installed descriptor supplies its original Function signatures;
 * the ambient PropertyDescriptor interface does not type those Functions.
 * @semanticCategory generic-primitive
 */
export interface SourceAccessorDescriptor {
  readonly definition: ts.CallExpression
  readonly getter: SourceCallableObject | null
  readonly setter: SourceCallableObject | null
}

const statementOf = (node: ts.Node): ts.Statement | null => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return null
    if (ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent))) return current
  }
  return null
}

const intrinsicObjectCall = (checker: ts.TypeChecker, call: ts.CallExpression, member: string): boolean => {
  const callee = unwrapErasedExpression(call.expression)
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Object' ||
    callee.name.text !== member
  )
    return false
  return [checker.getSymbolAtLocation(callee.expression), checker.getSymbolAtLocation(callee.name)].every(
    (symbol) => symbol?.declarations?.length && symbol.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  )
}

/** A bounded source receipt for the same exact-owner reflection that native
 * accessor publication certifies after lowering. Unknown aliases, mutation,
 * interprocedural ordering and inherited descriptor inputs are not evidence.
 */
export const sourceAccessorDescriptorOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  query: ts.CallExpression
): SourceAccessorDescriptor | null => {
  if (
    !intrinsicObjectCall(checker, query, 'getOwnPropertyDescriptor') ||
    query.arguments.length !== 2 ||
    query.arguments.some(ts.isSpreadElement)
  )
    return null
  const target = unwrapErasedExpression(query.arguments[0]!)
  const key = literalSourcePropertyKeyOf(query.arguments[1]!)
  if (!ts.isIdentifier(target) || key === null) return null
  const declaration = flow.targetOf(target)?.declaration
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  )
    return null
  const values = localBindingValuesOf(flow, declaration)
  if (!values || values.length !== 1 || values[0] !== declaration.initializer) return null
  const owner = unwrapErasedExpression(declaration.initializer)
  if (!ts.isObjectLiteralExpression(owner) || owner.properties.length !== 0) return null
  const after = statementOf(query)
  if (!after || (!ts.isBlock(after.parent) && !ts.isSourceFile(after.parent))) return null
  const index = after.parent.statements.indexOf(after)
  const before = after.parent.statements[index - 1]
  if (!before || !ts.isExpressionStatement(before)) return null
  const definition = unwrapErasedExpression(before.expression)
  if (
    !ts.isCallExpression(definition) ||
    !intrinsicObjectCall(checker, definition, 'defineProperty') ||
    definition.arguments.length !== 3 ||
    definition.arguments.some(ts.isSpreadElement)
  )
    return null
  const definedTarget = unwrapErasedExpression(definition.arguments[0]!)
  if (
    !ts.isIdentifier(definedTarget) ||
    flow.targetOf(definedTarget)?.declaration !== declaration ||
    literalSourcePropertyKeyOf(definition.arguments[1]!) !== key
  )
    return null
  // Every mention of the owner is accounted for by its binding and these two
  // exact intrinsic operands. A captured/aliased owner is not a fresh receipt.
  if (
    flow
      .referencesToDeclaration(declaration)
      .some((reference) => reference !== declaration.name && reference !== target && reference !== definedTarget)
  )
    return null
  if (outermostErasureOf(target).parent !== query || outermostErasureOf(definedTarget).parent !== definition) return null
  const descriptor = unwrapErasedExpression(definition.arguments[2]!)
  if (!ts.isObjectLiteralExpression(descriptor)) return null
  const fields = new Set<string>()
  let getter: SourceCallableObject | null = null
  let setter: SourceCallableObject | null = null
  for (const property of descriptor.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return null
    const name = ts.isComputedPropertyName(property.name) ? literalSourcePropertyKeyOf(property.name.expression) : property.name.text
    if (name === null || fields.has(name)) return null
    fields.add(name)
    const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
    if (name === 'get' || name === 'set') {
      const body = sourceCallableObjectOf(checker, flow, value)
      if (!body) return null
      if (name === 'get') getter = body
      else setter = body
    } else if (
      !['enumerable', 'configurable'].includes(name) ||
      ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrapErasedExpression(value).kind)
    )
      return null
  }
  if (getter === null && setter === null) return null
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (
    !ledger ||
    sourceDescriptorOwnProtocolOf(checker, flow, definition) === null ||
    !ledger.requireMember('Object', 'getOwnPropertyDescriptor', query)
  )
    return null
  return { definition, getter, setter }
}

/** A reflected accessor descriptor has exactly these four own fields, even
 * when one callable half is undefined. Only an immutable unexposed snapshot
 * may supply them to a later ToPropertyDescriptor operation.
 */
export const sourceAccessorDescriptorOwnNamesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  descriptor: ts.Expression,
  definition: ts.CallExpression
): readonly string[] | null => {
  const value = unwrapErasedExpression(descriptor)
  if (
    !ts.isIdentifier(value) ||
    !intrinsicObjectCall(checker, definition, 'defineProperty') ||
    definition.arguments.length !== 3 ||
    definition.arguments.some(ts.isSpreadElement) ||
    unwrapErasedExpression(definition.arguments[2]!) !== value
  )
    return null
  const declaration = flow.targetOf(value)?.declaration
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  )
    return null
  const values = localBindingValuesOf(flow, declaration)
  if (!values || values.length !== 1 || values[0] !== declaration.initializer) return null
  const query = unwrapErasedExpression(declaration.initializer)
  if (!ts.isCallExpression(query)) return null
  const before = statementOf(declaration)
  const after = statementOf(definition)
  if (
    !before ||
    !after ||
    !ts.isVariableStatement(before) ||
    before.parent !== after.parent ||
    (!ts.isBlock(before.parent) && !ts.isSourceFile(before.parent)) ||
    before.parent.statements.indexOf(before) >= before.parent.statements.indexOf(after)
  )
    return null
  // A global Script binding or a module export may be mutated by callers not
  // present in this closed reference inventory.
  if (ts.isSourceFile(before.parent)) {
    if (!ts.isExternalModule(before.parent)) return null
    const module = checker.getSymbolAtLocation(before.parent)
    const binding = checker.getSymbolAtLocation(declaration.name)
    if (
      !module ||
      !binding ||
      checker
        .getExportsOfModule(module)
        .some((entry) => ((entry.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(entry) : entry) === binding)
    )
      return null
  }
  const ownNames = ['get', 'set', 'enumerable', 'configurable'] as const
  const mutates = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    let current: ts.Node = outermostErasureOf(access)
    for (;;) {
      const parent = current.parent
      if (ts.isDeleteExpression(parent) && parent.expression === current) return true
      if (
        (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        parent.operand === current &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      )
        return true
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === current &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        return true
      if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current) return true
      // A direct member call gives the stored function this descriptor as its
      // receiver. Its body could then replace the descriptor's own fields.
      if (ts.isCallExpression(parent) && parent.expression === current) return true
      const nested =
        (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
        ((ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) && parent.expression === current) ||
        (ts.isObjectLiteralExpression(parent) && parent.properties.some((property) => property === current)) ||
        (ts.isArrayLiteralExpression(parent) && parent.elements.some((element) => element === current))
      if (!nested) return false
      current = outermostErasureOf(parent)
    }
  }
  for (const reference of flow.referencesToDeclaration(declaration)) {
    if (reference === declaration.name || reference === value) continue
    const receiver = outermostErasureOf(reference)
    const access = receiver.parent
    if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) || access.expression !== receiver) return null
    const key = ts.isPropertyAccessExpression(access) ? access.name.text : literalSourcePropertyKeyOf(access.argumentExpression)
    if (key === null || !ownNames.some((name) => name === key) || mutates(access)) return null
    // A future deferred body cannot borrow the current snapshot's source
    // execution order, even if it presently contains only a property read.
    const statement = statementOf(reference)
    if (statement === null || statement.parent !== before.parent) return null
  }
  return sourceAccessorDescriptorOf(checker, flow, query) === null ? null : ownNames
}
