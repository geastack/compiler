import ts from 'typescript'
import type { NamespacePathCensus } from './namespace-paths.js'
import {
  operationFamilies,
  operationId,
  operationOfResult,
  semanticResultId,
  type NodeId,
  type OperationId,
  type SemanticResultId
} from '../../identity/ids.js'
import type { ConditionalEdge, SemanticEdge } from '../model/edges.js'
import { operandOf } from '../model/operands.js'
import type { SemanticOperation } from '../model/operations.js'
import { forEachEvaluationChild } from './evaluation-order.js'
import type { ArgumentsObjectCensus } from './arguments-objects.js'
import type { UnresolvableNameCensus } from './unresolvable-names.js'
import { rootSpecialization, type IdentityTable, type SpecializationPath } from './identities.js'
import { parameterValueResultOf } from './producers/bindings.js'
import { citeSwitchCaseTest, citeSwitchGroupTest, clauseTerminates } from './producers/control.js'
import { citeExpressionResult, type CitationFacts } from './producers/references.js'
import { optionalChainGuardOf, optionalCallGuardOf } from './producers/optional-chain.js'
import type { ProgramReachability } from './reachability.js'
import { citeExtractedElementValue } from './producers/destructuring.js'
import type { SpecializationCensus } from './specialization.js'

/**
 * Which operations a conditional guard gates.
 *
 * A producer sees one census candidate at a time, so no producer can state that
 * everything inside an `if` body runs only when the condition held. Leaving that
 * unstated does not merely lose an optimization: the lowering places every
 * ungated operation in the same straight line, so both arms of an `if` execute.
 * That is a silent miscompile, which is why this is a pass rather than a gap.
 *
 * It reads syntax structure only -- which statement is an `if`'s consequent,
 * which expression is a `?:` arm -- exactly as the census does, and never a
 * name, a position, or the text of anything. The guard it names is the same
 * citation every other consumer of that condition gets.
 */

export interface GatingInput {
  readonly files: readonly ts.SourceFile[]
  readonly identities: IdentityTable
  /**
   * Threaded for `guardOf` alone: a gate's condition is cited exactly the way
   * every other consumer cites it, and `citeExpressionResult` needs this to
   * answer for an `arguments` read (`normalize/arguments-objects.ts`). Gating
   * itself never asks about `arguments`.
   */
  readonly argumentsObjects: ArgumentsObjectCensus
  readonly unresolvableNames: UnresolvableNameCensus
  readonly namespacePaths: NamespacePathCensus
  readonly operations: ReadonlyMap<OperationId, SemanticOperation>
  /** Which of those files' statements this program reaches -- the same answer the census walked. */
  readonly reachable: ProgramReachability
  /**
   * Which generics this program instantiates, and how many times -- the same
   * answer `census.ts` forked its own walk on.
   *
   * This pass mints operation ids to gate them, and a monomorphized copy's ids
   * carry that copy's specialization key. A walk that asked the root table
   * would name the generic rather than the copy, and every gate it emitted
   * would name an operation no copy publishes.
   */
  readonly specializations: SpecializationCensus
}

/**
 * One reason an operation does not simply run in sequence: it is on one side of
 * a branch, or it is inside a loop's iteration. Both are scopes the lowering
 * opens and closes, and an operation's chain of them, outermost first, is what
 * decides which block it lands in.
 */
type Gate =
  | { readonly kind: 'guard'; readonly guard: SemanticResultId; readonly takenWhen: ConditionalEdge['takenWhen'] }
  | { readonly kind: 'loop'; readonly loop: OperationId }
  | { readonly kind: 'loop-latch'; readonly loop: OperationId }
  | { readonly kind: 'region'; readonly region: OperationId; readonly part: 'try' | 'catch' | 'finally' }

/**
 * Every operation one node published.
 *
 * Ordinals within a `(node, family)` pair are handed out consecutively from
 * zero, so probing until the first absence enumerates them exactly. This is why
 * the pass can gate a node without knowing which producer served it or how many
 * operations that producer minted -- a compound assignment's three, an update's
 * two, a property's get-then-set pair.
 */
const operationsOfNode = (operations: GatingInput['operations'], node: NodeId): readonly OperationId[] => {
  const found: OperationId[] = []
  // The node half of the identity, built once instead of once per probe.
  //
  // Every probe below asks for `op|<node>|<family>|<ordinal>` and the node is
  // the long part -- a file identity, a syntax kind, an ordinal and a
  // specialization suffix. Rebuilding it for all fourteen families, and again
  // for every ordinal of every family that answers, copied that string fifteen
  // or more times to ask fifteen questions about one node. The ids are
  // identical to `operationId`'s own spelling (this is the same concatenation
  // it performs, with its first argument factored out), so the probe order,
  // the answers, and the truncation at the first absent ordinal are unchanged.
  const prefix = `op|${node}|`
  for (const family of operationFamilies) {
    const familyPrefix = `${prefix}${family}|`
    for (let ordinal = 0; ; ordinal += 1) {
      const id = `${familyPrefix}${ordinal}` as OperationId
      if (!operations.has(id)) break
      found.push(id)
    }
  }
  return found
}

/**
 * A nested function body is not gated by whatever `if` its declaration sits in:
 * it runs when it is called, which can be any time at all. Its *allocation* is
 * gated, and that operation belongs to the enclosing body, so the boundary is
 * the body -- not the declaration.
 */
const bodyOfOwnCaller = (node: ts.Node): ts.Node | null => {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.body ?? null
  if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) return node.body ?? null
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.body ?? null
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node
  return null
}

/** The condition's own published result, or `null` when nothing citable produces it. */
const guardOf = (condition: ts.Expression, facts: CitationFacts): SemanticResultId | null => {
  const cited = citeExpressionResult(condition, facts)
  if (cited.kind !== 'source' || cited.source.kind !== 'result') return null
  return cited.source.result
}

/**
 * The walk, bound to one monomorphized copy.
 *
 * `visit` is the entry a parent uses: it forks on the copies of whatever
 * generic it lands on. `visitHere` is the same walk with that fork already
 * decided, which is how the fork descends into a copy without re-asking the
 * question about the node it just answered it for.
 */
interface GateWalker {
  readonly visit: (node: ts.Node, gates: readonly Gate[]) => void
  readonly visitHere: (node: ts.Node, gates: readonly Gate[]) => void
}

export const gatingEdges = (input: GatingInput): readonly SemanticEdge[] => {
  const { files, operations, specializations } = input
  const edges: SemanticEdge[] = []
  // One walker per copy, built on first use. Rebuilding a dozen closures for
  // every node of every copy would rebuild them for one answer, the same way
  // `normalize.ts` caches a producer set per copy and for the same reason.
  const walkers = new Map<string, GateWalker>()

  // Emitted in chain order, outermost first: the lowering reads the chain back
  // in the order the edges arrive, so a caller's own nesting is what states
  // which scope contains which.
  const pushGateEdgesFor = (to: OperationId, gates: readonly Gate[]): void => {
    for (const gate of gates) {
      // Emitted in chain order, outermost first: the lowering reads the chain
      // back in the order the edges arrive, so this walk's own nesting is what
      // states which scope contains which.
      if (gate.kind === 'loop') edges.push({ kind: 'loop', loop: gate.loop, to })
      else if (gate.kind === 'loop-latch') edges.push({ kind: 'loop-latch', loop: gate.loop, to })
      else if (gate.kind === 'region') edges.push({ kind: 'region', region: gate.region, part: gate.part, to })
      else edges.push({ kind: 'conditional', guard: gate.guard, to, takenWhen: gate.takenWhen })
    }
  }

  const walkerFor = (path: SpecializationPath): GateWalker => {
    const key = input.identities.copyKeyOf(path)
    const cached = walkers.get(key)
    if (cached) return cached
    // Every id this walker mints goes through the copy's own view. A node the
    // copy does not enclose still answers with its root identity -- the view
    // truncates the path to the steps that actually contain the node -- so one
    // walker per copy is correct for the whole subtree it reaches, not only
    // for the part inside the generic.
    const identities = input.identities.forSpecialization(path)
    // The copy's own view, plus the program-wide census: one citation rule,
    // whichever specialization is walking.
    const facts: CitationFacts = {
      identities,
      argumentsObjects: input.argumentsObjects,
      unresolvableNames: input.unresolvableNames,
      namespacePaths: input.namespacePaths
    }

    const emit = (node: ts.Node, gates: readonly Gate[]): void => {
      if (gates.length === 0) return
      for (const to of operationsOfNode(operations, identities.nodeIdOf(node))) pushGateEdgesFor(to, gates)
    }

    /**
     * Monomorphization, the same fork `census.ts` performs on the same census
     * and in the same two halves.
     *
     * A generic's body is walked once per instantiation, under that copy's
     * path, because that is the path the census minted the copy's operation
     * ids under. Walking it once at the root instead names the generic, and a
     * gate naming an operation no copy publishes is dropped by
     * `normalize.ts`'s own dangling-edge filter -- silently, because a gate is
     * invented by this pass rather than published by a producer, so no
     * withheld-component blocker is reported for it. What reaches the lowering
     * is then a body whose `if` arms both run.
     *
     * A generic the program never instantiates is walked not at all, for the
     * reason the census states: it has no operations to gate.
     */
    const visit = (node: ts.Node, gates: readonly Gate[]): void => {
      // A type annotation contains no operations, and a function body starts a
      // caller of its own whose execution this chain says nothing about.
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
      const copies = specializations.specializationsOf(node as ts.Declaration)
      if (copies.length > 0) {
        for (const copy of copies) {
          walkerFor([...path, { owner: node as ts.Declaration, ordinal: copy.ordinal }]).visitHere(node, gates)
        }
        return
      }
      if (specializations.isGeneric(node as ts.Declaration)) return
      visitHere(node, gates)
    }

    const visitHere = (node: ts.Node, gates: readonly Gate[]): void => {
      if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
        // `mintIteratorSteps` reserves all four protocol ordinals -- 0
        // `get-method`, 1 `get-iterator`, 2 `next`, 3 `close` -- even when a
        // step is skipped for THIS spread, for the identical reason the
        // for-of/for-in branch below states: reserving the ordinal even when
        // unused keeps each step's identity fixed across variants. A plain
        // dynamic gather (`[...anySource]`, `mintIteratorSteps`' `appendGather`
        // caller) publishes only `get-iterator` at ordinal 1 -- `get-method` at
        // ordinal 0 is reserved but never published -- so `operationsOfNode`'s
        // generic probe (which stops at the first missing ordinal, starting
        // from zero) never reaches it: `emit(node, gates)` below found nothing
        // for this node and left `get-iterator` at the unconditional outer
        // scope. Inside a `try`, that stranded operation read as a dependency
        // from OUTSIDE the region into it, and the promotion rule that moves a
        // cross-region dependency ahead of the region's own marker
        // (`ir/lower-graph.ts`'s `dependencies` loop) then required the try to
        // wait on an operation it could only run by first being inside the
        // try -- a cycle, not a bug in that rule. Gate the four fixed ordinals
        // directly instead of probing for them: a gate naming an operation
        // this spread never published is dropped by `normalize.ts`'s own
        // dangling-edge filter, so this is safe for a closed-tuple or
        // native-range-copy spread, which publish none of the four, too.
        const nodeId = identities.nodeIdOf(node)
        pushGateEdgesFor(operationId(nodeId, 'protocol', 0), gates)
        pushGateEdgesFor(operationId(nodeId, 'protocol', 1), gates)
        pushGateEdgesFor(operationId(nodeId, 'protocol', 2), gates)
        pushGateEdgesFor(operationId(nodeId, 'protocol', 3), gates)
        // and then FALL THROUGH to `emit(node, gates)` below. This branch ADDS
        // the ordinals the probe cannot reach; it does not replace the generic
        // handling, and an earlier version that returned here broke every
        // spread whose operations the probe finds perfectly well. A rest
        // TARGET (`[first, ...tail] = source`) is the case that exposed it:
        // `mintIteratorSteps` keys all four ordinals on `candidate.id`
        // (producers/protocol.ts), which for an assignment pattern is the
        // enclosing ArrayLiteralExpression, never the rest element -- so the
        // four gates above are dangling for it and drop out, and returning
        // early meant its own node was never emitted at all. The enclosing
        // `for...of`'s operations were then left unGated, and its guard's
        // truthy arm read as re-entered after it had ended
        // (`array-assignment-rest-target.ts`).
      }
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        const loop = operationId(identities.nodeIdOf(node), 'control', 0)
        const loopOperation = operations.get(loop)
        // `control.ts`'s `contributeForOfIn` reshapes every sync for-of/for-in
        // loop into an ordinary head-tested one -- a `'condition'` operand
        // instead of `'iterator-record'` -- for both the array/enumeration
        // fast path AND the general dynamic-protocol path (a source neither
        // `hasNativeIterationCursor` nor `hasNativeEnumerationCursor` claims a
        // native cursor for; a `for...of` over `Headers`/`URLSearchParams` is
        // this shape). The condition and the steps feeding it (get-method,
        // get-iterator, next, the `!done` negation) have no source `ts.Node`
        // of their own the way a real `while`/`for`'s condition expression
        // does, so this branch reconstructs their fixed operation ids
        // directly rather than visiting one: `protocol` ordinal 0 is
        // `get-method`, 1 is `get-iterator`, 2 is always `next`, and the
        // negation is `computation` ordinal 0, the only operation of that
        // family this statement's own node ever mints.
        //
        // `get-method` (ordinal 0) is reserved but never MINTED on the fast
        // path -- `mintIteratorSteps`'s `includeGetMethod: !arrayFastPath &&
        // isForOf` -- so gating it there is a no-op (a gate naming an
        // operation no copy publishes is dropped by `normalize.ts`'s own
        // dangling-edge filter). On the general path it IS minted, runs once
        // before the loop starts (the same scope as get-iterator, never the
        // per-iteration `inside`), and until this line was never gated at
        // all: nothing placed its operations inside the guard's arm, so they
        // landed at the unconditional outer scope while get-iterator/next
        // (gated below) stayed inside it -- the same arm then closes once
        // (unconditionally-scoped code runs before it) and gets asked to
        // reopen for the loop's own gated operations, which
        // `lower-flow.ts`'s `enterArm` refuses by name: "the truthy arm of
        // guard ... was re-entered after it had already ended". Confirmed by
        // tracing hono's `Context#newResponse` (`context.ts:613`'s `for
        // (const [key, value] of argHeaders)`, `argHeaders` a `Headers`):
        // `get-method`'s own operation carried an EMPTY scope chain while
        // `get-iterator`/`next` for the identical for-of correctly carried
        // `guard(...,truthy)`.
        //
        // This entirely bypasses the generic `emit(node, gates)` call below --
        // not merely runs before it -- because that call's own per-node scan
        // would otherwise find the negation too (it sits at ordinal 0, unlike
        // the protocol steps, which a real gap hides from it) and gate it a
        // second time, at the wrong, unconditional outer scope. Handling the
        // loop operation itself here as well keeps both gatings of this one node
        // in one place instead of splitting it across two code paths.
        if (loopOperation && operandOf(loopOperation, 'condition')) {
          pushGateEdgesFor(loop, gates)
          visit(node.expression, gates)
          const nodeId = identities.nodeIdOf(node)
          pushGateEdgesFor(operationId(nodeId, 'protocol', 0), gates)
          pushGateEdgesFor(operationId(nodeId, 'protocol', 1), gates)
          const inside: readonly Gate[] = [...gates, { kind: 'loop', loop }]
          pushGateEdgesFor(operationId(nodeId, 'protocol', 2), inside)
          const negationId = operationId(nodeId, 'computation', 0)
          pushGateEdgesFor(negationId, inside)
          const iteration: readonly Gate[] = [
            ...inside,
            { kind: 'guard', guard: semanticResultId(negationId, 'value'), takenWhen: 'truthy' }
          ]
          // ECMA-262's own `ForOfBodyEvaluation`: the loop variable is (re)bound
          // from this iteration's value only once the loop is confirmed to
          // continue, immediately before the body runs -- the same `iteration`
          // scope the body itself gets, not the unconditional per-iteration
          // `inside` scope `next`/the negation use (those must still run on the
          // final, non-continuing check). `node.initializer` is a real
          // `ts.Node` (the `VariableDeclarationList` holding `value`'s own
          // declaration, or a bare assignment target), so it goes through the
          // ordinary generic `visit` rather than a reconstructed id.
          visit(node.initializer, iteration)
          visit(node.statement, iteration)
          return
        }
        // Not the array fast path (or the candidate never built at all): fall
        // through unchanged to the ordinary generic handling below, exactly as
        // for-of/for-in were handled before this branch existed.
      }

      emit(node, gates)

      const ownBody = bodyOfOwnCaller(node)
      if (ownBody) {
        // A parameter's default initializer runs inside the callee's own
        // activation, at call time -- exactly like the body, and never at the
        // declaration site. A function declared inside an `if` still binds its
        // parameters fresh on every call, so a parameter child resets the chain
        // the same way the body already does; only the declaration's own
        // allocation stays gated by where it was written.
        forEachEvaluationChild(node, (child) => visit(child, child === ownBody || ts.isParameter(child) ? [] : gates))
        return
      }

      // A binding element's own default -- `const { width = 10 } = options` --
      // is the same shape one level in: the initializer runs only when the
      // EXTRACTION came back `undefined`, so it is gated on the extraction's
      // result exactly as a parameter's is gated on its raw argument. `nullish`
      // is the arm vocabulary; which absence question is asked travels on the
      // predicate, and `lower-graph.ts` states `is-defined` for this guard for
      // the reason it states it for a parameter: `{ a = 1 }` over `{ a: null }`
      // binds `null`, never `1`.
      //
      // Without this the initializer's operations sit ungated in the straight
      // line, so `{ canvas = createCanvasElement() }` would CALL the factory
      // whether or not a canvas was supplied.
      if (ts.isBindingElement(node) && node.initializer) {
        forEachEvaluationChild(node, (child) => {
          if (child === node.initializer) return
          visit(child, gates)
        })
        visit(node.initializer, [...gates, { kind: 'guard', guard: citeExtractedElementValue(node, identities), takenWhen: 'nullish' }])
        return
      }

      if (ts.isParameter(node) && node.initializer) {
        // Pattern extraction runs after the parameter's default has selected
        // its value; only the initializer belongs under the absence guard.
        visit(node.name, gates)
        visit(node.initializer, [...gates, { kind: 'guard', guard: parameterValueResultOf(node, identities), takenWhen: 'nullish' }])
        return
      }

      // A `switch` is an `if`/`else if` chain over one discriminant, and it is
      // gated as one: clause `i` runs when its own test held and every earlier
      // test did not. `producers/control.ts` mints those tests -- one strict
      // equality per `case`, keyed on the clause -- and refuses the one shape a
      // chain cannot say (a `default` that is not last), so what reaches here
      // is exactly the shape these gates describe. The `default` clause has no
      // test of its own; its gate is every case ON THE CHAIN having failed.
      //
      // A clause that can fall through (`control.ts`'s `clauseTerminates`)
      // hands its guard forward exactly as an empty clause does: its body sits
      // on its own guard's arm, and the next clause's guard is the `||` fold
      // of the two, so the next body runs when either test held -- unless the
      // first body left through a `break`, which jumps to the switch's exit.
      // Its guard therefore does NOT join the chain as a falsy gate, which is
      // also what lets it fall into `default`: that clause runs when nothing
      // on the chain held, and the guard handed forward is not on it.
      if (ts.isSwitchStatement(node)) {
        visit(node.expression, gates)
        const chain: Gate[] = [...gates]
        let running: SemanticResultId | null = null
        for (const clause of node.caseBlock.clauses) {
          if (!ts.isCaseClause(clause)) {
            for (const statement of clause.statements) visit(statement, chain)
            running = null
            continue
          }
          const test = citeSwitchCaseTest(clause, identities)
          // Within an empty-clause group, every later label is evaluated only
          // if the accumulated match failed. The group's || merge itself lives
          // outside that arm, so the existing logical lowering can join it.
          const labelGates: readonly Gate[] = running === null ? chain : [...chain, { kind: 'guard', guard: running, takenWhen: 'falsy' }]
          visit(clause.expression, labelGates)
          pushGateEdgesFor(operationOfResult(test), labelGates)
          const guard: SemanticResultId = running === null ? test : citeSwitchGroupTest(clause, identities)
          if (running !== null) pushGateEdgesFor(operationOfResult(guard), chain)
          if (clause.statements.length === 0) {
            running = guard
            continue
          }
          for (const statement of clause.statements) visit(statement, [...chain, { kind: 'guard', guard, takenWhen: 'truthy' }])
          if (!clauseTerminates(clause)) {
            running = guard
            continue
          }
          chain.push({ kind: 'guard', guard, takenWhen: 'falsy' })
          running = null
        }
        return
      }

      if (ts.isIfStatement(node)) {
        visit(node.expression, gates)
        const guard = guardOf(node.expression, facts)
        // A condition with no citable result cannot gate anything. The control
        // producer refuses such a branch outright, so the arms below are already
        // in a blocked body; descending with the chain unchanged keeps this pass
        // from inventing a gate it cannot name.
        visit(node.thenStatement, guard === null ? gates : [...gates, { kind: 'guard', guard, takenWhen: 'truthy' }])
        if (node.elseStatement) visit(node.elseStatement, guard === null ? gates : [...gates, { kind: 'guard', guard, takenWhen: 'falsy' }])
        return
      }

      // An optional chain does not evaluate what is inside its own brackets when
      // the guard is absent: `h.on?.(side())` never calls `side`, and `a?.[k()]`
      // never calls `k`. The producers state the *operation's* own gate as a
      // conditional edge, which places the call or the `[[Get]]`; this is the
      // other half, because an argument list and a computed key are subtrees, and
      // only a walk that knows which syntax they belong to can put them inside
      // the guard. Without it every argument was hoisted above the presence test
      // -- a call the source program never makes.
      const chain = optionalChainSubtree(node)
      if (chain) {
        visit(chain.evaluated, gates)
        const guard = guardOf(chain.guard, facts)
        const inside: readonly Gate[] = guard === null ? gates : [...gates, { kind: 'guard', guard, takenWhen: 'present' }]
        for (const gated of chain.gated) visit(gated, inside)
        return
      }

      if (ts.isConditionalExpression(node)) {
        visit(node.condition, gates)
        const guard = guardOf(node.condition, facts)
        visit(node.whenTrue, guard === null ? gates : [...gates, { kind: 'guard', guard, takenWhen: 'truthy' }])
        visit(node.whenFalse, guard === null ? gates : [...gates, { kind: 'guard', guard, takenWhen: 'falsy' }])
        return
      }

      // `a ||= b`: the right-hand SUBTREE is evaluated only on the branch the
      // operator does not short-circuit on, exactly as `a || b`'s is. Placing
      // the STORE is not this pass's job -- whoever mints the store publishes a
      // `conditional` edge for it (`producers/computations.ts`'s
      // `contributeLogicalAssignment` for a binding target,
      // `producers/properties.ts`'s `logical-set` for a property one), the same
      // division of labour `a?.b()` uses: an edge places an operation, a gate
      // places a subtree. The merge itself is deliberately ungated -- it is the
      // join both branches reach.
      if (ts.isBinaryExpression(node) && logicalAssignmentTakenWhen(node.operatorToken.kind) !== null) {
        visit(node.left, gates)
        const guard = guardOf(node.left, facts)
        const takenWhen = logicalAssignmentTakenWhen(node.operatorToken.kind)
        visit(node.right, guard === null || takenWhen === null ? gates : [...gates, { kind: 'guard', guard, takenWhen }])
        return
      }

      if (ts.isBinaryExpression(node) && shortCircuitTakenWhen(node.operatorToken.kind) !== null) {
        visit(node.left, gates)
        const guard = guardOf(node.left, facts)
        const takenWhen = shortCircuitTakenWhen(node.operatorToken.kind)
        visit(node.right, guard === null || takenWhen === null ? gates : [...gates, { kind: 'guard', guard, takenWhen }])
        return
      }

      // A `while`/`for` head-tested loop is a guard plus a back edge: the condition
      // and the body are both inside the iteration, and the condition's own guard
      // is what separates them. Stating both is what lets the lowering put the
      // condition in a block the body's end can jump back to.
      //
      // `for`-`of`/`for`-`in` are absent: their iteration is driven by the
      // iterator protocol, not by a boolean guard. A `do`/`while` is absent for
      // the opposite reason and gets its own branch just below -- gating its
      // body on the condition would skip the guaranteed first iteration.
      //
      // A `do`/`while` is a loop scope with *no* guard between the loop and the
      // body: the body runs unconditionally on entry, which is the whole of
      // what "tail-tested" means. The condition then sits one scope deeper, in
      // the loop's latch -- the same block a `for` incrementor gets, and for
      // the same reason: it is post-body code that `continue` must re-enter at,
      // since ECMA-262 14.7.2 sends `continue` to the test, not to the top of
      // the body. The back edge itself is the latch's own terminator, a branch
      // the flow controller builds from `loop-tail`'s condition operand; there
      // is no conditional gate to state here because no operation of this loop
      // is conditional on the test at all.
      if (ts.isDoStatement(node)) {
        const loop = operationId(identities.nodeIdOf(node), 'control', 0)
        if (operations.has(loop)) {
          const inside: readonly Gate[] = [...gates, { kind: 'loop', loop }]
          visit(node.statement, inside)
          visit(node.expression, [...inside, { kind: 'loop-latch', loop }])
          return
        }
      }

      const head = headTestedLoopOf(node)
      if (head) {
        const loop = operationId(identities.nodeIdOf(node), 'control', 0)
        if (operations.has(loop)) {
          const inside: readonly Gate[] = [...gates, { kind: 'loop', loop }]
          if (head.initializer) visit(head.initializer, gates)
          if (head.condition) visit(head.condition, inside)
          const guard = head.condition ? guardOf(head.condition, facts) : null
          const iteration: readonly Gate[] = guard === null ? inside : [...inside, { kind: 'guard', guard, takenWhen: 'truthy' }]
          visit(head.body, iteration)
          // The incrementor is inside the iteration the same way the body is,
          // but it is also `continue`'s real target: ECMA-262's `ForStatement`
          // evaluation re-enters at the update expression, not at the test.
          // Marking its own extra scope layer is what lets the lowering give it
          // a block distinct from the header -- one a `continue` inside the
          // body can jump to before the condition is ever re-tested.
          if (head.incrementor) visit(head.incrementor, [...iteration, { kind: 'loop-latch', loop }])
          return
        }
      }

      // A try statement's three clauses are mutually exclusive scopes that share
      // no boolean guard: the runtime enters at most one of `try` and `catch`
      // per attempt, and `finally` is not gated by either. `RegionEdge` is what
      // lets the lowering treat this exactly like a guard or a loop -- an
      // ordinary `ScopeRef` the flow controller opens and closes -- instead of a
      // consumer re-deriving membership from source ranges, which is precisely
      // the anti-pattern `edges.ts`'s own header comment refuses.
      //
      // The try statement's own operation (`control.ts`'s `contributeTry`) is
      // not itself inside any of its three parts, so it is left ungated here --
      // `emit(node, gates)` above already tagged it with whatever scope this try
      // statement itself sits in, exactly as a loop's own header operation is
      // tagged with the scope surrounding the loop, not the scope inside it.
      if (ts.isTryStatement(node)) {
        const region = operationId(identities.nodeIdOf(node), 'control', 0)
        if (operations.has(region)) {
          visit(node.tryBlock, [...gates, { kind: 'region', region, part: 'try' }])
          if (node.catchClause) visit(node.catchClause, [...gates, { kind: 'region', region, part: 'catch' }])
          if (node.finallyBlock) visit(node.finallyBlock, [...gates, { kind: 'region', region, part: 'finally' }])
          return
        }
      }

      forEachEvaluationChild(node, (child) => visit(child, gates))
    }

    const walker: GateWalker = { visit, visitHere }
    walkers.set(key, walker)
    return walker
  }

  const root = walkerFor(rootSpecialization)
  for (const file of files) for (const statement of input.reachable.statementsOf(file)) root.visit(statement, [])
  return edges
}

interface HeadTestedLoop {
  readonly initializer: ts.Node | null
  readonly condition: ts.Expression | null
  readonly body: ts.Statement
  readonly incrementor: ts.Expression | null
}

/** A loop whose condition is evaluated before every iteration, including the first. */
const headTestedLoopOf = (node: ts.Node): HeadTestedLoop | null => {
  if (ts.isWhileStatement(node)) {
    return { initializer: null, condition: node.expression, body: node.statement, incrementor: null }
  }
  if (ts.isForStatement(node)) {
    return {
      initializer: node.initializer ?? null,
      condition: node.condition ?? null,
      body: node.statement,
      incrementor: node.incrementor ?? null
    }
  }
  return null
}

/**
 * The parts of an optional-chain link: what is evaluated before the presence
 * test, what the test is asked of, and what runs only when it passes.
 *
 * `null` for every other node, including a chain link with nothing inside its
 * brackets -- `a?.b` gates no subtree of its own, and the ordinary walk already
 * handles it.
 */
interface OptionalChainSubtree {
  readonly evaluated: ts.Node
  readonly guard: ts.Expression
  readonly gated: readonly ts.Node[]
}

const optionalChainSubtree = (node: ts.Node): OptionalChainSubtree | null => {
  if (ts.isCallExpression(node) && ts.isOptionalChain(node)) {
    const guard = optionalCallGuardOf(node)
    return guard ? { evaluated: node.expression, guard, gated: node.arguments } : null
  }
  if (ts.isElementAccessExpression(node) && ts.isOptionalChain(node)) {
    const guard = optionalChainGuardOf(node)
    return guard ? { evaluated: node.expression, guard, gated: [node.argumentExpression] } : null
  }
  return null
}

/**
 * The side a logical ASSIGNMENT evaluates its right operand -- and performs its
 * store -- on, or `null` when the operator is not one of the three.
 *
 * Separate from `shortCircuitTakenWhen` rather than folded into it: the two
 * answers happen to coincide, but the callers do different things with them
 * (one gates a subtree, the other also gates a store), and a single table
 * would let a plain `a || b` fall into the store-gating branch.
 */
const logicalAssignmentTakenWhen = (kind: ts.SyntaxKind): ConditionalEdge['takenWhen'] | null => {
  if (kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) return 'truthy'
  if (kind === ts.SyntaxKind.BarBarEqualsToken) return 'falsy'
  if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken) return 'nullish'
  return null
}

/** The side a short-circuit operator evaluates its right operand on, or `null` when it is not one. */
const shortCircuitTakenWhen = (kind: ts.SyntaxKind): ConditionalEdge['takenWhen'] | null => {
  if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return 'truthy'
  if (kind === ts.SyntaxKind.BarBarToken) return 'falsy'
  if (kind === ts.SyntaxKind.QuestionQuestionToken) return 'nullish'
  return null
}
