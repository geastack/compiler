import type { OperationId, SemanticResultId } from '../../identity/ids.js'
import type { SemanticOperation } from './operations.js'

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

/**
 * One scope an operation sits inside, as `normalize/gating.ts` states it: the
 * edge it stands for, minus the `to` every operation in that scope shares.
 */
export type GateLink =
  | { readonly kind: 'guard'; readonly guard: SemanticResultId; readonly takenWhen: ConditionalEdge['takenWhen'] }
  | { readonly kind: 'loop'; readonly loop: OperationId }
  | { readonly kind: 'loop-latch'; readonly loop: OperationId }
  | { readonly kind: 'region'; readonly region: OperationId; readonly part: RegionEdge['part'] }

/**
 * Every gated operation with its chain of scopes, outermost first, in the order
 * the gating walk reached them. A chain is shared by every operation the walk
 * found under the same nesting and must never change once recorded.
 */
export interface GatedOperations {
  readonly operations: readonly OperationId[]
  readonly chains: readonly (readonly GateLink[])[]
}

/**
 * One scope of a sealed chain: its link, and the chain of scopes enclosing it.
 * Chains that share a prefix share its scopes, so a `switch` whose every clause
 * adds one more failed test to the chain costs one scope per clause rather
 * than one copy of the whole chain per clause.
 */
export interface GateScope {
  readonly link: GateLink
  readonly enclosing: GateScope | null
  readonly depth: number
}

/** Each gated operation with the innermost scope of its chain, in recording order. */
export interface SealedGates {
  readonly operations: readonly OperationId[]
  readonly innermost: readonly GateScope[]
}

/**
 * A function sealing one chain into shared scopes. Prefixes are recognised by
 * the identity of their links, which the gating walk reuses for every chain it
 * extends from the same nesting.
 */
export const gateScopeSealer = (): ((chain: readonly GateLink[]) => GateScope | null) => {
  const root = new Map<GateLink, GateScope>()
  const children = new Map<GateScope, Map<GateLink, GateScope>>()
  const enter = (enclosing: GateScope | null, link: GateLink): GateScope => {
    let next = enclosing === null ? root : children.get(enclosing)
    if (next === undefined) {
      next = new Map()
      children.set(enclosing!, next)
    }
    let scope = next.get(link)
    if (scope === undefined) {
      scope = { link, enclosing, depth: enclosing === null ? 1 : enclosing.depth + 1 }
      next.set(link, scope)
    }
    return scope
  }
  return (chain) => chain.reduce<GateScope | null>(enter, null)
}

/**
 * The sealed graph's edge table, as every consumer reads it: a sequence with a
 * length. A plain array is one; `SemanticEdgeTable` is the sealed graph's own.
 */
export interface SemanticEdges extends Iterable<SemanticEdge> {
  readonly length: number
  find(predicate: (edge: SemanticEdge) => boolean): SemanticEdge | undefined
}

const gateEdge = (gate: GateLink, to: OperationId): SemanticEdge => {
  switch (gate.kind) {
    case 'loop':
      return { kind: 'loop', loop: gate.loop, to }
    case 'loop-latch':
      return { kind: 'loop-latch', loop: gate.loop, to }
    case 'region':
      return { kind: 'region', region: gate.region, part: gate.part, to }
    case 'guard':
      return { kind: 'conditional', guard: gate.guard, to, takenWhen: gate.takenWhen }
  }
}

/**
 * A run of the producers' edges standing for one operation's value edges: one
 * per operand citing a result, in operand order -- what `valueEdgesInto`
 * states for an operation, and most of what the producers state at all.
 */
export type StatedEdge = SemanticEdge | SemanticOperation

const valueEdge = (operand: SemanticOperation['operands'][number], to: OperationId): SemanticEdge | null =>
  operand.source.kind === 'result'
    ? { kind: 'value', result: operand.source.result, to, role: operand.role, ordinal: operand.ordinal }
    : null

/** The edges one stated entry stands for: itself, or an operation's value edges in operand order. */
export function* edgesStatedBy(entry: StatedEdge): Generator<SemanticEdge> {
  if (!('family' in entry)) {
    yield entry
    return
  }
  for (const operand of entry.operands) {
    const edge = valueEdge(operand, entry.id)
    if (edge !== null) yield edge
  }
}

/**
 * The edge table of a sealed graph: the producers' own edges, then one edge per
 * scope of every gated operation's chain.
 *
 * The gating walk states a scope once per OPERATION inside it, so an operation
 * nested three scopes deep owns three edges that differ from its siblings' only
 * in `to`. Materialized, that was most of the table -- 820k conditional edges
 * for a 48K-line app, 50 MB that lived from normalization to certification.
 * Here each gated operation holds its innermost scope -- chains share their
 * enclosing scopes -- and the gate edges are minted as a consumer walks past
 * them. A producer's value edges are the operation's own result-citing
 * operands restated, so a run of them that restates exactly that is held as
 * the operation. Either way a consumer sees the same edges, with the same
 * fields in the same order, in the same sequence as the flat table had; one
 * that keeps an edge keeps an ordinary object.
 */
export class SemanticEdgeTable implements SemanticEdges {
  readonly length: number
  private readonly byKind = new Map<SemanticEdge['kind'], readonly SemanticEdge[]>()

  constructor(
    private readonly stated: readonly StatedEdge[],
    private readonly gated: SealedGates
  ) {
    let length = 0
    for (const entry of stated) {
      if (!('family' in entry)) length++
      else for (const operand of entry.operands) if (operand.source.kind === 'result') length++
    }
    for (const scope of gated.innermost) length += scope.depth
    this.length = length
  }

  *[Symbol.iterator](): Iterator<SemanticEdge> {
    yield* this.statedEdges()
    const { operations, innermost } = this.gated
    const chain: GateScope[] = []
    for (let index = 0; index < operations.length; index++) {
      const to = operations[index]!
      let scope: GateScope | null = innermost[index]!
      chain.length = scope.depth
      for (let depth = scope.depth - 1; scope !== null; depth--, scope = scope.enclosing) chain[depth] = scope
      for (const outer of chain) yield gateEdge(outer.link, to)
    }
  }

  find(predicate: (edge: SemanticEdge) => boolean): SemanticEdge | undefined {
    for (const edge of this) if (predicate(edge)) return edge
    return undefined
  }

  /** The producers' own edges of one kind no value run or gate stands for, in table order. */
  edgesOfKind<K extends PlainStatedKind>(kind: K): readonly Extract<SemanticEdge, { readonly kind: K }>[] {
    let found = this.byKind.get(kind)
    if (found === undefined) {
      found = this.stated.filter((entry): entry is SemanticEdge => !('family' in entry) && entry.kind === kind)
      this.byKind.set(kind, found)
    }
    return found as readonly Extract<SemanticEdge, { readonly kind: K }>[]
  }

  /** The producers' own edges: the table's head, in table order. */
  *statedEdges(): Generator<SemanticEdge> {
    for (const entry of this.stated) {
      if (!('family' in entry)) yield entry
      else
        for (const operand of entry.operands) {
          const edge = valueEdge(operand, entry.id)
          if (edge !== null) yield edge
        }
    }
  }
}

/**
 * The producers' own edges, in table order, without walking past the gate
 * edges. The gating walk never states an `evaluation`, `value`, `effect` or
 * `completion` edge, so a scan for one of those kinds sees exactly what a scan
 * of the whole table would -- without minting every gate edge, most of a large
 * program's table, only to look at it and throw it away.
 */
export const producerEdges = (edges: SemanticEdges): Iterable<SemanticEdge> =>
  edges instanceof SemanticEdgeTable ? edges.statedEdges() : edges

/** Kinds only a producer states and no value run stands for. */
type PlainStatedKind = 'evaluation' | 'effect' | 'completion'

/**
 * Every edge of one such kind, in table order. A sealed table answers from an
 * index it builds on first use -- a list of the edges it already holds -- so a
 * lookup per `break` or per destructured element no longer walks the table.
 */
export const edgesOfKind = <K extends PlainStatedKind>(
  edges: SemanticEdges,
  kind: K
): Iterable<Extract<SemanticEdge, { readonly kind: K }>> =>
  edges instanceof SemanticEdgeTable
    ? edges.edgesOfKind(kind)
    : [...edges].filter((edge): edge is Extract<SemanticEdge, { readonly kind: K }> => edge.kind === kind)

/**
 * The producers' edges with every run that restates an operation's value
 * edges -- each result-citing operand in order, nothing else -- replaced by
 * that operation, appended to `stated`. Anything that differs in the
 * slightest stays an edge.
 */
export const compactStatedEdges = (
  edges: readonly StatedEdge[],
  operationOf: (operation: OperationId) => SemanticOperation | undefined,
  stated: StatedEdge[] = []
): StatedEdge[] => {
  let index = 0
  while (index < edges.length) {
    const edge = edges[index]!
    if ('family' in edge) {
      stated.push(edge)
      index++
      continue
    }
    const operation = edge.kind === 'value' ? operationOf(edge.to) : undefined
    let run = 0
    if (operation !== undefined) {
      for (const operand of operation.operands) {
        if (operand.source.kind !== 'result') continue
        const candidate = edges[index + run]
        if (
          candidate === undefined ||
          'family' in candidate ||
          candidate.kind !== 'value' ||
          candidate.to !== operation.id ||
          candidate.result !== operand.source.result ||
          candidate.role !== operand.role ||
          candidate.ordinal !== operand.ordinal
        ) {
          run = 0
          break
        }
        run++
      }
    }
    if (run > 0) {
      stated.push(operation!)
      index += run
    } else {
      stated.push(edge)
      index++
    }
  }
  return stated
}
