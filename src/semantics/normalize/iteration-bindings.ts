import ts from 'typescript'

/**
 * The block-scoped cells one iteration of a loop creates afresh, restricted to
 * those a nested function captures.
 *
 * ECMA-262 gives every iteration its own lexical environment: a `let`/`const`
 * in the body, the binding a `for`-`of`/`for`-`in` head declares, and -- through
 * `CreatePerIterationEnvironment` (14.7.4.4) -- the `let` cells of a `for`
 * head, copied from the previous iteration before the incrementor runs. A
 * closure created in one iteration therefore keeps that iteration's cell. The
 * distinction is invisible to anything but a closure, so only captured cells
 * are published: every other loop keeps exactly the storage it had.
 *
 * A reference counts as captured when it sits inside a function-like node,
 * static block or class field initializer nested within the loop, and names
 * the declaration's own checker symbol.
 */
export interface IterationBindings {
  /** The `for` head's captured `let` declarations -- the set `CreatePerIterationEnvironment` copies. */
  readonly copied: readonly ts.NamedDeclaration[]
  /**
   * Whether a closure in the `for` head's own initializer captures one of
   * `copied`. Only then is the copy made before the first test observable: it
   * leaves that closure the initializer's cell, which no iteration writes.
   */
  readonly copiedAtEntry: boolean
  /** Every captured block-scoped declaration one iteration creates, head and body alike, outside any nested loop. */
  readonly captured: readonly ts.NamedDeclaration[]
}

const isCaptureBoundary = (node: ts.Node): boolean =>
  ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isPropertyDeclaration(node)

const isIterationStatement = (node: ts.Node): boolean =>
  ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)

const isBlockScopedVariable = (node: ts.VariableDeclaration | ts.BindingElement): boolean =>
  (ts.getCombinedNodeFlags(node) & ts.NodeFlags.BlockScoped) !== 0

const referencedSymbol = (checker: ts.TypeChecker, identifier: ts.Identifier): ts.Symbol | undefined =>
  ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier)

export const iterationBindingsOf = (checker: ts.TypeChecker, loop: ts.IterationStatement): IterationBindings => {
  const declared: { readonly node: ts.NamedDeclaration; readonly symbol: ts.Symbol; readonly head: boolean }[] = []
  const capturedSymbols = new Set<ts.Symbol>()
  const capturedInHead = new Set<ts.Symbol>()
  const headList = ts.isForStatement(loop) && loop.initializer && ts.isVariableDeclarationList(loop.initializer) ? loop.initializer : null
  const copiesHead = headList !== null && (headList.flags & ts.NodeFlags.Let) !== 0

  const visit = (node: ts.Node, nested: boolean, innerLoop: boolean): void => {
    if (ts.isIdentifier(node)) {
      const symbol = nested ? referencedSymbol(checker, node) : undefined
      if (symbol) capturedSymbols.add(symbol)
      if (symbol && headList !== null && isWithinNode(node, headList)) capturedInHead.add(symbol)
      return
    }
    if (!nested && !innerLoop && (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      const symbol = isBlockScopedVariable(node) ? checker.getSymbolAtLocation(node.name) : undefined
      if (symbol) declared.push({ node, symbol, head: headList !== null && isWithinNode(node, headList) })
    }
    const nowNested = nested || isCaptureBoundary(node)
    const nowInner = innerLoop || (!nested && node !== loop && isIterationStatement(node))
    ts.forEachChild(node, (child) => visit(child, nowNested, nowInner))
  }
  visit(loop, false, false)

  const captured = declared.filter((entry) => capturedSymbols.has(entry.symbol))
  const copied = copiesHead ? captured.filter((entry) => entry.head) : []
  return {
    copied: copied.map((entry) => entry.node),
    copiedAtEntry: copied.some((entry) => capturedInHead.has(entry.symbol)),
    captured: captured.map((entry) => entry.node)
  }
}

const isWithinNode = (node: ts.Node, ancestor: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === ancestor) return true
  return false
}
