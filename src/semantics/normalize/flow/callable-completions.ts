import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { definitelyReturns } from '../return-paths.js'

export type CallableExecution = 'sync' | 'async' | 'generator' | 'async-generator'

/** The source-level completion inventory, before a consumer applies its policy. */
export interface CallableCompletionSummary {
  /** Whether a plain call returns directly, or instead returns a Promise/iterator wrapper. */
  readonly execution: CallableExecution
  /** Explicit `return expr` values, retained even when another path returns undefined. */
  readonly values: readonly ts.Expression[]
  /** Explicit `yield expr` values, separate from a generator's return completion. */
  readonly yields: readonly ts.Expression[]
  /** A bare return or a possible fallthrough contributes an implicit undefined completion. */
  readonly mayCompleteUndefined: boolean
  /** Conservative block-body result from the existing return-path summary. */
  readonly mayFallThrough: boolean
}

const summaries = new WeakMap<ValueFlowIndex, WeakMap<ts.Node, CallableCompletionSummary | null>>()

const callableBodyOf = (target: ts.SignatureDeclaration | ts.JSDocSignature): ts.Block | ts.Expression | undefined =>
  ts.isFunctionLike(target) && 'body' in target ? target.body : undefined

/**
 * The callable's syntactic completion inventory, or null when it has no
 * executable source body. Return and yield expressions come from the shared
 * value-flow write inventory; only the existing conservative fallthrough
 * summary is consulted here.
 */
export const callableCompletionSummaryOf = (
  flow: ValueFlowIndex,
  target: ts.SignatureDeclaration | ts.JSDocSignature
): CallableCompletionSummary | null => {
  let byTarget = summaries.get(flow)
  if (!byTarget) summaries.set(flow, (byTarget = new WeakMap()))
  if (byTarget.has(target)) return byTarget.get(target) ?? null

  // The shared write/receiver inventory only describes the portions of the
  // source tree that the reachability pass admitted. A body pruned there can
  // still exist on the TypeScript node, but its empty or partial write set is
  // not a complete completion summary.
  if (!flow.callableBodyIsIndexed(target)) {
    byTarget.set(target, null)
    return null
  }

  const body = callableBodyOf(target)
  if (!body) {
    byTarget.set(target, null)
    return null
  }

  const modifiers = ts.canHaveModifiers(target) ? ts.getModifiers(target) : undefined
  const async = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false
  const generator = 'asteriskToken' in target && target.asteriskToken !== undefined
  const execution: CallableExecution = async ? (generator ? 'async-generator' : 'async') : generator ? 'generator' : 'sync'

  const writes = flow.writesToDeclaration(target)
  const returnWrites = writes.filter((write) => write.edge === 'return')
  const values = ts.isBlock(body)
    ? returnWrites.flatMap((write) => (write.value ? [unwrapErasedExpression(write.value)] : []))
    : [unwrapErasedExpression(body)]
  const yields = writes.flatMap((write) => (write.edge === 'yield' && write.value ? [unwrapErasedExpression(write.value)] : []))
  const hasBareReturn = returnWrites.some((write) => write.value === null)
  const mayFallThrough = ts.isBlock(body) && !definitelyReturns(body.statements)

  const summary = {
    execution,
    values,
    yields,
    mayCompleteUndefined: hasBareReturn || mayFallThrough,
    mayFallThrough
  }
  byTarget.set(target, summary)
  return summary
}

/**
 * Direct values from a synchronous call, or null when it may complete with
 * undefined, has no named value completion, or returns a Promise/iterator.
 * Construction applies the separate fresh-this policy below.
 */
export const callableCompletionValuesOf = (
  flow: ValueFlowIndex,
  target: ts.SignatureDeclaration | ts.JSDocSignature
): readonly ts.Expression[] | null => {
  const summary = callableCompletionSummaryOf(flow, target)
  return summary && summary.execution === 'sync' && !summary.mayCompleteUndefined && summary.values.length > 0 ? summary.values : null
}

/**
 * Whether `new target( ... )` yields exactly one of `target`'s completion
 * values, and nothing else.
 *
 * `new` allocates `this` first and discards it only when the function
 * returns an object. A completion that is not one -- `return null`,
 * `return 1`, a bare `return`, falling off the end -- yields the fresh
 * `this` instead, an allocation no origin plan enumerates. So every
 * completion must be syntactically object-producing: an object literal, or
 * another construction (which `new` always makes an object and whose own
 * origin is proven the same way). And `this` must not be mentioned at all: a
 * constructor writing `this.x` is building a second object beside the one it
 * returns. Three's `new WebGLRenderLists()` returns one literal and never
 * mentions `this`.
 */
export const constructionYieldsCompletionOf = (flow: ValueFlowIndex, target: ts.FunctionDeclaration): boolean => {
  if (flow.receiverReferencesToDeclaration(target).length > 0) return false
  const values = callableCompletionValuesOf(flow, target)
  return values !== null && values.every((value) => ts.isObjectLiteralExpression(value) || ts.isNewExpression(value))
}
