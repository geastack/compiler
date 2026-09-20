import ts from 'typescript'

export type BagAbsence = 'null' | 'undefined'

/** Absence belongs to a binding, not to the bag object it may later hold.
 * Follow the same storage aliases as bag inference, preserving initial and
 * assigned nullish values across returned aliases. This deliberately retains
 * absence when the checker cannot prove a read excludes it.
 */
export const createBagAbsenceResolver = (
  checker: ts.TypeChecker,
  ownerOf: (expression: ts.Expression) => ts.Node | null,
  calleeOf: (expression: ts.Expression) => ts.Node | null,
  writesTo: ReadonlyMap<ts.Node, readonly ts.Expression[]>,
  returnsOf: ReadonlyMap<ts.Node, readonly (ts.Expression | null)[]>
): ((node: ts.Node) => readonly BagAbsence[]) => {
  const visit = (node: ts.Node, seen: ReadonlySet<ts.Node>): readonly BagAbsence[] => {
    if (seen.has(node)) return []
    const next = new Set(seen).add(node)
    const join = (nodes: readonly (ts.Node | null)[]): readonly BagAbsence[] => [
      ...new Set(nodes.flatMap((value) => (value ? visit(value, next) : ['undefined' as const])))
    ]
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      return join([node.initializer ?? null, ...(writesTo.get(node) ?? [])])
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))
      return visit(node.expression, next)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeOf(node.expression)
      return callee ? join(returnsOf.get(callee) ?? []) : []
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
      return join(returnsOf.get(node) ?? [])
    const type = checker.getTypeAtLocation(node)
    const arms = type.isUnion() ? type.types : [type]
    const explicit = arms.flatMap((arm): BagAbsence[] =>
      (arm.flags & ts.TypeFlags.Null) !== 0 ? ['null'] : (arm.flags & ts.TypeFlags.Undefined) !== 0 ? ['undefined'] : []
    )
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const owner = ownerOf(node)
      if (owner) {
        const inferred = visit(owner, next)
        // A checker flow narrowing can exclude absence; an erased type cannot.
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return inferred.filter((absence) => explicit.includes(absence))
        return [...new Set([...explicit, ...inferred])]
      }
    }
    return explicit
  }
  return (node) => visit(node, new Set())
}
