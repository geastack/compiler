import type { OperationId, SemanticResultId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { resultOf, operandOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { FlowController } from './lower-flow.js'
import { IrLoweringBlockedError, requireRepresentation, type ScopeRef } from './lower-graph.js'
import { convertOrDrift, type LoweringContext } from './lower-operands.js'
import type { IrOperand } from './model.js'

/**
 * What `a?.b` evaluates to.
 *
 * The `[[Get]]` itself publishes the property, and it runs only where the
 * receiver was present -- that is the operator's whole meaning, and the graph
 * states it as a conditional edge on the receiver. What the *expression*
 * evaluates to is a second value: the property on one branch and `undefined`
 * on the other. The producer publishes it as the `short-circuit` result
 * (`producers/properties.ts`) precisely so the two never get confused, and this
 * is where it becomes a value.
 *
 * It cannot be built where the `[[Get]]` is lowered: that point is inside the
 * present arm, and a merge needs both arms closed. So the merge is recorded
 * there and settled here, at the first operation that has left the guard --
 * exactly the moment the flow controller closes the arms anyway.
 */
export interface PendingShortCircuit {
  readonly guard: SemanticResultId
  /** The access or call that short-circuits, for the drift row a merge arm the census cannot convert records. */
  readonly operation: OperationId
  readonly result: SemanticResultId
  readonly present: IrOperand
  readonly representation: Representation
}

/** The pending merge an optional chain's `[[Get]]` or `[[Call]]` leaves behind, or `null` when the operation short-circuits nothing. */
export const pendingShortCircuitOf = (
  ctx: LoweringContext,
  operation: SemanticOperation,
  present: IrOperand
): PendingShortCircuit | null => {
  const published = resultOf(operation, 'short-circuit')
  if (!published) return null
  // An access branches on its own receiver, and says so by having one. A call
  // branches on whichever expression carried the `?.` -- its callee for
  // `f?.()`, its receiver for `a?.b()` -- which is not a question this layer
  // re-derives: `producers/invocations.ts` states the answer as an operand, and
  // this reads it. Preferring the stated guard keeps `host.raf?.()` from
  // branching on `host` when what the language tests is `host.raf`.
  const guard = operandOf(operation, 'short-circuit-guard') ?? operandOf(operation, 'receiver')
  if (guard?.source.kind !== 'result') {
    throw new IrLoweringBlockedError('an optional chain short-circuits on a guard that produced no result to test')
  }
  return {
    guard: guard.source.result,
    operation: operation.id,
    result: published.id,
    present,
    representation: requireRepresentation(ctx.plan, published.id, 'an optional chain expression')
  }
}

/**
 * Settles every pending merge whose guard the given scope has left.
 *
 * A merge still inside its own guard is left alone: closing its arms while one
 * of them is open is not a thing the flow controller can do, and the operation
 * about to run is in that arm.
 */
export const settleShortCircuits = (
  ctx: LoweringContext,
  flow: FlowController,
  pending: Map<SemanticResultId, PendingShortCircuit>,
  scope: readonly ScopeRef[]
): void => {
  if (pending.size === 0) return
  const open = new Set(scope.filter((ref): ref is Extract<ScopeRef, { kind: 'guard' }> => ref.kind === 'guard').map((ref) => ref.guard))
  for (const [key, entry] of [...pending]) {
    if (open.has(entry.guard)) continue
    // Not settleable yet: this guard's own frame is still on the stack, further
    // out than whichever one just closed. `requireMergeSources` would refuse it
    // outright, so asking would turn "not my turn" into a blocked body.
    if (flow.isGuardOpen(entry.guard)) continue
    pending.delete(key)
    const sources = flow.requireMergeSources(entry.guard)
    // The property, in the carrier the expression publishes: `Optional<T>` has
    // a converting constructor from `T`, so this widening is a real store and
    // not a reinterpretation.
    const carried = convertOrDrift(
      ctx,
      sources.truthy,
      entry.result,
      entry.operation,
      'present',
      0,
      entry.present,
      entry.representation,
      'guard'
    )
    // The other branch is the operator's own answer, `undefined`, in that same
    // carrier -- written as the language's literal and converted, rather than
    // as an absent optional conjured directly, so the value the program sees
    // and the value this emits have one origin.
    const absent = ctx.builder.constant(sources.falsy, entry.result, 'undefined', 'undefined', { kind: 'undefined' })
    const converted = convertOrDrift(
      ctx,
      sources.falsy,
      entry.result,
      entry.operation,
      'absent',
      0,
      { value: absent, representation: { kind: 'undefined' } },
      entry.representation
    )
    ctx.values.set(
      entry.result,
      ctx.builder.phi(
        sources.join,
        entry.result,
        [
          { block: sources.truthy, value: carried },
          { block: sources.falsy, value: converted }
        ],
        entry.representation
      )
    )
  }
}
