import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { sourceInvocationFrameLayoutOf } from './source-invocation-frame-layout.js'

const scopeOf = (node: ts.Node): ts.SignatureDeclaration | ts.SourceFile | null => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) return null
    if (ts.isFunctionLike(current)) return current as ts.SignatureDeclaration
    if (ts.isSourceFile(current)) return current
  }
  return null
}

/** Project actual argument expressions from the admitted caller graph. An
 * input disappears only when every complete enclosing caller route is never
 * entered; an open consumer, cycle or unknown frame supplies no such proof.
 * @semanticCategory generic-primitive
 */
export const sourceExecutingParameterValuesOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  parameter: ts.ParameterDeclaration
): readonly ts.Expression[] | null => {
  const owner = parameter.parent
  if (!ts.isFunctionLike(owner)) return null
  const session = sourceValueSessionOf(checker, flow)
  const complete = session.parameterSourceExpressionsOf(parameter)
  const callers = session.callerSitesOf(owner as ts.SignatureDeclaration)
  if (complete === null || callers === null) return null
  const answers = new Map<ts.SignatureDeclaration, boolean | null>()
  const pending = new Set<ts.SignatureDeclaration>()
  const unentered = (scope: ts.SignatureDeclaration | ts.SourceFile | null): boolean | null => {
    if (scope === null) return null
    if (ts.isSourceFile(scope)) return false
    if (pending.has(scope)) return null
    if (answers.has(scope)) return answers.get(scope)!
    pending.add(scope)
    let answer: boolean | null = null
    try {
      const entries = session.callerSitesOf(scope)
      if (entries === null) return null
      for (const call of entries) {
        if (!ts.isCallExpression(call)) return null
        const targets = session.invocationTargetsOf(call)
        if (targets?.length !== 1 || targets[0] !== scope) return null
        const parent = unentered(scopeOf(call))
        if (parent === null) return null
        if (!parent) {
          answer = false
          return false
        }
      }
      answer = true
      return true
    } finally {
      pending.delete(scope)
      answers.set(scope, answer)
    }
  }
  const values = new Set<ts.Expression>()
  for (const call of callers) {
    if (!ts.isCallExpression(call)) return null
    const targets = session.invocationTargetsOf(call)
    if (targets?.length !== 1 || targets[0] !== owner) return null
    const omitted = unentered(scopeOf(call))
    if (omitted === null) return null
    if (omitted) continue
    const candidate = session.candidateOrdinaryOwnCallableOperandsOf(call)
    const admitted = session.ordinaryOwnCallableOperandsOf(call)
    if (candidate !== admitted) return null
    const frame = sourceInvocationFrameLayoutOf(flow, call, owner as ts.SignatureDeclaration, admitted ?? undefined)
    if (frame?.arguments.kind !== 'positional') return null
    const slot = frame.arguments.slots.find((one) => one.parameter === parameter)
    if (slot?.kind !== 'single' || slot.actual === null || slot.defaultValue !== null || !complete.includes(slot.actual)) return null
    values.add(slot.actual)
  }
  return [...values]
}
