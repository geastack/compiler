import ts from '#typescript'
import type { ValueFlowIndex } from './model.js'
import { sourceBindingValuesOf } from './value-provenance.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { unwrapErasedExpression } from '../producers/erasure.js'

/** A native annotation cannot create a host-owned value. Only an exact
 * installed root or closed transport of such roots supplies this provenance.
 */
export const sourceNativeOriginIsClosed = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  source: ts.Expression,
  installedRoot: (node: ts.Expression) => boolean
): boolean => {
  const session = sourceValueSessionOf(checker, flow)
  const pending = new Set<ts.Expression>()
  const visit = (input: ts.Expression): boolean => {
    const node = unwrapErasedExpression(input)
    if (pending.has(node)) return false
    pending.add(node)
    try {
      if (installedRoot(node)) return true
      const through = (values: readonly ts.Expression[] | null): boolean => values !== null && values.length > 0 && values.every(visit)
      if (ts.isIdentifier(node)) {
        const declaration = flow.targetOf(node)?.declaration
        if (declaration && ts.isVariableDeclaration(declaration)) return through(sourceBindingValuesOf(checker, flow, declaration))
        if (declaration && ts.isParameter(declaration)) return through(session.parameterSourceExpressionsOf(declaration))
      }
      if (ts.isConditionalExpression(node)) return visit(node.whenTrue) && visit(node.whenFalse)
      // Property reads can invoke getters; calls can manufacture annotated
      // values. Neither acquires native provenance from its checker result.
      return false
    } finally {
      pending.delete(node)
    }
  }
  return visit(source)
}
