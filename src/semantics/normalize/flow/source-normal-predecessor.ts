import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import type { SourceValueSession } from './source-value-session.js'
import { callableCompletionSummaryOf } from './callable-completions.js'
import { sourceInvocationFrameLayoutOf } from './source-invocation-frame-layout.js'

const scopeOf = (node: ts.Node): ts.SignatureDeclaration | ts.SourceFile | null => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) return null
    if (ts.isFunctionLike(current)) return current as ts.SignatureDeclaration
    if (ts.isSourceFile(current)) return current
  }
  return null
}

/** A try boundary may catch the abrupt completion, or run a finally that
 * resumes normal execution. Nested deferred bodies have a separate scope. */
const propagatesToScope = (node: ts.Node, scope: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node.parent; current && current !== scope; current = current.parent)
    if (ts.isTryStatement(current) || ts.isFunctionLike(current) || ts.isClassLike(current)) return false
  return true
}

/** Exclude an effect only when its execution necessarily aborts every closed
 * synchronous caller route before the queried boundary can complete normally.
 * This uses the same admitted caller/frame graph as value transport; neither
 * an asserted never type nor an unknown caller can supply an abrupt witness.
 * @semanticCategory generic-primitive
 */
export const sourceEffectCannotPrecedeNormalBoundaryOf = (
  flow: ValueFlowIndex,
  session: SourceValueSession,
  effect: ts.Node,
  boundary: ts.Node
): boolean => {
  const indexed = (node: ts.Node): boolean =>
    flow.calls.some((site) => site.call === node) || flow.allWrites.some((write) => write.site === node)
  if (!indexed(effect) || !indexed(boundary)) return false
  const origin = scopeOf(effect)
  const destination = scopeOf(boundary)
  if (origin === null || destination === null || ts.isSourceFile(origin) || !propagatesToScope(effect, origin)) return false
  const summary = callableCompletionSummaryOf(flow, origin)
  if (summary?.execution !== 'sync') return false
  let throws = !summary.mayCompleteUndefined && !summary.mayFallThrough && summary.values.length === 0
  for (let current: ts.Node | undefined = effect.parent; current && current !== origin; current = current.parent)
    if (ts.isThrowStatement(current)) throws = true
  if (!throws) return false

  const file = boundary.getSourceFile()
  const answers = new Map<ts.SignatureDeclaration, boolean>()
  const pending = new Set<ts.SignatureDeclaration>()
  const reachesFile = (scope: ts.SignatureDeclaration | ts.SourceFile): boolean => {
    if (ts.isSourceFile(scope)) return scope === file
    if (pending.has(scope)) return false
    const previous = answers.get(scope)
    if (previous !== undefined) return previous
    if (callableCompletionSummaryOf(flow, scope)?.execution !== 'sync') return false
    pending.add(scope)
    let answer = false
    try {
      const callers = session.callerSitesOf(scope)
      if (callers === null) return false
      for (const call of callers) {
        if (!ts.isCallExpression(call)) return false
        const targets = session.invocationTargetsOf(call)
        if (targets?.length !== 1 || targets[0] !== scope) return false
        const candidate = session.candidateOrdinaryOwnCallableOperandsOf(call)
        const admitted = session.ordinaryOwnCallableOperandsOf(call)
        if (candidate !== admitted || sourceInvocationFrameLayoutOf(flow, call, scope, admitted ?? undefined) === null) return false
        const caller = scopeOf(call)
        if (caller === null || !propagatesToScope(call, caller) || !reachesFile(caller)) return false
      }
      answer = true
      return true
    } finally {
      pending.delete(scope)
      answers.set(scope, answer)
    }
  }
  // The boundary cannot be scheduled through an opaque or deferred consumer
  // after somebody outside this source realm catches the failed execution.
  return reachesFile(destination) && reachesFile(origin)
}
