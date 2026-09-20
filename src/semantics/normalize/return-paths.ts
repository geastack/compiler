import ts from 'typescript'

/**
 * Whether control can fall off the end of these statements without hitting a
 * `return`/`throw`.
 *
 * Deliberately conservative: only a `return`, a `throw`, a `Block` whose own
 * statements definitely exit, and an `if`/`else` where BOTH arms definitely
 * exit are recognised as definitely exiting. A `for`/`while`/`switch`/`try`
 * that might definitely exit is answered `false` -- not because it cannot,
 * but because proving it needs real control-flow analysis this module does
 * not build, and under-approximating here only ever REFUSES a function this
 * compiler could have resolved, never accepts one it should not have. See
 * `isUnusableEvidence`'s sibling reasoning: refusing is always the safe
 * default in this module.
 */
const definitelyExits = (node: ts.Statement): boolean => {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true
  if (ts.isBlock(node)) return definitelyReturns(node.statements)
  if (ts.isIfStatement(node))
    return node.elseStatement !== undefined && definitelyExits(node.thenStatement) && definitelyExits(node.elseStatement)
  return false
}

export const definitelyReturns = (statements: readonly ts.Statement[]): boolean => {
  const last = statements[statements.length - 1]
  return last !== undefined && definitelyExits(last)
}
