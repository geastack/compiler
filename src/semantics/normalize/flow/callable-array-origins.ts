import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { isVacuousOrigin, seededOriginSolver } from './seeded-origins.js'
import { isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias, unwrapNaming } from './targets.js'

type CallableBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

const original = (expression: ts.Expression): ts.Expression => {
  let held = unwrapNaming(expression)
  while (ts.isAsExpression(held) || ts.isTypeAssertionExpression(held) || ts.isSatisfiesExpression(held))
    held = unwrapNaming(held.expression)
  return held
}

const appends = new WeakMap<ValueFlowIndex, ReadonlyMap<ts.Node, ReadonlySet<ts.Expression>>>()
const appendValuesAt = (flow: ValueFlowIndex, site: ts.Node): ReadonlySet<ts.Expression> | undefined => {
  let inventory = appends.get(flow)
  if (!inventory) {
    const collected = new Map<ts.Node, Set<ts.Expression>>()
    for (const write of flow.allWrites) {
      if (write.edge !== 'array-append' || !write.value) continue
      let values = collected.get(write.site)
      if (!values) collected.set(write.site, (values = new Set()))
      values.add(write.value)
    }
    inventory = collected
    appends.set(flow, inventory)
  }
  return inventory.get(site)
}

/** @semanticCategory generic-primitive */
export interface ClosedCallableAuthority {
  /** Complete callable contents of an authenticated array element. */
  readonly arrayElementTargetsOf?: (element: ts.ElementAccessExpression) => readonly CallableBody[] | null
  /** Identity and mutation proof for an explicit Function.call/apply invocation. */
  readonly explicitInvocationIsIntact?: (call: ts.CallExpression) => boolean
  /** Complete inbound frame, including defaults and writes; partial callers are not evidence. */
  readonly parameterValuesOf: (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null
  /** Complete receiver frame; null when a call can enter with an unaccounted receiver. */
  readonly receiverValuesOf?: (callable: ts.SignatureDeclaration) => readonly ts.Expression[] | null
  /**
   * The complete call-site set of a callable, or null when it is not closed.
   * Only an EMPTY closed set makes a parameter with no inbound values vacuous;
   * without this authority such a parameter refuses.
   */
  readonly closedCallerSitesOf?: (callable: ts.SignatureDeclaration) => readonly unknown[] | null
}

/** @semanticCategory generic-primitive */
export interface CallableArrayOriginAuthority extends ClosedCallableAuthority {
  /** All values stored in the authenticated collection read by this call. */
  readonly collectionValuesOf: (call: ts.CallExpression) => readonly ts.Expression[] | null
  /** All reads of an authenticated collection receiving this array value. */
  readonly collectionReadsOf: (call: ts.CallExpression, value: ts.Expression) => readonly ts.Expression[] | null
  /** Intrinsic Array protocol and prototype integrity, authenticated outside this traversal. */
  readonly arrayProtocolClosed: (array: ts.Expression) => boolean
}

/**
 * Every function body a callee expression can denote, resolved through the
 * cells, parameters and operators that carry it. Vacuous origins (`null`,
 * `undefined`) name no body and refuse nothing.
 *
 * The shape this exists for is three's `WebGLRenderList.sort`:
 * `opaque.sort( customOpaqueSort || painterSortStable )`, reached from
 * `currentRenderList.sort( _opaqueSort, ... )` where the renderer's `let
 * _opaqueSort = null` is written only by `this.setOpaqueSort = function (
 * method ) { _opaqueSort = method }`. With `setOpaqueSort`'s caller set closed
 * and empty, `method` holds nothing, `_opaqueSort` holds only `null`, and the
 * comparator is exactly `painterSortStable`.
 */
const closedCallableResolver = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  authority: ClosedCallableAuthority,
  targets: Set<CallableBody>
): ((expression: ts.Expression) => boolean) => {
  const origins = seededOriginSolver<ts.Expression>((value) => {
    if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
      targets.add(value)
      return { seed: true, admitted: true, dependencies: [] }
    }
    if (isVacuousOrigin(flow, value)) return { seed: false, admitted: true, dependencies: [] }
    if (ts.isElementAccessExpression(value)) {
      const incoming = authority.arrayElementTargetsOf?.(value)
      for (const target of incoming ?? []) targets.add(target)
      return { seed: (incoming?.length ?? 0) > 0, admitted: incoming !== null && incoming !== undefined, dependencies: [] }
    }
    let values: readonly ts.Expression[] | null = null
    if (ts.isConditionalExpression(value)) values = [value.whenTrue, value.whenFalse]
    else if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    )
      values = [value.left, value.right]
    else if (ts.isIdentifier(value)) {
      const shorthand = ts.isShorthandPropertyAssignment(value.parent) && value.parent.name === value
      const symbol = shorthand
        ? checker.getShorthandAssignmentValueSymbol(value.parent as ts.ShorthandPropertyAssignment)
        : checker.getSymbolAtLocation(value)
      const alias =
        symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? resolveFlowSymbolAlias(checker, symbol)?.valueDeclaration : undefined
      const owner = alias ?? (shorthand ? symbol?.valueDeclaration : flow.targetOf(value)?.declaration)
      if (owner && ts.isParameter(owner)) {
        values = authority.parameterValuesOf(owner)
        // No observed argument is not proof that this frame is unreachable.
        if (values?.length === 0 && !(ts.isFunctionLike(owner.parent) && authority.closedCallerSitesOf?.(owner.parent)?.length === 0))
          values = null
      } else if (owner && (ts.isFunctionDeclaration(owner) || ts.isVariableDeclaration(owner))) {
        const writes = flow
          .writesToDeclaration(owner)
          .filter((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
        if (ts.isFunctionDeclaration(owner)) {
          if (owner.body && writes.length === 0) {
            targets.add(owner)
            return { seed: true, admitted: true, dependencies: [] }
          }
        } else if (
          writes.length > 0 &&
          writes.every(
            (write) => (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') && write.value !== null
          )
        )
          values = writes.map((write) => write.value!)
      }
    }
    return { seed: false, admitted: values !== null, dependencies: (values ?? []).map(original) }
  })
  return (expression) => origins(original(expression)) !== 'refused'
}

/**
 * The complete set of source function bodies `expression` can denote, or
 * null when it is not closed. Empty means the expression only ever holds
 * `null`/`undefined`. See `closedCallableResolver` for the three.js shape.
 */
export const closedCallableTargetsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression,
  authority: ClosedCallableAuthority
): readonly CallableBody[] | null => {
  const targets = new Set<CallableBody>()
  return closedCallableResolver(checker, flow, authority, targets)(expression) ? [...targets] : null
}

/** Complete source callable values reaching a numeric array callee. Local
 * storage origins and uses come from the shared flow inventory. Collection,
 * parameter-frame and intrinsic-protocol authorities remain explicit: their
 * checker signatures alone cannot establish a closed runtime value set.
 */
export const callableArrayTargetsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  callee: ts.ElementAccessExpression,
  authority: CallableArrayOriginAuthority
): readonly CallableBody[] | null => {
  const targets = new Set<CallableBody>()
  const arrays = new Set<ts.Expression>()
  const cells = new Set<ts.VariableDeclaration>()
  const uses = new Set<ts.Expression>()
  let allocated = false
  const numeric = (expression: ts.Expression): boolean => {
    const check = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(check) : (type.flags & ts.TypeFlags.NumberLike) !== 0)
    return check(checker.getTypeAtLocation(expression))
  }
  const callable = closedCallableResolver(
    checker,
    flow,
    {
      ...authority,
      arrayElementTargetsOf: (element) => (numeric(element.argumentExpression) && array(element.expression) ? [...targets] : null)
    },
    targets
  )
  const callableCells = new Set<ts.VariableDeclaration>()
  const callableUses = new Set<ts.Expression>()
  const callableCell = (declaration: ts.VariableDeclaration): boolean => {
    if (callableCells.has(declaration)) return true
    if (isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)) return false
    callableCells.add(declaration)
    const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    return (
      writes.length > 0 &&
      writes.every(
        (write) =>
          (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') &&
          write.value !== null &&
          callable(write.value)
      ) &&
      flow.referencesToDeclaration(declaration).every(callableUse)
    )
  }
  // Reading a callable into a local cell does not change its identity. Close
  // every write and continuation of that cell just as for the array itself.
  const callableUse = (reference: ts.Expression): boolean => {
    if (callableUses.has(reference)) return true
    callableUses.add(reference)
    if (isTypePositionReference(reference)) return true
    const parent = reference.parent
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    )
      return callableUse(parent)
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name === reference || (parent.initializer === reference && callableCell(parent))
    if (ts.isCallExpression(parent) && parent.expression === reference) return true
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === reference &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    )
      return authority.explicitInvocationIsIntact?.(parent.parent) === true
    if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (parent.left === reference) return ts.isExpressionStatement(parent.parent)
        if (parent.right === reference && ts.isIdentifier(parent.left)) {
          const owner = flow.targetOf(parent.left)?.declaration
          return !!owner && ts.isVariableDeclaration(owner) && callableCell(owner) && ts.isExpressionStatement(parent.parent)
        }
      }
      if (
        parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      )
        return true
    }
    return ts.isTypeOfExpression(parent) || (ts.isExpressionStatement(parent) && parent.expression === reference)
  }
  const cell = (declaration: ts.VariableDeclaration): boolean => {
    if (cells.has(declaration)) return true
    if (isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)) return false
    cells.add(declaration)
    const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
    return (
      writes.length > 0 &&
      writes.every(
        (write) =>
          (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') && write.value !== null && array(write.value)
      ) &&
      flow.referencesToDeclaration(declaration).every(use)
    )
  }
  // Solve allocation provenance by components, separately from coinductive
  // use closure. A map read and the cell stored into that map can form a
  // seeded cycle. Every outgoing component still needs a complete origin;
  // an unallocated cycle cannot borrow a different conditional's literal.
  const origin = seededOriginSolver<ts.Expression>((value) => {
    if (ts.isArrayLiteralExpression(value)) return { seed: true, admitted: true, dependencies: [] }
    let values: readonly ts.Expression[] | null = null
    if (ts.isConditionalExpression(value)) values = [value.whenTrue, value.whenFalse]
    else if (ts.isIdentifier(value)) {
      const declaration = flow.targetOf(value)?.declaration
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
        if (
          writes.length > 0 &&
          writes.every(
            (write) => (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') && write.value !== null
          )
        )
          values = writes.map((write) => write.value!)
      }
    } else if (ts.isCallExpression(value)) {
      if (ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === 'slice') values = [value.expression.expression]
      else values = authority.collectionValuesOf(value)
    }
    // No vacuous leaves exist here: an admitted non-seed always has an
    // origin, so `allocated` is exactly the former valid-and-allocated rule.
    return { seed: false, admitted: values !== null && values.length > 0, dependencies: (values ?? []).map(original) }
  })
  const origins = (expression: ts.Expression): boolean => origin(original(expression)) === 'allocated'
  const array = (expression: ts.Expression): boolean => {
    if (!origins(expression)) return false
    const value = original(expression)
    if (arrays.has(value)) return true
    arrays.add(value)
    if (ts.isArrayLiteralExpression(value)) {
      if (!authority.arrayProtocolClosed(value)) return false
      allocated = true
      return (
        value.elements.every((element) => ts.isOmittedExpression(element) || (!ts.isSpreadElement(element) && callable(element))) &&
        use(value)
      )
    }
    if (ts.isConditionalExpression(value)) return array(value.whenTrue) && array(value.whenFalse)
    if (ts.isIdentifier(value)) {
      const owner = flow.targetOf(value)?.declaration
      return owner !== null && owner !== undefined && ts.isVariableDeclaration(owner) && cell(owner)
    }
    if (!ts.isCallExpression(value)) return false
    const method = value.expression
    if (ts.isPropertyAccessExpression(method) && method.name.text === 'slice') {
      return (
        value.arguments.length <= 2 &&
        value.arguments.every(numeric) &&
        authority.arrayProtocolClosed(method.expression) &&
        array(method.expression) &&
        use(value)
      )
    }
    const incoming = authority.collectionValuesOf(value)
    return incoming !== null && incoming.length > 0 && incoming.every(array) && use(value)
  }
  const use = (reference: ts.Expression): boolean => {
    if (uses.has(reference)) return true
    uses.add(reference)
    const parent = reference.parent
    if (isTypePositionReference(reference)) return true
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    )
      return use(parent)
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name === reference || (parent.initializer === reference && cell(parent))
    }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (parent.left === reference) return ts.isExpressionStatement(parent.parent)
      if (parent.right === reference && ts.isIdentifier(parent.left)) {
        const owner = flow.targetOf(parent.left)?.declaration
        return (
          owner !== null && owner !== undefined && ts.isVariableDeclaration(owner) && cell(owner) && ts.isExpressionStatement(parent.parent)
        )
      }
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
      if (!numeric(parent.argumentExpression) || !authority.arrayProtocolClosed(reference)) return false
      const context = parent.parent
      if (ts.isCallExpression(context) && context.expression === parent) return true
      if (ts.isDeleteExpression(context)) return true
      if (ts.isBinaryExpression(context) && context.left === parent && context.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return callable(context.right)
      return callableUse(parent)
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      if (!authority.arrayProtocolClosed(reference)) return false
      const context = parent.parent
      if (parent.name.text === 'length') {
        if (ts.isBinaryExpression(context) && context.left === parent)
          return context.operatorToken.kind === ts.SyntaxKind.EqualsToken && numeric(context.right)
        return true
      }
      if (!ts.isCallExpression(context) || context.expression !== parent || context.arguments.some(ts.isSpreadElement)) return false
      if (parent.name.text === 'slice') return array(context)
      if (parent.name.text === 'push' || parent.name.text === 'unshift') {
        return context.arguments.every((argument) => appendValuesAt(flow, context)?.has(argument) === true && callable(argument))
      }
      if (parent.name.text === 'indexOf' || parent.name.text === 'includes')
        return context.arguments.length <= 2 && (context.arguments.length < 2 || numeric(context.arguments[1]!))
      if (parent.name.text === 'splice')
        return context.arguments.length <= 2 && context.arguments.every(numeric) && ts.isExpressionStatement(context.parent)
      return false
    }
    if (ts.isCallExpression(parent)) {
      const reads = authority.collectionReadsOf(parent, reference)
      return reads !== null && reads.every((read) => array(read))
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    )
      return true
    return ts.isTypeOfExpression(parent) || (ts.isExpressionStatement(parent) && parent.expression === reference)
  }
  return numeric(callee.argumentExpression) && array(callee.expression) && allocated && targets.size > 0 ? [...targets] : null
}
