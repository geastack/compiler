import ts from 'typescript'

/**
 * How a declaration binds, as the language defines it.
 *
 * Two producers need this answer -- the one that introduces a binding and the
 * one that reads it -- and they must not compute it separately. A read that
 * disagreed with its own declaration about mutability or the temporal dead zone
 * would emit a program in which the same cell has two different lifetimes.
 */
export interface BindingKind {
  readonly mutable: boolean
  /** A read before initialization is a TDZ throw, which is observable behavior. */
  readonly temporalDeadZone: boolean
}

/**
 * `let`/`const` (`NodeFlags.Let`/`NodeFlags.Const`) live on the declaration
 * list, not the individual declaration; a bare `var` sets neither flag. A
 * parameter and a catch clause's binding are not part of any
 * `VariableDeclarationList` at all -- both are mutable and bound before their
 * body runs, so neither has a temporal dead zone to violate.
 *
 * A named function expression is the one binding whose kind comes from neither
 * a declaration list nor a default. `InstantiateOrdinaryFunctionExpression`
 * performs `funcEnv.CreateImmutableBinding(name, false)` and initializes it
 * with the closure before returning it, so the cell is immutable -- assigning
 * to the name is a TypeError in strict mode -- and has no dead zone, because
 * the only scope that can resolve it is the function's own body, which cannot
 * run until the cell already holds the function.
 */
export const bindingKindOf = (declaration: ts.Node): BindingKind => {
  if (ts.isFunctionExpression(declaration) && declaration.name) return { mutable: false, temporalDeadZone: false }
  const list = ts.isVariableDeclaration(declaration) ? declaration.parent : undefined
  if (!list || !ts.isVariableDeclarationList(list)) return { mutable: true, temporalDeadZone: false }
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0
  const isLet = (list.flags & ts.NodeFlags.Let) !== 0
  return { mutable: !isConst, temporalDeadZone: isConst || isLet }
}

/**
 * The declaration a binding element ultimately belongs to, for the kind lookup.
 *
 * An element of `const { a } = x` is not itself in a declaration list; its
 * mutability comes from the declaration the pattern names.
 */
export const bindingKindOfElement = (element: ts.BindingElement): BindingKind => {
  const owner = element.parent.parent
  return ts.isVariableDeclaration(owner) ? bindingKindOf(owner) : { mutable: true, temporalDeadZone: false }
}
