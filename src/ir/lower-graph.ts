import type { FunctionId, OperationId, RegionId, ResultRole, SemanticResultId } from '../identity/ids.js'
import { operationOfResult } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticEdge } from '../semantics/model/edges.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticCaller } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'

/**
 * Shared owner-grouping, ordering, and lookup primitives for IR lowering.
 *
 * `lowerToIr` must abort one owner without harming another, so every failure
 * here is thrown as `IrLoweringBlockedError` and caught once, at the single
 * per-owner boundary in `lower.ts`. That keeps every helper a plain function
 * that either returns an answer or fails closed -- never a `Result` type
 * threaded through a dozen call sites, and never a silent partial answer.
 */

/** Thrown to abort lowering of exactly one owner. The message states the missing capability, never a source site. */
export class IrLoweringBlockedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'IrLoweringBlockedError'
  }
}

export type OwnerId = FunctionId | RegionId

export const callerOwner = (caller: SemanticCaller): OwnerId => (caller.kind === 'function' ? caller.functionId : caller.regionId)

/** Every operation, bucketed by the owner that executes it. One bucket becomes one `IrBody`. */
export const groupOperationsByOwner = (graph: SemanticGraph): ReadonlyMap<OwnerId, readonly OperationId[]> => {
  const groups = new Map<OwnerId, OperationId[]>()
  for (const [id, operation] of graph.operations) {
    const owner = callerOwner(operation.caller)
    const bucket = groups.get(owner)
    if (bucket) bucket.push(id)
    else groups.set(owner, [id])
  }
  return groups
}

/**
 * The result role an IR operation's `lineage` cites for a semantic operation
 * with several published results.
 *
 * `value` is preferred because it is what a consumer most often needs to
 * resolve; the rest follow `resultRoles` order as a deterministic fallback so
 * two lowerings of the same operation always pick the same anchor.
 */
const anchorRolePriority: readonly ResultRole[] = ['value', 'completion', 'reference', 'iterator-record', 'short-circuit']

/**
 * The published result an operation's own IR lowering cites as `lineage`.
 *
 * `null` when the operation published no result at all. That is a real gap
 * between the semantic model (a step may publish nothing) and the IR model
 * (`IrOperationBase.lineage` is mandatory): lowering cannot invent a
 * `SemanticResultId` the operation never published without becoming a second,
 * competing authority over what that operation's identity is, so the caller
 * must fail closed instead.
 */
export const anchorResultOf = (operation: SemanticOperation): SemanticResultId | null => {
  for (const role of anchorRolePriority) {
    const found = operation.results.find((result) => result.role === role)
    if (found) return found.id
  }
  return operation.results[0]?.id ?? null
}

/** The one authoritative carrier for a published result, or a thrown blocker naming why it cannot materialize. */
export const requireRepresentation = (plan: SealedRepresentationPlan, result: SemanticResultId, describe: string): Representation => {
  const representation = plan.selected.get(result)
  if (!representation) throw new IrLoweringBlockedError(`${describe} has no carrier selected in the sealed representation plan`)
  if (representation.kind === 'unresolved') {
    throw new IrLoweringBlockedError(`${describe} selected an unresolved carrier: ${representation.reason}`)
  }
  return representation
}

/**
 * A deterministic execution order for one owner's operations.
 *
 * Precedence comes only from graph facts: an operand that consumes another
 * operation's result must run after it, `EvaluationEdge`/`EffectEdge` state an
 * explicit "before" relation, and a `ConditionalEdge` orders a guard before
 * whatever it gates (the branch itself is built later; only cycle-free
 * sequencing is decided here). Source order never enters this computation.
 *
 * Among operations the graph leaves mutually unordered, conditional membership
 * decides which runs next: an order is only executable if one branch's
 * operations are *contiguous*. Blocks are how a branch exists, and a block that
 * has been left cannot be appended to -- so an order that runs an arm, then
 * something outside the guard, then that same arm again describes control flow
 * no basic-block graph can express. That is not hypothetical: the module body
 * of `sky-hop-jsx`'s `Controls.tsx` computes one `?:` while a dozen unrelated
 * import bindings sit at the same evaluation ordinal, and ordering by ordinal
 * alone interleaved them -- the arm was re-entered after it had jumped to its
 * join, the lowering opened an unreachable block to hold the rest of the arm,
 * and the owner was rejected for sealing a block reached from nothing.
 *
 * Contiguity is a preference over the *ready* set, never an override of
 * precedence: the operation whose scope chain shares the longest prefix with
 * the one just emitted wins, and `evaluationOrdinal` still breaks every
 * remaining tie. Nothing that is not yet legal to run becomes legal.
 *
 * A cycle means the graph asked for two operations to each run before the
 * other, which is a producer defect -- not something an emitter may resolve
 * by picking one direction, so it is reported as a blocker instead.
 */
/**
 * Every `region` edge's target, grouped by the region part it belongs to.
 *
 * Built from the WHOLE edge table and shared by every owner, deliberately, and
 * this is the one table here that may NOT be split per owner. The opener below
 * is `members.find(... family === 'boundary')` -- the FIRST boundary operation
 * in the group, across the entire program. Handing an owner only its own share
 * of the group can hand it a different first element than the whole group has,
 * and `addPrecedence` would then add a real ordering edge where the whole-group
 * answer added none (the whole-group opener belongs to another owner, so the
 * precedence was silently dropped). That is a change to emitted order, not an
 * optimization, so the grouping stays global and only the *scan* is hoisted out
 * of the per-owner loop.
 */
export type RegionPartMembers = ReadonlyMap<string, readonly OperationId[]>

export const collectRegionParts = (graph: SemanticGraph): RegionPartMembers => {
  const regionParts = new Map<string, OperationId[]>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'region') continue
    const key = `${edge.region}|${edge.part}`
    const bucket = regionParts.get(key)
    if (bucket) bucket.push(edge.to)
    else regionParts.set(key, [edge.to])
  }
  return regionParts
}

/** What `orderOwnerOperations` answers: the owner's execution order, plus which of its own operations belong to `FunctionDeclarationInstantiation`'s own phase -- parameter reads, defaulted-parameter binding, and pattern extraction over a parameter -- see `parameterPrologue` below. */
export interface OrderedOwnerOperations {
  readonly order: readonly OperationId[]
  /**
   * Every operation this owner's own formals need bound before the body may
   * run: each parameter's own `binding:initialize` (`parameterInitialization
   * === true`, set for EVERY parameter whether or not it defaults or
   * destructures) and everything that operation transitively depends on --
   * a default's guard and both its arms, a pattern's own extraction steps.
   *
   * Named after ECMA-262's own phase (10.2.1 step 8's
   * `FunctionDeclarationInstantiation`, before `EvaluateGeneratorBody` ever
   * runs) because that is exactly what this set is: the work a generator's
   * `[[Call]]` must finish before `GeneratorStart` ever suspends it, which
   * `ir/lower.ts`'s generator split reads to decide where a coroutine's
   * OUTER (ordinary) half ends and its INNER (suspending) half begins.
   *
   * Computed here rather than published as its own capability because the
   * ordering pass already builds every fact it needs -- `parameterRoots` and
   * the `predecessors` graph -- to keep hoisted declarations behind it; a
   * second walk elsewhere would be a second authority re-deriving the exact
   * same predecessor closure.
   */
  readonly parameterPrologue: ReadonlySet<OperationId>
}

export const orderOwnerOperations = (
  graph: SemanticGraph,
  operations: readonly OperationId[],
  membership: ConditionalMembership,
  /**
   * The edges whose target this owner holds, in `graph.edges` order.
   *
   * Every use of the edge table below is a filter that keeps only edges landing
   * inside `operations` -- `addPrecedence` refuses any pair with an endpoint
   * outside `members` -- so passing the owner's own share is the same answer as
   * passing the whole table, reached without walking owners x edges to get it.
   * Order is preserved because the share is dealt in table order.
   */
  ownerEdges: readonly SemanticEdge[],
  /** The whole program's region-part groups; see `collectRegionParts` for why this one is not split. */
  regionParts: RegionPartMembers
): OrderedOwnerOperations => {
  const members = new Set(operations)
  const indegree = new Map<OperationId, number>()
  const successors = new Map<OperationId, Set<OperationId>>()
  const predecessors = new Map<OperationId, Set<OperationId>>()
  for (const id of operations) {
    indegree.set(id, 0)
    successors.set(id, new Set())
    predecessors.set(id, new Set())
  }

  const addPrecedence = (before: OperationId, after: OperationId): void => {
    if (before === after || !members.has(before) || !members.has(after)) return
    const bucket = successors.get(before)
    if (!bucket || bucket.has(after)) return
    bucket.add(after)
    predecessors.get(after)?.add(before)
    indegree.set(after, (indegree.get(after) ?? 0) + 1)
  }

  for (const id of operations) {
    const operation = graph.operations.get(id)
    if (!operation) continue
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result') continue
      addPrecedence(operationOfResult(operand.source.result), id)
    }
  }
  for (const edge of ownerEdges) {
    if (edge.kind === 'evaluation' || edge.kind === 'effect') addPrecedence(edge.from, edge.to)
    else if (edge.kind === 'conditional') addPrecedence(operationOfResult(edge.guard), edge.to)
    // A region's own opening operation (`contributeTry`'s `TryStatement`
    // marker) is not a value the try/catch/finally body's operations consume
    // -- it publishes nothing any operand cites -- so without this it has no
    // precedence forcing it before the body it logically precedes, and
    // census's post-order `evaluationOrdinal` ("children first, then this
    // node") places it *after* instead. Left unordered, `orderOwnerOperations`
    // schedules the whole region body first (contiguity keeps it together and
    // its operations are otherwise ready), then reaches this marker with the
    // scope already closed and the block already terminated -- exactly the
    // same shape a guard's own boolean test avoids via the `'conditional'`
    // case just above, and the identical fix: a real precedence edge, not an
    // ordinal that happens to work out.
    else if (edge.kind === 'region') addPrecedence(edge.region, edge.to)
  }

  // A `'catch'` part's own `boundary` operation (`producers/boundary.ts`) --
  // and, when the clause binds a name, the `binding` operation chained off
  // it -- materializes the value entering that specific part, the same role
  // `edge.region` plays for the region as a whole. Nothing else in the group
  // consumes it as an operand (a bindingless catch's boundary publishes no
  // result at all; a bound catch's sibling statements read the *binding*, not
  // the boundary, and only through an ordinary reference, not this list), so
  // without an explicit precedence here it is subject to the identical
  // post-order-ordinal defect `edge.region` needed fixing for above: census
  // orders it after its own part's body, and a body that returns on every
  // path schedules it into an already-closed scope.
  // How many region parts each operation is a member of, so the loop below can
  // tell a group's OWN opener from a boundary that merely sits inside it.
  const partsContaining = new Map<OperationId, number>()
  for (const members of regionParts.values()) {
    for (const member of members) partsContaining.set(member, (partsContaining.get(member) ?? 0) + 1)
  }
  for (const [key, members] of regionParts) {
    // Only a `catch` part is entered through a boundary. A `try` part is
    // entered by falling into it and has no opening operation at all -- and
    // asking for one anyway is what made a NESTED try/catch unlowerable: the
    // gating pass gives an inner catch clause both its own gate and every gate
    // enclosing it, so the inner catch's boundary is a legitimate member of the
    // OUTER try's part, and taking the first boundary found there forced it
    // ahead of the operations that must run before it. The result was a real
    // cycle -- "the evaluation graph for this owner contains a cycle" -- for
    // any `try { try {} catch {} } catch {}`. The key's last segment is the
    // part; see `collectRegionParts` directly above for the format.
    if (!key.endsWith('|catch')) continue
    // The same nesting one level in: a try/catch written INSIDE this catch
    // contributes its own boundary to this group too. The one that opens this
    // group is the one that is in no deeper part -- it belongs to this group
    // plus whatever encloses it, while any nested boundary belongs to all of
    // those and at least one more.
    let opener: OperationId | null = null
    for (const id of members) {
      if (graph.operations.get(id)?.family !== 'boundary') continue
      if (opener === null || (partsContaining.get(id) ?? 0) < (partsContaining.get(opener) ?? 0)) opener = id
    }
    if (opener === null) continue
    // The clause's own parameter binding, when it binds a name. The paragraph
    // above says this operation is part of the prologue; it used to leave it
    // out, and the boundary alone is not enough. `catch (caught)` publishes
    // TWO operations -- the boundary that materializes the caught value, and
    // the `binding:initialize` that writes it into `caught`'s cell -- and the
    // handler's own statements read that CELL, through an ordinary
    // `binding:read` whose only operand is a reference. A read cites the
    // reference, never the write, so nothing ordered the write before it, and
    // the census's post-order ordinal ("children first, then this node") puts
    // the CatchClause's own operations after the body it contains. The write
    // was therefore scheduled after the handler's `return`, landing in the
    // region's join block: the handler read an uninitialized cell, and the
    // write itself was emitted outside the `catch` scope where the C++ catch
    // parameter it copies from does not exist. Both halves of that were
    // clang-visible in `test/fixtures/try-catch-bound.ts` ("use of undeclared
    // identifier", plus the bare `return;` the stray block left behind in a
    // `std::string` function) -- and a `typeof` of the caught value certified
    // clean while reading the cell before anything wrote it.
    //
    // Matched by the operand role rather than by family so this stays the same
    // fact the value edge already states: the binding is the operation that
    // takes one of the opener's results AS ITS INITIALIZER. Prologue members
    // are not ordered against each other here -- that value edge already
    // ordered them, and adding the reverse direction would be a cycle.
    const openerResults = new Set((graph.operations.get(opener)?.results ?? []).map((result) => result.id))
    const prologue = members.filter(
      (id) =>
        id === opener ||
        (graph.operations.get(id)?.operands ?? []).some(
          (operand) => operand.role === 'initializer' && operand.source.kind === 'result' && openerResults.has(operand.source.result)
        )
    )
    const inPrologue = new Set(prologue)
    for (const member of members) {
      if (inPrologue.has(member)) continue
      for (const before of prologue) addPrecedence(before, member)
    }
  }

  // FunctionDeclarationInstantiation creates every direct body-level function
  // binding after parameter initialization and before the first executable
  // body statement. A source-order tie-break cannot express that phase: a
  // declaration written after `return` or after its first call is still live,
  // and one early-called declaration may itself call a sibling declared later.
  //
  // The producer marks both halves of each declaration (callable allocation
  // and binding initialization), and parameter bindings mark the phase that
  // must remain ahead of them. Dependencies of those parameter writes are part
  // of the same prologue. All function bindings then precede everything else;
  // leaving the allocations mutually unordered is deliberate because capture
  // analysis will box any sibling binding an earlier closure must share.
  const parameterRoots = operations.filter((id) => {
    const operation = graph.operations.get(id)
    return operation?.family === 'binding' && operation.parameterInitialization === true
  })
  const parameterPrologue = new Set<OperationId>()
  const collectPredecessors = (id: OperationId): void => {
    if (parameterPrologue.has(id)) return
    parameterPrologue.add(id)
    for (const before of predecessors.get(id) ?? []) collectPredecessors(before)
  }
  for (const root of parameterRoots) collectPredecessors(root)

  const hoistedAllocations = operations.filter((id) => {
    const operation = graph.operations.get(id)
    return operation?.family === 'allocation' && operation.hoistedFunctionInitialization === true
  })
  const hoistedBindings = operations.filter((id) => {
    const operation = graph.operations.get(id)
    return operation?.family === 'binding' && operation.hoistedFunctionInitialization === true
  })
  const hoisted = new Set([...hoistedAllocations, ...hoistedBindings])
  for (const parameter of parameterRoots) for (const allocation of hoistedAllocations) addPrecedence(parameter, allocation)
  const orderedHoistedBindings = [...hoistedBindings].sort((left, right) => {
    const byOrdinal = (graph.operations.get(left)?.evaluationOrdinal ?? 0) - (graph.operations.get(right)?.evaluationOrdinal ?? 0)
    return byOrdinal !== 0 ? byOrdinal : left.localeCompare(right)
  })
  for (let index = 1; index < orderedHoistedBindings.length; index += 1) {
    const before = orderedHoistedBindings[index - 1]
    const after = orderedHoistedBindings[index]
    if (before && after) addPrecedence(before, after)
  }
  const hoistBarrier = orderedHoistedBindings[orderedHoistedBindings.length - 1]
  if (hoistBarrier) {
    for (const operation of operations) {
      if (parameterPrologue.has(operation) || hoisted.has(operation)) continue
      addPrecedence(hoistBarrier, operation)
    }
  }

  // A dependency of a region member that lives outside that SAME part has to
  // run before the region opens. Topological contiguity alone cannot ensure
  // this: a hoisted function declaration used halfway through a try body is
  // ready at function entry, but its later source ordinal can leave the try's
  // marker first in the ready queue. Lowering then emits the early try
  // operations, closes the part to materialize the dependency, and re-enters
  // the cached try entry for the use. The finished graph has several outside
  // predecessors for that entry, a transfer C++ cannot express because `goto`
  // may not enter a try block.
  //
  // The dependency edge is the authority for moving the prerequisite. If an
  // operation outside the part must precede something inside it, it must also
  // precede the region marker: executing it between two operations of the part
  // would leave and re-enter the region. A dependency from a sibling part
  // instead forms a cycle with the marker-to-member edges above and therefore
  // still fails closed; no ordering can make a catch-side value available in
  // the try body before the statement begins. Snapshot the existing edges so
  // the entry-precedence edges added here do not recursively become evidence
  // for more edges of their own.
  //
  // "Outside the part" means outside the REGION: a catch handler sequenced
  // before the finally clause of the same statement (`producers/control.ts`
  // wires that edge, and the try marker itself feeds its finally the same
  // way) is not a prerequisite the statement has to wait for -- it is the
  // statement. Reading it as one added `catch -> marker` to the marker's own
  // `marker -> catch`, and every `try`/`catch`/`finally` cycled.
  const dependencies = [...successors].flatMap(([before, afters]) => [...afters].map((after) => ({ before, after })))
  for (const { before, after } of dependencies) {
    const beforeRegions = new Set(membership.requiredScopeOf(before).flatMap((ref) => (ref.kind === 'region' ? [ref.region] : [])))
    for (const ref of membership.requiredScopeOf(after)) {
      if (ref.kind !== 'region' || ref.region === before || beforeRegions.has(ref.region)) continue
      addPrecedence(before, ref.region)
    }
  }

  const evaluationOrdinalOf = (id: OperationId): number => graph.operations.get(id)?.evaluationOrdinal ?? 0
  const compareReady = (left: OperationId, right: OperationId): number => {
    const byOrdinal = evaluationOrdinalOf(left) - evaluationOrdinalOf(right)
    // Only a tie-break among operations the graph left otherwise unordered;
    // comparing the identity string decides nothing on its own, it just makes
    // that tie reproducible across runs.
    return byOrdinal !== 0 ? byOrdinal : left.localeCompare(right)
  }

  // How much of two scope chains is the same nesting, counted from the
  // outside in. `0` means the two operations share no branch at all, and the
  // lowering has to close every frame one of them is in to reach the other.
  const sharedScopeDepth = (left: readonly ScopeRef[], right: readonly ScopeRef[]): number => {
    let depth = 0
    while (depth < left.length && depth < right.length) {
      const outer = left[depth]
      const inner = right[depth]
      if (!outer || !inner || scopeKeyOf(outer) !== scopeKeyOf(inner)) break
      depth += 1
    }
    return depth
  }

  const ready = operations.filter((id) => (indegree.get(id) ?? 0) === 0).sort(compareReady)
  const ordered: OperationId[] = []
  let currentScope: readonly ScopeRef[] = []
  while (ready.length > 0) {
    // `ready` is kept in `compareReady` order, so scanning it front to back and
    // only accepting a *strictly* deeper match leaves the ordinal tie-break in
    // charge of everything contiguity does not decide.
    let chosen = 0
    let deepest = -1
    for (let index = 0; index < ready.length; index += 1) {
      const candidate = ready[index]
      if (candidate === undefined) continue
      const depth = sharedScopeDepth(currentScope, membership.requiredScopeOf(candidate))
      if (depth > deepest) {
        deepest = depth
        chosen = index
      }
    }
    const next = ready.splice(chosen, 1)[0]
    if (next === undefined) break
    ordered.push(next)
    currentScope = membership.requiredScopeOf(next)
    const unlocked: OperationId[] = []
    for (const successor of successors.get(next) ?? []) {
      const remaining = (indegree.get(successor) ?? 0) - 1
      indegree.set(successor, remaining)
      if (remaining === 0) unlocked.push(successor)
    }
    if (unlocked.length === 0) continue
    ready.push(...unlocked)
    ready.sort(compareReady)
  }

  if (ordered.length !== operations.length) {
    throw new IrLoweringBlockedError('the evaluation graph for this owner contains a cycle and has no well-defined execution order')
  }
  return { order: ordered, parameterPrologue }
}

/**
 * One scope an operation's execution sits inside, innermost last.
 *
 * A guard is one side of a branch; a loop is one iteration. They are the same
 * kind of fact -- "this does not simply run in sequence" -- and the lowering
 * opens and closes both the same way, so one chain carries both.
 */
export type ScopeRef =
  | { readonly kind: 'guard'; readonly guard: SemanticResultId; readonly takenWhen: 'truthy' | 'falsy' | 'nullish' | 'present' }
  | { readonly kind: 'loop'; readonly loop: OperationId }
  | { readonly kind: 'loop-latch'; readonly loop: OperationId }
  | { readonly kind: 'region'; readonly region: OperationId; readonly part: 'try' | 'catch' | 'finally' }

/**
 * The two-sided arm a `ScopeRef`'s four-valued `takenWhen` selects, independent
 * of which predicate reads it.
 *
 * `nullish`/`present` are not a third and fourth kind of arm -- they are the
 * same two arms tested differently -- so everything that compares scopes has
 * to apply this mapping first. A `ScopeRef` compared before it is mapped is a
 * `ScopeRef` compared in the wrong vocabulary.
 */
export const armSideOf = (takenWhen: 'truthy' | 'falsy' | 'present' | 'nullish'): 'truthy' | 'falsy' =>
  takenWhen === 'truthy' || takenWhen === 'present' ? 'truthy' : 'falsy'

/**
 * One scope's identity. Two refs with the same key name the same block-level
 * nesting, and the ordering and the flow controller must agree on that or one
 * of them will think a scope was left when it was not.
 */
export const scopeKeyOf = (ref: ScopeRef): string =>
  ref.kind === 'loop'
    ? `loop|${ref.loop}`
    : ref.kind === 'loop-latch'
      ? `loop-latch|${ref.loop}`
      : ref.kind === 'region'
        ? `region|${ref.region}|${ref.part}`
        : `guard|${ref.guard}|${armSideOf(ref.takenWhen)}`

/** Whether a guard's dependents were ever recorded on its truthy side, its falsy side, or both. */
export interface GuardArms {
  readonly hasTruthy: boolean
  readonly hasFalsy: boolean
}

/** Which question a guard's branch asks of its operand. */
export type TestPredicate = 'to-boolean' | 'is-present' | 'is-defined'

export interface ConditionalMembership {
  /** The exact, ordered scope chain an operation requires -- outermost first. Empty means it runs in sequence. */
  readonly requiredScopeOf: (operation: OperationId) => readonly ScopeRef[]
  readonly armsOf: (guard: SemanticResultId) => GuardArms
  /**
   * The predicate this guard's branch tests with.
   *
   * The census decides it, by which `takenWhen` its conditional edges carry:
   * `truthy`/`falsy` is `ToBoolean`, `nullish`/`present` is a nullish check.
   * Reading it here rather than at the branch keeps one authority -- the
   * lowering must not re-derive from the guard's carrier which question the
   * language asked, because `if (x)` and `x ?? y` over the same `x` ask
   * different ones and would derive the same answer.
   */
  readonly predicateOf: (guard: SemanticResultId) => TestPredicate
  /** The loop this guard tests, when it is a head-tested loop's own condition; `null` for an ordinary branch. */
  readonly loopOfGuard: (guard: SemanticResultId) => OperationId | null
  /** The condition a head-tested loop is driven by, which is also what decides where its exit is. */
  readonly guardOfLoop: (loop: OperationId) => SemanticResultId | null
  /**
   * Whether `loop` reserves a latch scope -- the `for` incrementor's own
   * block, structurally distinct from the header it re-tests.
   *
   * A `for` loop's `continue` must run the incrementor before the condition
   * is re-tested (ECMA-262 `ForStatement` evaluation: `continue` re-enters at
   * the update expression, not at the test). A `while` has no incrementor and
   * no latch, so its `continue` still targets the header directly.
   * `gating.ts`'s `loop-latch` gate is what marks which loops have one; this
   * is where that fact is read back, the same way every other scope fact
   * here is.
   */
  readonly hasLatch: (loop: OperationId) => boolean
  /**
   * The condition a *tail*-tested loop repeats on -- `do`/`while`'s own test.
   *
   * Deliberately a second question rather than a wider `guardOfLoop`: a head
   * test's result gates the body, so the arms that guard already owns are what
   * write the loop's back edge and its exit. A tail test gates nothing at all
   * -- the body ran before it was evaluated -- so it has no arms, no join, and
   * the back edge is built directly from it. Answering both from one map would
   * have `ensureGuardBlocks` open a branch with two empty arms for every
   * `do`/`while`, and send both of them to a join the loop never reaches.
   *
   * `null` for a head-tested loop, and for `do { ... } while (true)`, whose
   * back edge is unconditional and whose loop-tail operation therefore carries
   * no condition operand at all.
   */
  readonly tailTestOf: (loop: OperationId) => SemanticResultId | null
}

/**
 * Every operation's conditional membership, read directly from `ConditionalEdge`.
 *
 * Nesting order is derived from edge order rather than guessed: a guard whose
 * producing operation runs earlier can only be an outer condition, because a
 * later guard's own evaluation is itself gated by whichever condition already
 * let it run. That is an edge-derived fact, not a source-shaped one, even
 * though it happens to agree with source order.
 *
 * `operations` is this owner's membership set, in any order -- nothing here
 * reads a position from it. That independence is what lets the execution order
 * be computed *from* this answer rather than before it: `orderOwnerOperations`
 * needs every operation's scope chain to keep one branch's operations
 * contiguous, and a membership that depended on the order would be circular.
 */
/**
 * Puts every scope chain in enclosure order, outermost first.
 *
 * The chains arrive in edge-table order, and that is chain order only WITHIN a
 * single publisher. Two publishers state them: a producer states an operation's
 * OWN gate as a conditional edge -- `a?.b()`'s call is placed by the presence
 * test -- while `gatingEdges` states the gates of the SUBTREES it walks
 * (`gating.ts`: "an edge places an operation, a gate places a subtree"). Each is
 * internally outermost-first; between them there is no order at all, because
 * every producer edge is appended while operations are being built and every
 * gating edge afterwards.
 *
 * So an optional chain written inside any other gate came out INVERTED. For
 * `if (k) { s.emit?.("a") }` the call's chain read
 * `[?.-guard, if-guard]` -- the producer's own-gate edge first, the walk's
 * `if` edge second -- while every sibling operation in the branch read
 * `[if-guard]`. `sharedScopeDepth` compares from the outside in, so it scored
 * those two chains as sharing nothing, and the lowering closed the `if` arm to
 * enter the `?.` frame and then tried to re-enter the arm it had just ended:
 * "the truthy arm of guard ... was re-entered after it had already ended".
 * That was not a corner -- it was EVERY `?.` inside an `if`, a `while`, a
 * ternary or a `try`, and it refused the whole body.
 *
 * Sorting is not a second opinion about nesting, because the nesting is not
 * being guessed at: a scope encloses another exactly when the enclosed one's
 * OWN opening operation is gated by it, which the chains already record. Depth
 * is the length of that containment, so ordering by it reproduces the walk's
 * own order wherever one publisher stated the whole chain, and repairs it where
 * two did. A tie keeps insertion order -- the sort is stable -- so nothing that
 * was already coherent moves.
 *
 * A loop is the case that makes position-derived order wrong and this one
 * right: a loop's condition is produced INSIDE the loop, so its chain contains
 * the loop frame, so the guard on that condition scores deeper than the frame
 * and stays within it. Reading position would have hoisted it out.
 */
const orderChainsByEnclosure = (
  perOperation: Map<OperationId, ScopeRef[]>,
  headTestOfLoop: (loop: OperationId) => SemanticResultId | null
): void => {
  const openerOf = (ref: ScopeRef): OperationId =>
    ref.kind === 'guard' ? operationOfResult(ref.guard) : ref.kind === 'region' ? ref.region : ref.loop

  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthAbove = (opener: OperationId): number => {
    let depth = 0
    for (const enclosing of perOperation.get(opener) ?? []) depth = Math.max(depth, depthOf(enclosing) + 1)
    return depth
  }
  /**
   * A latch is one scope deeper than its loop's test, not one deeper than the
   * loop.
   *
   * Every other scope is measured through the chain of its own opening
   * operation, and a latch has none -- it opens at the END of the body rather
   * than at any operation. Falling back to the loop operation scored it level
   * with the loop frame, so `i++`'s chain `[loop, test-truthy, latch]` sorted to
   * `[loop, latch, test-truthy]` and the lowering closed the body arm to enter
   * the latch and then re-entered the arm it had just ended. That is every
   * head-tested `for` and `while` with an update -- `array_read`'s two loops
   * included -- so the whole ordering pass refused ordinary programs.
   *
   * The containment is not a guess: a head-tested loop reaches its latch only
   * from the body, and the body IS the test's truthy arm, so the latch is
   * inside it. A tail-tested loop has no such arm -- its test decides only the
   * back edge -- and its latch sits directly in the loop frame.
   */
  const latchDepth = (loop: OperationId): number => {
    const test = headTestOfLoop(loop)
    return test === null ? depthAbove(loop) + 1 : depthAbove(operationOfResult(test)) + 1
  }
  const depthOf = (ref: ScopeRef): number => {
    const key = scopeKeyOf(ref)
    const known = depths.get(key)
    if (known !== undefined) return known
    // A chain that refers back to itself has no containment to measure. It
    // cannot arise from a well-formed program -- a scope does not open inside
    // itself -- but answering 0 keeps a malformed graph from recursing forever,
    // and leaves the affected chain in the order it arrived, which is what it
    // would have had before any of this.
    if (visiting.has(key)) return 0
    visiting.add(key)
    const depth = ref.kind === 'loop-latch' ? latchDepth(ref.loop) : depthAbove(openerOf(ref))
    visiting.delete(key)
    depths.set(key, depth)
    return depth
  }

  for (const chain of perOperation.values()) {
    if (chain.length < 2) continue
    chain.sort((left, right) => depthOf(left) - depthOf(right))
  }
}

export const collectConditionalMembership = (
  graph: SemanticGraph,
  operations: readonly OperationId[],
  /** This owner's share of the edge table, in `graph.edges` order; the walk below keeps only edges landing inside `operations` anyway. */
  ownerEdges: readonly SemanticEdge[]
): ConditionalMembership => {
  const members = new Set(operations)
  const perOperation = new Map<OperationId, ScopeRef[]>()
  const arms = new Map<SemanticResultId, { truthy: boolean; falsy: boolean }>()
  const predicates = new Map<SemanticResultId, TestPredicate>()
  const loopGuards = new Map<SemanticResultId, OperationId>()
  const tailTests = new Map<OperationId, SemanticResultId>()
  const latchLoops = new Set<OperationId>()

  // Edge order is the chain order WITHIN one publisher, and the chains are
  // sorted by enclosure once the walk below has collected them -- see
  // `orderChainsByEnclosure`.
  for (const edge of ownerEdges) {
    if (!members.has(edge.to)) continue
    if (edge.kind === 'loop') {
      const list = perOperation.get(edge.to) ?? []
      if (!list.some((ref) => ref.kind === 'loop' && ref.loop === edge.loop)) {
        list.push({ kind: 'loop', loop: edge.loop })
        perOperation.set(edge.to, list)
      }
      continue
    }
    if (edge.kind === 'loop-latch') {
      latchLoops.add(edge.loop)
      const list = perOperation.get(edge.to) ?? []
      if (!list.some((ref) => ref.kind === 'loop-latch' && ref.loop === edge.loop)) {
        list.push({ kind: 'loop-latch', loop: edge.loop })
        perOperation.set(edge.to, list)
      }
      continue
    }
    if (edge.kind === 'region') {
      const list = perOperation.get(edge.to) ?? []
      if (!list.some((ref) => ref.kind === 'region' && ref.region === edge.region && ref.part === edge.part)) {
        list.push({ kind: 'region', region: edge.region, part: edge.part })
        perOperation.set(edge.to, list)
      }
      continue
    }
    if (edge.kind !== 'conditional') continue
    const list = perOperation.get(edge.to) ?? []
    if (!list.some((ref) => ref.kind === 'guard' && ref.guard === edge.guard && ref.takenWhen === edge.takenWhen)) {
      list.push({ kind: 'guard', guard: edge.guard, takenWhen: edge.takenWhen })
      perOperation.set(edge.to, list)
    }
    // `present` and `nullish` are the two arms of a nullish branch, not two
    // more kinds of arm: recording them here as truthy/falsy is what lets one
    // pair of blocks serve both branch shapes, with the predicate carrying the
    // only difference.
    const bucket = arms.get(edge.guard) ?? { truthy: false, falsy: false }
    if (edge.takenWhen === 'truthy' || edge.takenWhen === 'present') bucket.truthy = true
    if (edge.takenWhen === 'falsy' || edge.takenWhen === 'nullish') bucket.falsy = true
    arms.set(edge.guard, bucket)
    if (edge.takenWhen === 'present' || edge.takenWhen === 'nullish') predicates.set(edge.guard, 'is-present')
  }

  // `a ?? b` tests presence, and that is a fact of the operator -- not of the
  // edge that happens to gate its right-hand side. When the right side produces
  // no operation of its own (`x ?? 'default'`, whose right side is a constant)
  // there is no conditional edge at all, and reading the predicate only off
  // edges silently leaves the guard a truthiness test: `'' ?? 'default'` would
  // then answer `'default'` where the language answers `''`. So the operator
  // states it directly, for every `??` in this owner, edge or no edge.
  for (const operationId of operations) {
    const operation = graph.operations.get(operationId)
    if (operation?.family !== 'computation' || operation.form !== 'logical' || operation.operator !== '??') continue
    const left = operandOf(operation, 'left')
    if (left?.source.kind === 'result') predicates.set(left.source.result, 'is-present')
  }

  // A default parameter initializer's guard is the same fact about a
  // different operation: `reference`/`parameter-value` publishes the raw
  // argument for exactly one reason, testing its presence, and every such
  // operation in this owner needs that predicate whether or not the
  // initializer it guards happens to mint an operation of its own --
  // `function f(x = 0)`'s initializer is a constant, so `gatingEdges` never
  // emits a conditional edge for it at all, the same gap the `??` loop above
  // closes for a constant right-hand side.
  for (const operationId of operations) {
    const operation = graph.operations.get(operationId)
    if (operation?.family !== 'reference' || operation.form !== 'parameter-value') continue
    const result = resultOf(operation, 'value')
    // `is-defined`, not `is-present`. A default runs when the argument was
    // OMITTED, and an omitted argument is `undefined` -- `null` is a value a
    // caller chose, and the language binds it: `f(x = 0)` called `f(null)`
    // binds `null`, not `0` (ECMA-262 8.6.3, which tests `undefined` and
    // nothing else). A nullish test answers the wrong question for every
    // carrier that can hold `null` at all -- a box, and the three-armed union
    // a `T | null` default now derives (`normalize/parameter-slot.ts`) -- and
    // asking the right one costs nothing for the carriers that cannot, where
    // both tests read the same flag.
    if (result) predicates.set(result.id, 'is-defined')
  }

  // A binding element's default asks the same question of a different
  // operation: `const { width = 10 } = options` runs its initializer when the
  // EXTRACTION was `undefined`. The `default-value` step names that extraction
  // itself, through its own `extracted` operand, so this is a citation rather
  // than a second opinion about which result is the guard -- and `is-defined`
  // over `is-present` for the reason the parameter loop above gives: `{ a = 1 }`
  // destructuring `{ a: null }` binds `null`, never `1` (ECMA-262 8.6.3 tests
  // `undefined` and nothing else). The `nullish` gating edge `gating.ts` writes
  // would otherwise leave this at `is-present`.
  for (const operationId of operations) {
    const operation = graph.operations.get(operationId)
    if (operation?.family !== 'destructuring' || operation.form !== 'default-value') continue
    const extracted = operandOf(operation, 'extracted')
    if (extracted?.source.kind === 'result') predicates.set(extracted.source.result, 'is-defined')
  }

  // A loop's own test is the guard its `condition` operand names. The loop
  // operation states that directly, so reading it is a citation rather than a
  // second opinion -- and the distinction matters because closing a loop-test
  // arm is not like closing an `if`: it ends in a back edge to the header, not
  // a jump forward to a join, so the arm is deliberately registered as no join
  // source at all.
  //
  // Deriving it from the scope chain's *shape* instead -- "a guard sitting
  // directly inside a loop frame, whose own condition was evaluated in that
  // loop" -- cannot tell a loop's test from a guard *inside* a compound
  // condition. In `while (a && b)`, the operations computing `b` run under a
  // guard on `a`; that guard also sits directly inside the loop frame and `a`
  // is also evaluated there, so the shape rule classified BOTH `a` and the
  // `&&`'s own merged result as the loop's test. Two guards then claimed one
  // loop, which `guardOfLoop`'s first-match scan resolved arbitrarily, and
  // `a`'s truthy arm was closed with a back edge -- leaving the merge the `&&`
  // still needs with no join source, so `requireMergeSources` jumped an
  // already-terminated block and the compiler threw. `while (a && b)` is
  // ordinary TypeScript, and it crashed compilation outright.
  //
  // A tail-tested loop states its condition through the identical operand, and
  // is separated here by form alone: its test decides only the back edge, so it
  // is recorded as this loop's tail test and never as a guard anything is
  // inside. Folding it into `loopGuards` would make `while`'s own "the truthy
  // arm is the body" rule apply to a body that is not in any arm.
  for (const operationId of operations) {
    const operation = graph.operations.get(operationId)
    if (operation?.family !== 'control') continue
    if (operation.form !== 'loop' && operation.form !== 'loop-tail') continue
    const condition = operandOf(operation, 'condition', 0)
    if (condition?.source.kind !== 'result') continue
    if (operation.form === 'loop') loopGuards.set(condition.source.result, operationId)
    else tailTests.set(operationId, condition.source.result)
  }

  const headTests = new Map<OperationId, SemanticResultId>()
  for (const [test, loop] of loopGuards) headTests.set(loop, test)
  orderChainsByEnclosure(perOperation, (loop) => headTests.get(loop) ?? null)

  return {
    requiredScopeOf: (operation) => perOperation.get(operation) ?? [],
    predicateOf: (guard) => predicates.get(guard) ?? 'to-boolean',
    armsOf: (guard) => {
      const bucket = arms.get(guard)
      return { hasTruthy: bucket?.truthy ?? false, hasFalsy: bucket?.falsy ?? false }
    },
    loopOfGuard: (guard) => loopGuards.get(guard) ?? null,
    guardOfLoop: (loop) => {
      for (const [guard, owner] of loopGuards) if (owner === loop) return guard
      return null
    },
    hasLatch: (loop) => latchLoops.has(loop),
    tailTestOf: (loop) => tailTests.get(loop) ?? null
  }
}
