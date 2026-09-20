import type { OperationId, SemanticResultId } from '../../identity/ids.js'

/**
 * Edges between operations.
 *
 * Surface nesting is not a relation. If one operation must run before another,
 * or one operation's value reaches another, or one operation only runs when a
 * guard is taken, that must be an edge here. A consumer that recovers ordering
 * by walking the AST again has left the graph and rediscovered the frontend.
 */

/** `from` is evaluated before `to`, and the order is observable. */
export interface EvaluationEdge {
  readonly kind: 'evaluation'
  readonly from: OperationId
  readonly to: OperationId
}

/** The value `result` publishes is consumed by `to` in the named operand role. */
export interface ValueEdge {
  readonly kind: 'value'
  readonly result: SemanticResultId
  readonly to: OperationId
  readonly role: string
  readonly ordinal: number
}

/**
 * `to` observes mutable state that `from` may change, so they cannot be
 * reordered even though no value flows between them.
 */
export interface EffectEdge {
  readonly kind: 'effect'
  readonly from: OperationId
  readonly to: OperationId
}

/**
 * `to` executes only when `guard` takes the named branch.
 *
 * This is how `a && b`, `a?.b`, and `a ?? b` keep their short-circuiting as a
 * semantic fact. A producer-to-producer conditional edge names the guard's own
 * result; it never borrows an operand identity local to the consumer.
 */
export interface ConditionalEdge {
  readonly kind: 'conditional'
  readonly guard: SemanticResultId
  readonly to: OperationId
  readonly takenWhen: 'truthy' | 'falsy' | 'nullish' | 'present'
}

/** An abrupt completion in `from` transfers control to `to`. */
export interface CompletionEdge {
  readonly kind: 'completion'
  readonly from: OperationId
  readonly to: OperationId
  readonly completion: 'throw' | 'return' | 'break' | 'continue' | 'suspend'
}

/**
 * `to` executes inside one iteration of `loop`.
 *
 * A loop's condition and its body are both inside the iteration; what separates
 * them is the condition's own `ConditionalEdge`. Stating iteration membership
 * separately is what lets the lowering put the condition in a block the body can
 * jump back to, which a guard alone cannot express.
 */
export interface LoopEdge {
  readonly kind: 'loop'
  readonly loop: OperationId
  readonly to: OperationId
}

/**
 * `to` is the `for` loop's own incrementor, evaluated in a block distinct
 * from the header.
 *
 * ECMA-262's `ForStatement` evaluation re-enters at the update expression on
 * `continue`, not at the condition -- so the incrementor cannot simply be
 * "inside the iteration" the way the body is; it needs a scope of its own
 * that `continue` can jump to and that falls through to the header once it
 * runs. A `while`, or a `for` with no update clause, mints no operation for
 * this edge to name, so it never appears for either.
 */
export interface LoopLatchEdge {
  readonly kind: 'loop-latch'
  readonly loop: OperationId
  readonly to: OperationId
}

/**
 * `to` executes inside one named part (`try`, `catch`, or `finally`) of the
 * `region` try statement.
 *
 * This mirrors `LoopEdge`: a try statement's own operation is not enough to
 * give its sub-blocks scope membership, because "try", "catch", and "finally"
 * are three mutually exclusive scopes that share no boolean guard. Publishing
 * membership as an edge (rather than recovering it positionally from source
 * ranges) is what lets the flow controller treat a try-region exactly like a
 * guard or loop: an ordinary `ScopeRef` with its own open/close semantics.
 */
export interface RegionEdge {
  readonly kind: 'region'
  readonly region: OperationId
  readonly part: 'try' | 'catch' | 'finally'
  readonly to: OperationId
}

export type SemanticEdge =
  EvaluationEdge | ValueEdge | EffectEdge | ConditionalEdge | CompletionEdge | LoopEdge | LoopLatchEdge | RegionEdge

/** The operation an edge originates from, for connectivity traversal. */
export const edgeSource = (edge: SemanticEdge, operationOfResult: (result: SemanticResultId) => OperationId): OperationId => {
  switch (edge.kind) {
    case 'evaluation':
    case 'effect':
    case 'completion':
      return edge.from
    case 'value':
      return operationOfResult(edge.result)
    case 'conditional':
      return operationOfResult(edge.guard)
    case 'loop':
    case 'loop-latch':
      return edge.loop
    case 'region':
      return edge.region
  }
}

/** The operation an edge terminates at. */
export const edgeTarget = (edge: SemanticEdge): OperationId => edge.to
