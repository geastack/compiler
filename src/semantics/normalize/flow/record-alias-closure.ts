import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { constructionYieldsCompletionOf } from './callable-completions.js'
import { inProgramImportReferencesOf } from './export-importers.js'
import { isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias, returnOwnerOf } from './targets.js'

/**
 * Whether every alias of a record allocation is one this module can follow
 * to a use that cannot replace any of its slots.
 *
 * A method call on a record is a call of whatever its slot holds WHEN the call
 * runs. The record's literal names the callable it was created with; the
 * question here is whether anything can put a different one there afterwards.
 * The proof follows the literal forward -- through a factory's `return` to
 * every call site of that factory (across modules, via
 * `inProgramImportReferencesOf`), into `const`/`let` cells, through
 * parentheses, conditionals and logical operators -- and admits only uses
 * that read a slot, call a slot whose callable never reads `this`, or compare
 * the record. Anything else is an alias this module cannot follow: an
 * argument, a member store (`_this.renderLists = renderLists`), a spread, a
 * coercion, a write of any slot. Those refuse here, and are left to a
 * caller's stronger whole-program proof (`SourceRecordOriginAuthority.
 * recordSlotClosed`).
 *
 * A getter, setter or spread in the literal refuses: each runs code with the
 * record as `this`, or copies slots in from somewhere unenumerated.
 */

type SlotCallable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

/** The static key an object-literal entry is published under, or null when it has none. */
export const objectLiteralEntryKeyOf = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  if (!ts.isComputedPropertyName(name)) return null
  const inner = unwrapErasedExpression(name.expression)
  return ts.isStringLiteralLike(inner) || ts.isNumericLiteral(inner) ? inner.text : null
}

/** A function declaration whose binding is reassigned names different functions over time. */
const bindingWritten = (flow: ValueFlowIndex, declaration: ts.Declaration): boolean =>
  flow
    .writesToDeclaration(declaration)
    .some(
      (write) =>
        write.slot === 'whole' &&
        (write.edge === 'identifier-assignment' || write.edge === 'compound-assignment' || write.edge === 'logical-assignment')
    )

/** Whether `node` (already at its outermost erasure) is written rather than read. */
const isWriteTarget = (node: ts.Node): boolean => {
  const parent = node.parent
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true
  if (ts.isDeleteExpression(parent)) return true
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return true
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return true
  // A destructuring assignment pattern: `[ r.get ] = xs`, `({ a: r.get } = o)`.
  let pattern: ts.Node = node
  for (;;) {
    const container: ts.Node = pattern.parent
    if (
      ts.isArrayLiteralExpression(container) ||
      ts.isObjectLiteralExpression(container) ||
      ts.isSpreadElement(container) ||
      ts.isSpreadAssignment(container) ||
      ts.isParenthesizedExpression(container) ||
      ts.isShorthandPropertyAssignment(container) ||
      (ts.isPropertyAssignment(container) && container.initializer === pattern)
    ) {
      pattern = container
      continue
    }
    break
  }
  if (pattern === node) return false
  const holder = pattern.parent
  return (
    (ts.isBinaryExpression(holder) && holder.left === pattern && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    ((ts.isForOfStatement(holder) || ts.isForInStatement(holder)) && holder.initializer === pattern)
  )
}

const isNullish = (expression: ts.Expression): boolean => {
  const value = unwrapErasedExpression(expression)
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined')
}

/**
 * `slots`: nothing can replace a slot. `receiver`: nothing but this literal's
 * own allocations can be `this` in a function it holds.
 */
type AliasProof = 'slots' | 'receiver'

const proofs: Record<AliasProof, WeakMap<ValueFlowIndex, Map<ts.ObjectLiteralExpression, boolean>>> = {
  slots: new WeakMap(),
  receiver: new WeakMap()
}

const memoized = (checker: ts.TypeChecker, flow: ValueFlowIndex, root: ts.ObjectLiteralExpression, proof: AliasProof): boolean => {
  let memo = proofs[proof].get(flow)
  if (!memo) proofs[proof].set(flow, (memo = new Map()))
  const held = memo.get(root)
  if (held !== undefined) return held
  const answer = proveAliasesClosed(checker, flow, root, proof)
  memo.set(root, answer)
  return answer
}

export const recordAllocationAliasesClosed = (checker: ts.TypeChecker, flow: ValueFlowIndex, root: ts.ObjectLiteralExpression): boolean =>
  memoized(checker, flow, root, 'slots')

/**
 * Whether `this`, in a function this literal was written holding, can only
 * ever be one of the literal's own allocations.
 *
 * A function written in place in a literal is reachable only through the
 * literal's slot. If no alias of the literal hands that slot's function out as
 * a value, and every alias reaches only uses this proof enumerates, then every
 * call of the function is `alias.key( ... )`, and its receiver is the literal.
 * Three's `ColorManagement` is such a record: `convert` reads `this.enabled`,
 * and the checker names the literal's `enabled: true` for it -- a name a second
 * literal with a getter under that key would satisfy just as well, which is why
 * the checker's answer alone is not evidence.
 *
 * The walk is the slot proof's, with three differences. A store into a data
 * slot is admitted: it keeps the slot data and hands the record to no one. A
 * call of a slot whose function reads `this` follows that function's every
 * `this` as one more alias, where the slot proof refused it. And an exported
 * cell is followed into every importer (`inProgramImportReferencesOf`). A read
 * of a `this`-reading function as a value still refuses: that is the function
 * leaving the record.
 */
export const recordLiteralReceiverClosed = (checker: ts.TypeChecker, flow: ValueFlowIndex, root: ts.ObjectLiteralExpression): boolean =>
  memoized(checker, flow, root, 'receiver')

const proveAliasesClosed = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  root: ts.ObjectLiteralExpression,
  proof: AliasProof
): boolean => {
  const receiver = proof === 'receiver'
  const slots = new Map<string, SlotCallable | null>()
  const callableOf = (property: ts.ObjectLiteralElementLike): SlotCallable | null => {
    if (ts.isMethodDeclaration(property)) return property
    const value = ts.isPropertyAssignment(property) ? unwrapErasedExpression(property.initializer) : null
    if (value && (ts.isFunctionExpression(value) || ts.isArrowFunction(value))) return value
    const symbol = ts.isShorthandPropertyAssignment(property)
      ? checker.getShorthandAssignmentValueSymbol(property)
      : value && ts.isIdentifier(value)
        ? checker.getSymbolAtLocation(value)
        : undefined
    const declaration = resolveFlowSymbolAlias(checker, symbol)?.valueDeclaration
    return declaration && ts.isFunctionDeclaration(declaration) && !bindingWritten(flow, declaration) ? declaration : null
  }
  for (const property of root.properties) {
    if (ts.isSpreadAssignment(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) return false
    const key = objectLiteralEntryKeyOf(property.name)
    if (key === null) return false
    if (key === '__proto__') {
      // Only a null prototype is closed; any other prototype supplies inherited slots.
      if (!ts.isPropertyAssignment(property) || !isNullish(property.initializer)) return false
      continue
    }
    slots.set(key, callableOf(property))
  }

  const seen = new Set<ts.Node>()

  const readsReceiver = (callable: SlotCallable): boolean =>
    !ts.isArrowFunction(callable) && flow.receiverReferencesToDeclaration(callable).length > 0

  /** An assignment or increment of a slot -- not a `delete`, and not a destructuring or loop target. */
  const dataStore = (positioned: ts.Node): boolean => {
    const parent = positioned.parent
    return (
      (ts.isBinaryExpression(parent) && parent.left === positioned) ||
      ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)
    )
  }

  /** A named slot of an alias: a read is inert; a call runs the slot's callable with the record as `this`. */
  const member = (access: ts.Expression, key: string | null): boolean => {
    if (key === null || !slots.has(key)) return false
    const positioned = outermostErasureOf(access)
    const callable = slots.get(key) ?? null
    if (isWriteTarget(positioned)) return receiver && callable === null && dataStore(positioned)
    const parent = positioned.parent
    const called =
      (ts.isCallExpression(parent) && parent.expression === positioned) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === positioned)
    if (!called) return !receiver || callable === null || !readsReceiver(callable)
    if (callable === null) return false
    if (!readsReceiver(callable)) return true
    return receiver && flow.receiverReferencesToDeclaration(callable).every(value)
  }

  /** A cell holding the record: every mention of it must be followed. */
  const cell = (declaration: ts.VariableDeclaration | ts.ParameterDeclaration): boolean => {
    if (seen.has(declaration)) return true
    seen.add(declaration)
    if (!ts.isIdentifier(declaration.name)) return false
    const exported =
      ts.isVariableDeclaration(declaration) &&
      isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)
    if (exported && !receiver) return false
    const references = new Set<ts.Expression>(flow.referencesToDeclaration(declaration))
    if (exported) {
      const imported = inProgramImportReferencesOf(checker, flow, declaration)
      if (imported === null) return false
      for (const reference of imported) references.add(reference)
    }
    for (const reference of references) {
      if (reference === declaration.name) continue
      if (ts.isIdentifier(reference) && (isTypePositionReference(reference) || ts.isTypeQueryNode(reference.parent))) continue
      // The binding itself, not a use of its value: every importer's mention
      // is already among the references above.
      if (
        exported &&
        (ts.isImportSpecifier(reference.parent) || ts.isImportClause(reference.parent) || ts.isExportSpecifier(reference.parent))
      )
        continue
      if (ts.isExportSpecifier(reference.parent) || ts.isShorthandPropertyAssignment(reference.parent)) return false
      const positioned = outermostErasureOf(reference)
      const parent = positioned.parent
      // Overwritten: the cell now holds the assigned value, not this record.
      if (ts.isBinaryExpression(parent) && parent.left === positioned && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) continue
      if (isWriteTarget(positioned) || !value(reference)) return false
    }
    return true
  }

  const assigned = (target: ts.Expression): boolean => {
    const named = unwrapErasedExpression(target)
    if (!ts.isIdentifier(named)) return false
    const declaration = flow.targetOf(named)?.declaration
    return !!declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && cell(declaration)
  }

  /** Every call of a factory whose `return` carries the record yields it. */
  const callers = (factory: ts.FunctionDeclaration): boolean => {
    if (seen.has(factory)) return true
    seen.add(factory)
    if (!factory.name || factory.asteriskToken || factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
      return false
    const references = new Set<ts.Expression>(flow.referencesToDeclaration(factory))
    if (isModuleExportedDeclaration(checker, factory, checker.getSymbolAtLocation(factory.name) ?? null)) {
      const imported = inProgramImportReferencesOf(checker, flow, factory)
      if (imported === null) return false
      for (const reference of imported) references.add(reference)
    }
    for (const reference of references) {
      if (reference === factory.name) continue
      const parent = reference.parent
      if (ts.isIdentifier(reference) && (isTypePositionReference(reference) || ts.isTypeQueryNode(parent))) continue
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent))
        continue
      if (ts.isExportAssignment(parent) && !parent.isExportEquals) continue
      // `ns.factory` is indexed under both the access and its name.
      const site = ts.isPropertyAccessExpression(parent) && parent.name === reference ? parent : reference
      const positioned = outermostErasureOf(site)
      const call = positioned.parent
      if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === positioned) {
        // Under `new`, a non-object completion yields `this` instead.
        if (ts.isNewExpression(call) && !constructionYieldsCompletionOf(flow, factory)) return false
        if (!value(call)) return false
        continue
      }
      return false
    }
    return true
  }

  const value = (expression: ts.Expression): boolean => {
    if (seen.has(expression)) return true
    seen.add(expression)
    const parent = expression.parent
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    )
      return value(parent)
    if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) return member(parent, parent.name.text)
    if (ts.isElementAccessExpression(parent) && parent.expression === expression) {
      const argument = unwrapErasedExpression(parent.argumentExpression)
      return member(parent, ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : null)
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) return true
      // Loose equality with anything but null/undefined runs ToPrimitive on the record.
      if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken)
        return isNullish(parent.left === expression ? parent.right : parent.left)
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      )
        return value(parent)
      if (operator === ts.SyntaxKind.CommaToken) return parent.left === expression || value(parent)
      if (operator === ts.SyntaxKind.EqualsToken && parent.right === expression)
        return assigned(parent.left) && (ts.isExpressionStatement(parent.parent) || value(parent))
      return false
    }
    if (ts.isConditionalExpression(parent)) return parent.condition === expression || value(parent)
    if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken
    if (ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return true
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === expression)
      return true
    if (ts.isVariableDeclaration(parent) && parent.initializer === expression) return cell(parent)
    if (ts.isReturnStatement(parent)) {
      const owner = returnOwnerOf(parent)
      return !!owner && ts.isFunctionDeclaration(owner) && callers(owner)
    }
    return false
  }

  return value(root)
}
