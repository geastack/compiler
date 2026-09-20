import ts from 'typescript'

/**
 * An unreduced generic expression cannot supply a physical carrier. A
 * polymorphic receiver is different: the checker authenticates its class or
 * interface through the same symbol on the constraint. Follow that constraint
 * without instantiating anything; a generic receiver remains open when its
 * own type arguments are open. Ordinary `T extends Renderer` has T's distinct
 * symbol, so its constraint must not be mistaken for a concrete argument.
 */
export const isOpenTypeForm = (type: ts.Type, seen: Set<ts.Type> = new Set()): boolean => {
  if (seen.has(type)) return false
  seen.add(type)
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = type.getConstraint()
    const symbol = type.getSymbol()
    if (
      constraint &&
      symbol &&
      symbol === constraint.getSymbol() &&
      (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) !== 0
    )
      return isOpenTypeForm(constraint, seen)
    return true
  }
  const open = ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Index | ts.TypeFlags.Substitution
  if ((type.flags & open) !== 0) return true
  if (type.isUnionOrIntersection()) return type.types.some((member) => isOpenTypeForm(member, seen))
  const reference = type as ts.TypeReference
  const args = (type.flags & ts.TypeFlags.Object) !== 0 ? (reference.typeArguments ?? []) : []
  return args.some((argument) => isOpenTypeForm(argument, seen))
}
