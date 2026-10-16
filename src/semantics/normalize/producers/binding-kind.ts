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
  if (ts.isClassDeclaration(declaration) || (ts.isClassExpression(declaration) && declaration.name))
    return { mutable: ts.isClassDeclaration(declaration), temporalDeadZone: true }
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

/**
 * Whether a `let`/`const` declaration's scope is a block nested inside its
 * execution context rather than that context's own top level.
 *
 * `var` is never block scoped. A declaration list that is a loop head
 * (`for (let i ...)`, `for (const x of xs)`) is scoped to the loop; one in a
 * statement list is scoped to that list's block unless the list IS the
 * context's own body -- the source file, a namespace body, a function body, or
 * a class static block.
 */
export const isBlockScopedDeclaration = (declaration: ts.VariableDeclaration | ts.BindingElement): boolean => {
  let owner: ts.Node = declaration
  while (ts.isBindingElement(owner) || ts.isObjectBindingPattern(owner) || ts.isArrayBindingPattern(owner)) owner = owner.parent
  if (!ts.isVariableDeclaration(owner)) return false
  const list = owner.parent
  if (!ts.isVariableDeclarationList(list) || (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return false
  const statement = list.parent
  if (ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement)) return true
  if (!ts.isVariableStatement(statement)) return false
  const container = statement.parent
  if (ts.isSourceFile(container) || ts.isModuleBlock(container)) return false
  if (ts.isBlock(container) && (ts.isFunctionLike(container.parent) || ts.isClassStaticBlockDeclaration(container.parent))) return false
  return true
}
