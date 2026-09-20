import ts from 'typescript'
import type { OperationId, SemanticResultId } from '../../../identity/ids.js'
import { operationId, semanticResultId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, pureEffects, type SemanticOperand } from '../../model/operands.js'
import type { BoundaryOperation, ComputationOperation, ControlOperation, SemanticOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import { familyOf, isFieldInitializerBody } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { contributePlainLoop, contributeTailTestedLoop } from './control-loops.js'
import { resolveExpressionOperand } from './boundary.js'
import type { IdentityTable } from '../identities.js'
import type { ProducerContext } from '../producer-context.js'
import { isDynamicIterationSource, mintIteratorSteps } from './protocol.js'
import { hasNativeEnumerationCursor, hasNativeIterationCursor, isGeneratorType, valueEdgesInto } from './shared.js'

/**
 * `if`/`for`/`for`-`of`/`for`-`in`/`while`/`do`/`switch`/`return`/`throw`/
 * `try`/`break`/`continue`/labelled statements, `await`, `yield`, `debugger`.
 *
 * The CFG facts this producer must get right, per the architecture doc's
 * governing rule (port ECMAScript semantics, not source shape):
 *
 * - `for`-`of` is `GetIterator`/`IteratorNext`/`IteratorClose`, never array
 *   indexing; `for`-`in` is the *different*, string-key-only enumerate
 *   protocol with no `IteratorClose` at all. Both delegate to
 *   `mintIteratorSteps` in `protocol.ts` so this file never re-implements a
 *   second, drifting copy of the iteration machinery.
 * - `try`/`catch`/`finally`: a `finally` can override whatever completion was
 *   pending, and a `return`/`throw`/`break`/`continue` written *inside* a
 *   `finally` block must not be flattened into an ordinary one -- it is what
 *   determines that override. `nearestInterceptingFinally`/`Handler` below
 *   implement the walk this requires directly from the language's own
 *   completion-routing rules, not from any name-keyed lookup.
 * - `await`/`yield` suspend the region; both carry `canSuspend: true` and pair
 *   with an auxiliary `'async-resume'`/`'generator-resume'` `BoundaryOperation`
 *   for where control re-enters, connected by a `completion: 'suspend'` edge.
 * - `break`/`continue` resolve their target by walking the enclosing syntax
 *   (the only way ECMAScript itself defines a label's binding) and then
 *   converting the *resolved node* to an identity via `operationId` -- never
 *   by keying a persistent map on the label's spelling.
 */

type FunctionLikeWithModifiers =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

const isFunctionLike = (node: ts.Node): node is FunctionLikeWithModifiers =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

const isFunctionBoundary = (node: ts.Node): boolean => isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)

const isIterationStatement = (node: ts.Node): node is ts.IterationStatement =>
  ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)

const isWithin = (node: ts.Node, ancestor: ts.Node): boolean => {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

const enclosingTryStatement = (node: ts.Node): ts.TryStatement | null => {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionBoundary(current)) return null
    if (ts.isTryStatement(current)) return current
    current = current.parent
  }
  return null
}

/**
 * The nearest enclosing `finally` that intercepts an abrupt completion
 * starting at `node`, or `null` if none does before the function boundary.
 *
 * A `finally` never intercepts a completion that originates *inside itself*
 * -- that would route a return-inside-finally back onto its own boundary
 * instead of past it -- so the walk skips a `TryStatement` whose
 * `finallyBlock` already contains `node` and keeps looking further out from
 * there. This is what keeps a `return` written inside a `finally` block from
 * being flattened into an ordinary, unremarkable return.
 */
const nearestInterceptingFinally = (node: ts.Node): ts.Block | null => {
  let current: ts.Node = node
  while (true) {
    const containingTry = enclosingTryStatement(current)
    if (!containingTry) return null
    const insideFinally = containingTry.finallyBlock !== undefined && isWithin(current, containingTry.finallyBlock)
    if (!insideFinally && containingTry.finallyBlock) return containingTry.finallyBlock
    current = containingTry
  }
}

type InterceptingHandler = { readonly kind: 'catch'; readonly node: ts.CatchClause } | { readonly kind: 'finally'; readonly node: ts.Block }

/**
 * The nearest enclosing `catch`/`finally` a `throw` at `node` is routed to.
 *
 * A throw inside a `tryBlock` goes to that try's own `catch` if it has one,
 * else its `finally` if it has one. A throw inside the `catch` clause itself
 * cannot re-target that same catch (there is no recursive self-handling), so
 * it looks only at that try's `finally`. A throw inside the `finally` skips
 * this try entirely -- symmetric with `nearestInterceptingFinally` above.
 */
const nearestInterceptingHandler = (node: ts.Node): InterceptingHandler | null => {
  let current: ts.Node = node
  while (true) {
    const containingTry = enclosingTryStatement(current)
    if (!containingTry) return null
    const insideFinally = containingTry.finallyBlock !== undefined && isWithin(current, containingTry.finallyBlock)
    const insideCatch = containingTry.catchClause !== undefined && isWithin(current, containingTry.catchClause)
    if (!insideFinally && !insideCatch) {
      if (containingTry.catchClause) return { kind: 'catch', node: containingTry.catchClause }
      if (containingTry.finallyBlock) return { kind: 'finally', node: containingTry.finallyBlock }
    } else if (insideCatch && containingTry.finallyBlock) {
      return { kind: 'finally', node: containingTry.finallyBlock }
    }
    current = containingTry
  }
}

const nearestLabeledStatement = (node: ts.Node, labelText: string): ts.LabeledStatement | null => {
  let current: ts.Node | undefined = node.parent
  while (current && !isFunctionBoundary(current)) {
    if (ts.isLabeledStatement(current) && current.label.text === labelText) return current
    current = current.parent
  }
  return null
}

/**
 * Where an unlabelled/labelled `break`/`continue` transfers control, resolved
 * entirely by walking the enclosing syntax that ECMAScript itself defines a
 * label's binding over, then converting the *resolved node* -- never the
 * label's spelling -- into an identity.
 */
const resolveBreakContinueTarget = (
  context: ProducerContext,
  node: ts.BreakOrContinueStatement,
  form: 'break' | 'continue'
): OperationId | null => {
  if (node.label) {
    const labeled = nearestLabeledStatement(node, node.label.text)
    if (!labeled) return null
    if (form === 'continue') {
      // `continue label` re-enters the labelled loop; it never targets the
      // generic label-target boundary below, which only marks "exit past
      // here" and is meaningless as a place to resume iterating from.
      return isIterationStatement(labeled.statement) ? operationId(context.identities.nodeIdOf(labeled.statement), 'control', 0) : null
    }
    // `break label` over a labelled iteration exits that iteration itself.
    // Naming the loop gives lowering its real exit block directly; a label is
    // not a second runtime control frame around the loop.
    if (isIterationStatement(labeled.statement)) return operationId(context.identities.nodeIdOf(labeled.statement), 'control', 0)
    return operationId(context.identities.nodeIdOf(labeled), 'boundary', 0)
  }
  let current: ts.Node | undefined = node.parent
  while (current && !isFunctionBoundary(current)) {
    if (form === 'continue' && isIterationStatement(current)) return operationId(context.identities.nodeIdOf(current), 'control', 0)
    if (form === 'break' && (isIterationStatement(current) || ts.isSwitchStatement(current))) {
      return operationId(context.identities.nodeIdOf(current), 'control', 0)
    }
    current = current.parent
  }
  return null
}

const blockedContribution = (candidate: CensusCandidate, reason: string): CandidateContribution => ({
  kind: 'blocked',
  blocker: blocked(candidate.id, 'control', reason, null)
})

const contributeBranch = (context: ProducerContext, candidate: CensusCandidate, node: ts.IfStatement): CandidateContribution => {
  const guard = resolveExpressionOperand(context, node.expression)
  if (!guard) return blockedContribution(candidate, 'no normalized operation identifies the if-condition value')
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'branch',
    caller: candidate.caller,
    operands: [operand('condition', 0, guard.source, guard.type)],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // Gating the then/else branch's own operations on this guard needs the
  // identities of whatever those branches contain, which this producer -- one
  // candidate at a time -- cannot see; no other producer file exposes a
  // census-to-operation index either. Recorded as a known gap, not modelled.
  return { kind: 'operations', operations: [operation], edges: [] }
}

const contributeForOfIn = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.ForOfStatement | ts.ForInStatement
): CandidateContribution => {
  const source = resolveExpressionOperand(context, node.expression)
  if (!source) return blockedContribution(candidate, 'no normalized operation identifies the for-of/for-in iterated expression value')

  const isForOf = ts.isForOfStatement(node)
  const isAwait = isForOf && node.awaitModifier !== undefined
  const protocol = isForOf ? (isAwait ? 'async-iterator' : 'iterator') : 'enumerate'
  // A sync `for`-`of` over a source whose iteration is settled before the
  // program runs never needs a dynamic `Symbol.iterator` lookup at all: a
  // plain `T[]` (ECMA-262 23.1.5), a `Set<T>` (24.2.3.10) and a `string`
  // (22.1.3.36) are each a fixed walk over storage already in hand, so this
  // loop lowers as an ordinary head-tested loop over a native
  // `gea::Iterator<T>` cursor (`runtime-helper-key.ts`'s
  // `protocol:iterator:*` claims, `publish.ts`'s
  // `nativeCursorIteratorOf`) instead of the general sync-iterator protocol.
  // `for`-`in` enumerates keys, a different protocol entirely, and `for await`
  // suspends per iteration, which the native cursor has no representation for
  // -- neither qualifies. A `Map` does not qualify either: see
  // `isNativeIterableSetType` for why its `[K, V]` pair has no cursor carrier.
  // `for`-`in` over a native key table takes the identical reshape: its two
  // steps are the same two, the cursor it walks is the same
  // `gea::Iterator<std::string>`, and the only difference is that the storage
  // being walked is the table's key list rather than its elements. A record,
  // a class instance and a named interface/type-alias reshape the identical
  // way, walking a compile-time field-name snapshot instead of a runtime
  // table -- see `hasNativeEnumerationCursor`'s own doc for which receivers
  // qualify and how the one genuinely unsafe sub-case (a host-bound named
  // type) stays caught, downstream, at preflight rather than here.
  const arrayFastPath = isForOf
    ? !isAwait && hasNativeIterationCursor(context, source.type)
    : hasNativeEnumerationCursor(context, source.type)
  const dynamicSource = isDynamicIterationSource(context, source.type)
  const nativeGeneratorSource = isForOf && !isAwait && isGeneratorType(context, source.type)
  // Every general synchronous iterator record needs IteratorClose routing.
  // Native array/string/set cursors keep their storage walk and are never
  // boxed; a typed custom iterable reaches the same protected region through
  // its concrete record carrier, while a genuinely dynamic source keeps its
  // Value carrier.
  const steps = mintIteratorSteps(
    context,
    candidate,
    protocol,
    { ...source, iterated: node.expression },
    {
      includeGetMethod: !arrayFastPath && isForOf && !dynamicSource,
      includeClose: isForOf && !isAwait && (!arrayFastPath || nativeGeneratorSource)
    }
  )

  const id = mintOperationId(context.ordinals, candidate.id, 'control')

  // Every shape but `for await`-`of` reshapes into an ordinary head-tested
  // loop -- the array/enumeration fast path exactly as before, and now the
  // sync general dynamic-protocol path too (a source neither
  // `hasNativeIterationCursor` nor `hasNativeEnumerationCursor` claims a
  // native cursor for): a `'condition'` operand instead of `'iterator-record'`
  // makes the loop structurally indistinguishable, to every downstream
  // generic consumer (`lower-graph.ts`'s guard detection, `lowerControl`'s
  // 'loop' case, `lower-flow.ts`'s back-edge logic), from a plain
  // `while`/counted `for` -- none of those files need to know this loop is
  // iterator-driven, or which of the two protocol shapes drives it.
  // `lower-protocol.ts`'s `lowerProtocol` already lowers `get-iterator` and
  // `next` (value and done) generically for both -- native cursor and real
  // dynamic dispatch alike -- so nothing downstream of this reshape needed
  // to change for the general case to start working; this producer was the
  // one holdout still building the un-lowerable `iterator-record` shape for
  // it. `for await`-`of` alone stays excluded: its `next` can suspend
  // (`canSuspend: protocol === 'async-iterator'`, `protocol.ts`), and this
  // reshape says nothing about how a condition re-tested every iteration
  // interacts with a suspension point -- that question is exactly as
  // unanswered as it was before this change, so it stays the one shape this
  // function still refuses by name, below.
  // `for await`-`of` reshapes identically, and the suspension question that
  // once excluded it is answered rather than dodged: `gea::Promise<V>` is a
  // settled-value box with no job queue, so every `await` this compiler emits
  // is a synchronous read and an async `next()` hands back an already-settled
  // result. There is no suspension point for a re-tested condition to interact
  // WITH. The step still carries `canSuspend` (`protocol.ts`) because that
  // states what the LANGUAGE does, which stays true; what changed is that this
  // runtime's own answer to it is now written down instead of treated as
  // unknown. A port that grows a real job queue must revisit this together
  // with `await`, `Promise::then` and the async-generator `yield` -- all four
  // rest on the one fact, and none of them is separable from the others.
  {
    // The condition is `!done`, recomputed every iteration from `next`'s own
    // 'completion' result. None of get-iterator/next/this negation has a
    // source `ts.Node` of its own, so `gating.ts` gates them by directly
    // reconstructing their fixed operation ids rather than by visiting one.
    // For the sync general path (unlike the fast path) `get-method` is also
    // minted, at protocol ordinal 0 -- `gating.ts`'s own reconstruction does
    // not yet gate that ordinal at all, having only ever needed to gate
    // ordinals 1 (get-iterator) and 2 (next) for the fast path, where
    // ordinal 0 is reserved but never minted. Whether that gap is load-
    // bearing here -- whether an operation this pass never places under any
    // gate still lands in the correct, once-per-loop scope by construction,
    // via its own evaluation edge into get-iterator -- is exactly what
    // landing this reshape on its own is meant to measure, before anyone
    // opens `gating.ts` to widen it.
    const boolType = context.table.intern({ kind: 'primitive', primitive: 'boolean' })
    const negationId = mintOperationId(context.ordinals, candidate.id, 'computation')
    const negationOperand = operand(
      'operand',
      0,
      { kind: 'result', result: semanticResultId(steps.nextOperationId, 'completion') },
      boolType
    )
    const negation: ComputationOperation = {
      id: negationId,
      family: 'computation',
      caller: candidate.caller,
      form: 'unary',
      operator: '!',
      operands: [negationOperand],
      results: [mintResult(negationId, 'value', boolType)],
      completion: normalCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    const loopOperation: ControlOperation = {
      family: 'control',
      id,
      form: 'loop',
      iteratorClose: steps.closeOperationId,
      caller: candidate.caller,
      operands: [operand('condition', 0, { kind: 'result', result: semanticResultId(negationId, 'value') }, boolType)],
      results: [],
      completion: normalCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    const edges: SemanticEdge[] = [
      ...steps.edges,
      { kind: 'evaluation', from: steps.nextOperationId, to: negationId },
      ...valueEdgesInto(negationId, [negationOperand]),
      { kind: 'evaluation', from: negationId, to: id }
    ]
    return { kind: 'operations', operations: [...steps.operations, negation, loopOperation], edges }
  }
}

/**
 * The test one `case` clause performs, named the way every cross-file citation
 * in this compiler is: recomputed from the clause's own node, never looked up.
 *
 * `gating.ts` needs it to gate the clause's statements, and `contributeSwitch`
 * mints it. Neither may guess at the other's spelling.
 */
export const citeSwitchCaseTest = (clause: ts.CaseClause, identities: IdentityTable): SemanticResultId =>
  semanticResultId(operationId(identities.nodeIdOf(clause), 'computation', 0), 'value')

/**
 * The test a GROUP of clauses performs, for the second and later members of one.
 *
 * `case A: case B: body` is one guarded arm whose test is `A || B`, and
 * `contributeSwitch` mints that disjunction as a second computation on the
 * clause that closes it -- ordinal 1, beside the clause's own equality at
 * ordinal 0. A group of one has no disjunction to name; its guard is
 * `citeSwitchCaseTest` above.
 */
export const citeSwitchGroupTest = (clause: ts.CaseClause, identities: IdentityTable): SemanticResultId =>
  semanticResultId(operationId(identities.nodeIdOf(clause), 'computation', 1), 'value')

/**
 * A sufficient proof that evaluation cannot produce a normal completion.
 * ECMA-262 (2025), StatementList and IfStatement evaluation: a block passes
 * through its final completion, and an if can complete normally if either arm
 * can. Unknown forms stay unproven; in particular a nested loop can consume a
 * break, and a finally can override a pending return.
 *
 * Switch guard chains need this completion fact, not the spelling of the final
 * statement. A block wrapping a return and an if whose arms both return cannot
 * fall through any more than a bare return can.
 */
const alwaysAbrupt = (statement: ts.Statement | undefined): boolean => {
  if (!statement) return false
  if (ts.isBlock(statement)) return alwaysAbrupt(statement.statements[statement.statements.length - 1])
  if (ts.isIfStatement(statement)) return alwaysAbrupt(statement.thenStatement) && alwaysAbrupt(statement.elseStatement)
  return (
    ts.isBreakStatement(statement) || ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isContinueStatement(statement)
  )
}

/**
 * Whether a clause cannot complete normally -- so control never falls out of
 * its bottom into the next clause. Asked here to mint the guards and in
 * `gating.ts` to place the bodies, ONE answer for both.
 */
export const clauseTerminates = (clause: ts.CaseOrDefaultClause): boolean => alwaysAbrupt(clause.statements[clause.statements.length - 1])

const contributeSwitch = (context: ProducerContext, candidate: CensusCandidate, node: ts.SwitchStatement): CandidateContribution => {
  const discriminant = resolveExpressionOperand(context, node.expression)
  if (!discriminant) return blockedContribution(candidate, 'no normalized operation identifies the switch discriminant value')
  const clauses = node.caseBlock.clauses
  // A `default` written anywhere but last is legal and means something this
  // chain cannot say: the language tries every `case` first and only then falls
  // back, while a guard chain would take the default's arm the moment it is
  // reached. Refused rather than reordered -- moving it would change which
  // clause a fall-through reaches.
  const defaultIndex = clauses.findIndex((clause) => ts.isDefaultClause(clause))
  if (defaultIndex >= 0 && defaultIndex !== clauses.length - 1) {
    return blockedContribution(candidate, 'a switch whose `default` clause is not the last one has no guard-chain form')
  }
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'switch',
    caller: candidate.caller,
    operands: [operand('discriminant', 0, discriminant.source, discriminant.type)],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // One strict-equality test per `case`, keyed on the clause's own node so
  // `gating.ts` can name it without this producer publishing an index. Strict
  // by the specification: `CaseClauseIsSelected` is `IsStrictlyEqual`, so this
  // is the identical operation `===` mints and it can neither coerce nor throw.
  const operations: SemanticOperation[] = [operation]
  const edges: SemanticEdge[] = []
  const booleanType = context.table.intern({ kind: 'primitive', primitive: 'boolean' })
  // The guard a run of empty clauses has accumulated so far, or `null` outside
  // one. An empty clause continues its group; a clause with statements closes
  // it, and the next one starts a new group of its own.
  let running: SemanticResultId | null = null
  for (const clause of clauses) {
    if (!ts.isCaseClause(clause)) {
      running = null
      continue
    }
    const tested = resolveExpressionOperand(context, clause.expression)
    if (!tested) return blockedContribution(candidate, 'no normalized operation identifies a switch case expression')
    const testId = operationId(context.identities.nodeIdOf(clause), 'computation', 0)
    const operands: SemanticOperand[] = [
      operand('left', 0, discriminant.source, discriminant.type),
      operand('right', 0, tested.source, tested.type)
    ]
    operations.push({
      id: testId,
      family: 'computation',
      caller: candidate.caller,
      form: 'equality',
      operator: '===',
      operands,
      results: [mintResult(testId, 'value', booleanType)],
      completion: normalCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    })
    edges.push(...valueEdgesInto(testId, operands))
    let guard = semanticResultId(testId, 'value')
    if (running !== null) {
      // CaseClauseIsSelected stops at the first match. Gate the next label
      // and equality on the accumulated guard's falsy arm, then join exactly
      // as source-level || does. This preserves accessor/call effects and TDZ
      // errors without trying to classify a label as safe to evaluate eagerly.
      const foldId = operationId(context.identities.nodeIdOf(clause), 'computation', 1)
      const foldOperands: SemanticOperand[] = [
        operand('left', 0, { kind: 'result', result: running }, booleanType),
        operand('right', 0, { kind: 'result', result: guard }, booleanType)
      ]
      operations.push({
        id: foldId,
        family: 'computation',
        caller: candidate.caller,
        form: 'logical',
        operator: '||',
        operands: foldOperands,
        results: [mintResult(foldId, 'value', booleanType)],
        completion: normalCompletion,
        effects: pureEffects,
        evaluationOrdinal: candidate.evaluationOrdinal
      })
      edges.push(...valueEdgesInto(foldId, foldOperands))
      guard = semanticResultId(foldId, 'value')
    }
    // A clause that can FALL THROUGH hands its guard to the next clause the
    // way an empty one does: `case A: body; case B: more` runs `more` when
    // `A` held and `body` completed normally, or when `B` held -- the very
    // `A || B` disjunction the fold above mints, with `body` placed on the
    // guard's own arm by `gating.ts` and a `break` inside it jumping to the
    // switch's exit (`ir/lower-flow.ts`'s `switchExitOf`) past everything
    // the disjunction would otherwise run. Falling into `default` needs no
    // fold at all: the default's own gate is "no test on the chain held", and
    // a guard handed forward is exactly one not on the chain.
    running = clause.statements.length === 0 || !clauseTerminates(clause) ? guard : null
  }
  return { kind: 'operations', operations, edges }
}

const contributeReturn = (context: ProducerContext, candidate: CensusCandidate, node: ts.ReturnStatement): CandidateContribution => {
  let valueOperand: SemanticOperand
  if (node.expression) {
    const resolved = resolveExpressionOperand(context, node.expression)
    if (!resolved) return blockedContribution(candidate, 'no normalized operation identifies the returned value')
    valueOperand = operand('value', 0, resolved.source, resolved.type)
  } else {
    const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })
    valueOperand = operand('value', 0, { kind: 'absent' }, undefinedType)
  }
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'return',
    caller: candidate.caller,
    operands: [valueOperand],
    results: [mintResult(id, 'completion', valueOperand.type)],
    completion: { canThrow: false, canReturn: true, canBreak: false, canContinue: false, canSuspend: false },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const edges: SemanticEdge[] = []
  const finallyBlock = nearestInterceptingFinally(node)
  if (finallyBlock) {
    edges.push({
      kind: 'completion',
      from: id,
      to: operationId(context.identities.nodeIdOf(finallyBlock), 'boundary', 0),
      completion: 'return'
    })
  }
  return { kind: 'operations', operations: [operation], edges }
}

/**
 * The return an arrow function's expression body performs.
 *
 * There is no `ReturnStatement` here to normalize: `EvaluateBody` for an
 * `ExpressionBody` *is* a return, so the operation belongs to the body
 * expression's node under the control family, alongside the operation its own
 * family publishes for the value. Leaving it out gives an arrow function that
 * evaluates its body and then returns nothing -- a wrong answer that no later
 * layer can see, because a body with no return looks exactly like a body that
 * completes normally.
 */
const contributeImplicitReturn = (context: ProducerContext, candidate: CensusCandidate, node: ts.Expression): CandidateContribution => {
  const resolved = resolveExpressionOperand(context, node)
  if (!resolved) return blockedContribution(candidate, 'no normalized operation identifies the value an arrow function body returns')
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'return',
    caller: candidate.caller,
    operands: [operand('value', 0, resolved.source, resolved.type)],
    results: [mintResult(id, 'completion', resolved.type)],
    completion: { canThrow: false, canReturn: true, canBreak: false, canContinue: false, canSuspend: false },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // Neither a concise body nor a field initializer can sit inside a `try`, so
  // no `finally` can intercept this return: the expression is the whole body.
  return { kind: 'operations', operations: [operation], edges: [] }
}

const contributeThrow = (context: ProducerContext, candidate: CensusCandidate, node: ts.ThrowStatement): CandidateContribution => {
  const resolved = resolveExpressionOperand(context, node.expression)
  if (!resolved) return blockedContribution(candidate, 'no normalized operation identifies the thrown value')
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'throw',
    caller: candidate.caller,
    operands: [operand('value', 0, resolved.source, resolved.type)],
    results: [mintResult(id, 'completion', resolved.type)],
    completion: { canThrow: true, canReturn: false, canBreak: false, canContinue: false, canSuspend: false },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const edges: SemanticEdge[] = []
  const handler = nearestInterceptingHandler(node)
  if (handler) {
    const target = operationId(context.identities.nodeIdOf(handler.node), 'boundary', 0)
    edges.push({ kind: 'completion', from: id, to: target, completion: 'throw' })
  }
  return { kind: 'operations', operations: [operation], edges }
}

const contributeBreakOrContinue = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.BreakOrContinueStatement,
  form: 'break' | 'continue'
): CandidateContribution => {
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  // `break`/`continue` carry no value -- ECMA-262's own completion record has
  // an empty `[[Value]]` for both -- but every downstream consumer that must
  // cite a `SemanticResultId` (the abrupt-edge obligation, the IR jump's own
  // lineage) needs one to point at. An empty `results: []` starved both:
  // `requireLineage` threw before the jump could be built at all, and
  // `buildAbruptEdgeObligations`'s own `primaryResultOf` guard silently
  // skipped the obligation instead of raising it, so a program using
  // `break`/`continue` certified clean while never lowering the exit. The
  // `void`-typed completion result mirrors the `try` control operation just
  // below, which anchors the same way for the same reason and is likewise
  // never materialized as an IR value.
  const voidType = context.table.intern({ kind: 'primitive', primitive: 'void' })
  const operation: ControlOperation = {
    family: 'control',
    id,
    form,
    caller: candidate.caller,
    operands: [],
    results: [mintResult(id, 'completion', voidType)],
    completion: {
      canThrow: false,
      canReturn: false,
      canBreak: form === 'break',
      canContinue: form === 'continue',
      canSuspend: false
    },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // An intercepting `finally` always wins first: any abrupt completion passing
  // through a try-with-finally, `break`/`continue` included, must be given
  // the chance to be overridden before it reaches its ordinary target.
  const finallyBlock = nearestInterceptingFinally(node)
  if (finallyBlock) {
    const to = operationId(context.identities.nodeIdOf(finallyBlock), 'boundary', 0)
    return { kind: 'operations', operations: [operation], edges: [{ kind: 'completion', from: id, to, completion: form }] }
  }
  const target = resolveBreakContinueTarget(context, node, form)
  if (!target) return blockedContribution(candidate, `no ${form} target could be resolved; program may not type-check`)
  return { kind: 'operations', operations: [operation], edges: [{ kind: 'completion', from: id, to: target, completion: form }] }
}

const contributeLabeled = (context: ProducerContext, candidate: CensusCandidate, node: ts.LabeledStatement): CandidateContribution => {
  const controlId = mintOperationId(context.ordinals, candidate.id, 'control')
  const controlOperation: ControlOperation = {
    family: 'control',
    id: controlId,
    form: 'label',
    caller: candidate.caller,
    operands: [],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // The label-target boundary is a separate operation from the `'label'`
  // control operation above: the former is what `break label;` completion
  // edges actually point at (`resolveBreakContinueTarget`), the latter is the
  // labelled statement's own structural presence in the CFG.
  const targetId = mintOperationId(context.ordinals, candidate.id, 'boundary')
  const targetOperation: BoundaryOperation = {
    family: 'boundary',
    id: targetId,
    boundary: 'label-target',
    caller: candidate.caller,
    operands: [],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const edges: SemanticEdge[] = []
  const bodyFamily = familyOf(node.statement, context.namespacePaths)
  if (bodyFamily) {
    edges.push({ kind: 'evaluation', from: controlId, to: operationId(context.identities.nodeIdOf(node.statement), bodyFamily, 0) })
  }
  return { kind: 'operations', operations: [controlOperation, targetOperation], edges }
}

const contributeTry = (context: ProducerContext, candidate: CensusCandidate, node: ts.TryStatement): CandidateContribution => {
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const voidType = context.table.intern({ kind: 'primitive', primitive: 'void' })
  const tryOperation: ControlOperation = {
    family: 'control',
    id,
    form: 'try',
    caller: candidate.caller,
    operands: [],
    results: [mintResult(id, 'completion', voidType)],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const operations: (ControlOperation | BoundaryOperation)[] = [tryOperation]
  const edges: SemanticEdge[] = []

  // Exception routing *into* `catch` is not wired here: each throwing
  // operation inside the try/catch block resolves its own nearest handler via
  // `nearestInterceptingHandler`, because attributing that edge to the `try`
  // operation itself would be false -- the try construct does not itself
  // throw, only the operations nested inside it can. What *is* owed here is
  // the unconditional normal-completion sequencing into `finally`, which runs
  // after try/catch regardless of how either one completes.
  if (node.finallyBlock) {
    const finallyId = operationId(context.identities.nodeIdOf(node.finallyBlock), 'boundary', 0)
    edges.push({ kind: 'evaluation', from: id, to: finallyId })
    if (node.catchClause) {
      const catchId = operationId(context.identities.nodeIdOf(node.catchClause), 'boundary', 0)
      edges.push({ kind: 'evaluation', from: catchId, to: finallyId })
    }
    const finallyOperation: BoundaryOperation = {
      family: 'boundary',
      id: finallyId,
      boundary: 'finally-region',
      caller: candidate.caller,
      operands: [],
      results: [],
      completion: normalCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    operations.push(finallyOperation)
  }
  return { kind: 'operations', operations, edges }
}

const contributeAwait = (context: ProducerContext, candidate: CensusCandidate, node: ts.AwaitExpression): CandidateContribution => {
  const operand_ = resolveExpressionOperand(context, node.expression)
  if (!operand_) return blockedContribution(candidate, 'no normalized operation identifies the awaited value')
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  // The checker already unwraps `Promise<T>` to `T` for the await expression's
  // own type; publishing that is the resolved value, never a fabricated shape.
  const resolvedType = context.types.typeAt(node)
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'await',
    caller: candidate.caller,
    operands: [operand('operand', 0, operand_.source, operand_.type)],
    results: [mintResult(id, 'value', resolvedType)],
    completion: { canThrow: true, canReturn: false, canBreak: false, canContinue: false, canSuspend: true },
    effects: { ...pureEffects, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const resumeId = mintOperationId(context.ordinals, candidate.id, 'boundary')
  const resumeOperation: BoundaryOperation = {
    family: 'boundary',
    id: resumeId,
    boundary: 'async-resume',
    caller: candidate.caller,
    operands: [],
    results: [mintResult(resumeId, 'value', resolvedType)],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return {
    kind: 'operations',
    operations: [operation, resumeOperation],
    edges: [{ kind: 'completion', from: id, to: resumeId, completion: 'suspend' }]
  }
}

const contributeYield = (context: ProducerContext, candidate: CensusCandidate, node: ts.YieldExpression): CandidateContribution => {
  // `context.types.typeAt(node)` is the checker's type of the YIELD
  // EXPRESSION ITSELF -- ECMA-262 makes that the RESUME channel (what a
  // later `.next(v)` sends back in, 27.5.3.2), not the value handed out. This
  // IS what a consumer of the expression's own value gets (a `const x = yield
  // 1` binds `x` to this, never to what was yielded out) -- so it is what the
  // operation's own `'value'` result is minted with below, exactly the way
  // `contributeAwait`'s suspend operation publishes the resumed value as its
  // own result. A generator with no explicit `Generator<Y, R, N>` annotation
  // leaves this `unknown`/`any`, which `representation/derive.ts` collapses
  // to the cursor's honest "stores nothing" carrier rather than boxing it
  // (see that file's `GeneratorDeclarationPolicy`) -- a read of `x` in such a
  // program refuses downstream, by name, at emission, never here.
  const resumeType = context.types.typeAt(node)
  const operands: SemanticOperand[] = []
  const auxiliaryOperations: SemanticOperation[] = []
  const auxiliaryEdges: SemanticEdge[] = []

  if (node.asteriskToken) {
    if (!node.expression) return blockedContribution(candidate, 'yield* with no delegated expression is not valid syntax to model')
    const source = resolveExpressionOperand(context, node.expression)
    if (!source) return blockedContribution(candidate, 'no normalized operation identifies the yield* delegated expression value')
    // `yield*` is refused here rather than modelled and refused later. ECMA-262
    // 27.5.3.7 makes delegation a LOOP -- pull a step from the inner iterator,
    // yield it, repeat, forwarding `return`/`throw` -- and this expression
    // position cannot hold a loop, for the same reason a spread's own drain
    // cannot be built in one (`producers/protocol.ts`'s bypass comment). The
    // steps below were being minted and then never lowered, so the program
    // certified against `protocol:iterator:*` keys nothing consumed.
    return blockedContribution(
      candidate,
      'yield* delegates to another iterator, which is a loop over its steps; this expression position has no loop to build one in'
    )
  } else if (node.expression) {
    const resolved = resolveExpressionOperand(context, node.expression)
    if (!resolved) return blockedContribution(candidate, 'no normalized operation identifies the yielded value')
    // The generator's own element type is a WRITE SET across every `yield`
    // in its body, exactly as `return-bindings.ts` treats every `return`:
    // what this OPERAND contributes is the YIELDED value's type, never the
    // resume channel's -- that is the operation's own RESULT, minted below.
    operands.push(operand('value', 0, resolved.source, resolved.type))
  }
  // A bare `yield;` yields `undefined` (the same fallback `contributeReturn`
  // uses for a bare `return;`) and needs no operand at all: `emit.ts`'s
  // `emitYield` already refuses a null operand rather than inventing one, so
  // nothing here has to intern a placeholder type for it.

  // ECMAScript's `yield` is an EXPRESSION: its value is what the NEXT
  // `next(v)` sends in (ECMA-262 27.5.3.2). This backend's cursor
  // (`gea::Iterator<E, TReturn, TNext>`, runtime/gea_runtime.h) carries a real
  // resume channel now -- `co_yield`'s own awaiter hands back whatever
  // `next(v)`/an abrupt `.return`/`.throw` injected -- so a `yield` whose own
  // value is read is MODELLED here regardless of parent syntax; whether it
  // can actually be RENDERED depends on whether `TNext` resolved to a native
  // carrier for this generator, which `targets/cpp/emit.ts`'s `emitYield`
  // checks and refuses by name if not.
  // An `async function*` yield is ECMA-262 27.6.3.8 AsyncGeneratorYield: it
  // AWAITS the yielded value, then suspends on a queue of pending `next`
  // promises. Both halves are already no-ops in THIS runtime's async model,
  // which is why the shape is rendered as the synchronous yield rather than
  // refused.
  //
  // `gea::Promise<V>` is a settled-value box with no job queue, so every
  // `await` this compiler emits is a synchronous read of an already-computed
  // value and an async function's entire body has run to completion by the
  // time it returns (`runtime/gea_runtime.h`, `Promise<V>`'s own class
  // comment, and `Promise<V>::then`, which runs its callback immediately for
  // the same reason). Under that model AsyncGeneratorYield's await is the
  // identity, and the pending-`next` queue can never have more than the one
  // caller standing at the suspension point -- so an async generator is
  // exactly a synchronous cursor whose element is the awaited yielded type.
  //
  // This is the SAME documented deviation the runtime already ships and the
  // shipping engine already makes (`gea::host::CameraPhotoPromise::then` is
  // literally `return onResolved(photo)`); it is not a new one taken here. A
  // port that grows a real job queue must revisit this together with `await`
  // and `then`, not on its own -- all three rest on the one fact.
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  // A `yield` written as a whole statement discards its value by definition
  // (ECMAScript never lets an ExpressionStatement's completion be observed),
  // so this mints a `void` result for that shape -- present for `requireLineage`
  // to anchor on (every operation needs one), but `void` is the one
  // representation `ir/build.ts`'s `mintOptionalResult` never turns into an
  // actual IR value, so nothing downstream ever asks this generator for a
  // resume channel it does not use. That matters beyond tidiness: `resumeType`
  // is the checker's type of the yield EXPRESSION, which for the
  // overwhelmingly common unannotated generator is `unknown` -- a real,
  // boxable `dynamic` carrier, not `undefined` -- and minting a result typed
  // with it here would make a completely ordinary discarded `yield x;` start
  // demanding a resume channel this generator never uses, in every program
  // that yields at all. Every other position (bound to a variable, part of a
  // larger expression) really does consume the value, and mints `resumeType`
  // instead -- `targets/cpp/emit.ts`'s `emitYield` is what refuses it, by
  // name, if `TNext` never resolved to a native carrier for this generator.
  const discardedType = context.table.intern({ kind: 'primitive', primitive: 'void' })
  const results = [mintResult(id, 'value', ts.isExpressionStatement(node.parent) ? discardedType : resumeType)]
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'yield',
    caller: candidate.caller,
    operands,
    results,
    // `yield` can itself throw the value a `generator.throw()` injects, unlike
    // `await`, which only ever resumes with a resolved value or a rejection
    // surfacing at the same site -- this is a real capability, not symmetry
    // for its own sake.
    completion: { canThrow: true, canReturn: false, canBreak: false, canContinue: false, canSuspend: true },
    effects: { ...pureEffects, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const resumeId = mintOperationId(context.ordinals, candidate.id, 'boundary')
  const resumeOperation: BoundaryOperation = {
    family: 'boundary',
    id: resumeId,
    boundary: 'generator-resume',
    caller: candidate.caller,
    operands: [],
    results: [mintResult(resumeId, 'value', resumeType), mintResult(resumeId, 'completion', resumeType)],
    // `generator.throw()`/`.return()` make the resume itself abrupt; `.next()`
    // makes it the ordinary value case captured by the `'value'` result above.
    completion: { canThrow: true, canReturn: true, canBreak: false, canContinue: false, canSuspend: false },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return {
    kind: 'operations',
    operations: [...auxiliaryOperations, operation, resumeOperation],
    edges: [...auxiliaryEdges, { kind: 'completion', from: id, to: resumeId, completion: 'suspend' }]
  }
}

/**
 * The return an arrow's concise body performs when that body is itself
 * `await x` or `yield x`.
 *
 * `familiesOf` (`census.ts`) censuses such a node under `'control'` only --
 * publishing a second, colliding operation at the same identity is refused
 * there -- so this one candidate has to produce everything the body needs:
 * the suspend/resume operations `contributeAwait`/`contributeYield` already
 * build, plus the implicit return every other concise body gets from
 * `contributeImplicitReturn`. That function cannot serve this case: it
 * resolves its operand through `resolveExpressionOperand`, which for this
 * node would recompute this exact candidate's own identity and find nothing
 * published there yet -- a self-citation, not a forward reference, because
 * the suspend operation this return needs to cite is minted right here,
 * never independently. The value operand is built directly from the
 * operation just minted instead.
 */
const contributeConciseSuspendReturn = (
  context: ProducerContext,
  candidate: CensusCandidate,
  node: ts.AwaitExpression | ts.YieldExpression
): CandidateContribution => {
  const suspended = ts.isAwaitExpression(node) ? contributeAwait(context, candidate, node) : contributeYield(context, candidate, node)
  if (suspended.kind !== 'operations') return suspended
  const suspend = suspended.operations.find(
    (op): op is ControlOperation => op.family === 'control' && (op.form === 'await' || op.form === 'yield')
  )
  const value = suspend?.results.find((result) => result.role === 'value')
  if (!suspend || !value)
    return blockedContribution(candidate, 'a concise arrow body suspend published no value result for its implicit return')
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'return',
    caller: candidate.caller,
    operands: [operand('value', 0, { kind: 'result', result: value.id }, value.type)],
    results: [mintResult(id, 'completion', value.type)],
    completion: { canThrow: false, canReturn: true, canBreak: false, canContinue: false, canSuspend: false },
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  // As `contributeImplicitReturn` notes: neither a concise body nor a field
  // initializer can sit inside a `try`, so no `finally` can intercept this.
  return { kind: 'operations', operations: [...suspended.operations, operation], edges: suspended.edges }
}

const contributeDebugger = (candidate: CensusCandidate, context: ProducerContext): CandidateContribution => {
  const id = mintOperationId(context.ordinals, candidate.id, 'control')
  const operation: ControlOperation = {
    family: 'control',
    id,
    form: 'debugger',
    caller: candidate.caller,
    operands: [],
    results: [],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

export const createControlProducer = (context: ProducerContext): FamilyProducer => {
  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node
    // Checked first: these nodes are censused under the control family *in
    // addition to* their own, so dispatching on syntax kind would route them to
    // whichever statement form happened to match and lose the return entirely.
    if (node.parent && ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node)) {
      // `await x`/`yield x` as the whole body is the one concise-body shape
      // that is *already* `'control'` family on its own: routing it through
      // `contributeImplicitReturn` the way every other concise body goes
      // would have it resolve its own not-yet-published identity. See
      // `contributeConciseSuspendReturn`'s own comment.
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
        return contributeConciseSuspendReturn(context, candidate, node)
      }
      return contributeImplicitReturn(context, candidate, node as ts.Expression)
    }
    if (isFieldInitializerBody(node)) return contributeImplicitReturn(context, candidate, node as ts.Expression)
    if (ts.isIfStatement(node)) return contributeBranch(context, candidate, node)
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return contributeForOfIn(context, candidate, node)
    if (ts.isForStatement(node)) return contributePlainLoop(context, candidate, node.condition)
    if (ts.isWhileStatement(node)) return contributePlainLoop(context, candidate, node.expression)
    if (ts.isDoStatement(node)) return contributeTailTestedLoop(context, candidate, node.expression)
    if (ts.isSwitchStatement(node)) return contributeSwitch(context, candidate, node)
    if (ts.isReturnStatement(node)) return contributeReturn(context, candidate, node)
    if (ts.isThrowStatement(node)) return contributeThrow(context, candidate, node)
    if (ts.isTryStatement(node)) return contributeTry(context, candidate, node)
    if (ts.isBreakOrContinueStatement(node)) {
      return contributeBreakOrContinue(context, candidate, node, ts.isBreakStatement(node) ? 'break' : 'continue')
    }
    if (ts.isLabeledStatement(node)) return contributeLabeled(context, candidate, node)
    if (ts.isAwaitExpression(node)) return contributeAwait(context, candidate, node)
    if (ts.isYieldExpression(node)) return contributeYield(context, candidate, node)
    if (node.kind === ts.SyntaxKind.DebuggerStatement) return contributeDebugger(candidate, context)
    return blockedContribution(candidate, 'control census produced a syntax kind this producer does not model')
  }

  return { family: 'control', contribute }
}
