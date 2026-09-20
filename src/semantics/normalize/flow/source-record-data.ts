import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import { nodePathToken } from './node-path-token.js'
import { arrayStoredValuesOf } from './array-element-continuation.js'
import { collectionStoredValuesOf } from './collection-value-continuation.js'
import { isVacuousOrigin, seededOriginSolver, type SeededOriginNode } from './seeded-origins.js'
import { isStandardInterfaceType } from '../derived-expression-type.js'
import { objectLiteralEntryKeyOf, recordAllocationAliasesClosed } from './record-alias-closure.js'
import { callableCompletionValuesOf, constructionYieldsCompletionOf } from './callable-completions.js'
import { resolveFlowSymbolAlias } from './targets.js'
import { originAuthorityIdentity, type OriginAuthority } from './origin-authority.js'
import { enterHypothesisGuard, exitHypothesisGuard, noteHypothesis } from './proof-hypotheses.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'

export interface SourceRecordDataWritePlan {
  /** Every allocation whose descriptors and publications the caller must close. */
  readonly roots: readonly ts.ObjectLiteralExpression[]
  /** Missing own slots additionally depend on the intrinsic Object prototype. */
  readonly needsDefaultPrototype: boolean
  /** Deferred protocol obligations discovered while following cached origins. */
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

/** @semanticCategory generic-primitive */
export type { SourceRecordOriginAuthority } from './origin-authority.js'

/** A source callable a record slot can hold, independent of completion support. */
export type RecordMethodTarget = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
export { callableCompletionValuesOf }

// `GEA_INVOCATION_REFUSALS` names why `recordMethodCallTargetsOf` and the
// write-plan it depends on returned null -- the same env var and message
// shape as `invocationRefusal` in `callable-reach.ts`, so a single run names
// both the member-dispatch refusal and the record-authority refusal behind
// it instead of only the outer one. Read once at load for the same reason
// `callable-reach.ts` reads its own flags once: this runs per uncached query,
// potentially millions of times on a whole-program run.
const recordRefusalDebug = process.env['GEA_INVOCATION_REFUSALS'] !== undefined
const describeNode = (node: ts.Node): string => {
  const file = node.getSourceFile()
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
  return `${file.fileName.split('/').pop()}:${line + 1} ${node.getText(file).replace(/\s+/g, ' ').slice(0, 80)}`
}
/**
 * `reason` is a THUNK because the guard below only reads it when the env var
 * is set, while JavaScript evaluates a plain argument eagerly: every template
 * literal at a call site was being built and thrown away on every refusal.
 * This path refuses on the large majority of asks and runs millions of times
 * in a whole-program compile, so those were millions of discarded strings --
 * a live three.js profile charged `sourceRecordDataWritePlanOf` 28.2% of self
 * time with garbage collection at 16% right behind it.
 */
const recordRefusal = (node: ts.Node, reason: () => string): null => {
  if (recordRefusalDebug) console.error(`[INVOCATION-REFUSAL] ${reason()} :: ${describeNode(node)}`)
  return null
}

// `GEA_ORIGINS_DEBUG=<text>|'*'` names which arm of the record write-plan's
// origin walk refuses -- the same flag and shape `member-call-forwarding.ts`
// and `callable-reach.ts`'s `parameterValuesOf` already read, extended to a
// third walk over the same question ("what can this cell hold") so a single
// run explains a refusal that crosses all three rather than stopping at
// whichever one happened to be instrumented already.
const watchedRecordOrigins = process.env['GEA_ORIGINS_DEBUG']
const refuseWritePlanOrigin = (node: ts.Node, reason: string): void => {
  if (watchedRecordOrigins === undefined) return
  const text = node.getText().slice(0, 60).replace(/\s+/g, ' ')
  if (watchedRecordOrigins !== '*' && !text.includes(watchedRecordOrigins)) return
  const file = node.getSourceFile()
  console.error(
    `[RECORD-PLAN-ORIGINS] ${reason} ${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} [${text}]`
  )
}

const NATIVE_MAP_INTERFACES = ['Map', 'WeakMap', 'ReadonlyMap']

/** A receiver the checker can type as a native map is not only a record,
 * whatever its origins -- asked of the expression and of what it erases to,
 * so `(lists as any).get` still sees a declared `Map` union behind the cast.
 *
 * Memoized on the receiver because it is a pure checker fact, and because it
 * is the FIRST thing every record method-call question asks -- ahead of any
 * cache the walk has. Unmemoized it re-typed the expression and its erasure,
 * took both apparent types, and ran three standard-interface identity checks
 * per union member, once per ask, for questions the three.js app asks millions of
 * times each. */
const nativeMapReceivers = new WeakMap<ts.TypeChecker, WeakMap<ts.Expression, boolean>>()

const mayBeNativeMap = (checker: ts.TypeChecker, receiver: ts.Expression): boolean => {
  let byReceiver = nativeMapReceivers.get(checker)
  if (!byReceiver) nativeMapReceivers.set(checker, (byReceiver = new WeakMap()))
  const known = byReceiver.get(receiver)
  if (known !== undefined) return known
  const check = (type: ts.Type): boolean =>
    type.isUnion() || type.isIntersection()
      ? type.types.some(check)
      : NATIVE_MAP_INTERFACES.some((name) => isStandardInterfaceType(checker, receiver, name, type))
  const answer = [receiver, unwrapErasedExpression(receiver)].some((expression) => {
    const type = checker.getTypeAtLocation(expression)
    return check(type) || check(checker.getApparentType(type))
  })
  byReceiver.set(receiver, answer)
  return answer
}

/** The stable source callable a record entry holds, or null. */
const slotCallableOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  entry: ts.PropertyAssignment | ts.ShorthandPropertyAssignment
): RecordMethodTarget | null => {
  const value = ts.isPropertyAssignment(entry) ? unwrapErasedExpression(entry.initializer) : null
  let found: ts.Node | undefined
  if (value && (ts.isFunctionExpression(value) || ts.isArrowFunction(value))) found = value
  else {
    const symbol = ts.isShorthandPropertyAssignment(entry)
      ? checker.getShorthandAssignmentValueSymbol(entry)
      : value && ts.isIdentifier(value)
        ? checker.getSymbolAtLocation(value)
        : undefined
    found = resolveFlowSymbolAlias(checker, symbol)?.valueDeclaration
    // The literal copies the binding's value when it runs; a reassigned
    // binding can have held another function by then.
    if (!found || !ts.isFunctionDeclaration(found) || calleeBindingIsWritten(flow, found)) return null
  }
  if (!ts.isFunctionDeclaration(found) && !ts.isFunctionExpression(found) && !ts.isArrowFunction(found)) return null
  return found.body ? found : null
}

/**
 * Any write the flow index files against the entry's own cell, other than the
 * literal publishing it.
 *
 * Memoized because it is a pure source fact and both of its callers sit on the
 * hottest record path: it asks the checker for the root's type and materializes
 * the union of two write sets into a fresh array on EVERY ask, and a live
 * three.js profile charged it 27.2% of self time with the collector behind it.
 * `entry` is one of `root`'s own properties, so the entry alone names the root;
 * nothing but the key is left to vary.
 */
const slotRewrites = new WeakMap<ValueFlowIndex, WeakMap<ts.ObjectLiteralElementLike, Map<string, boolean>>>()

const slotRewritten = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  root: ts.ObjectLiteralExpression,
  entry: ts.ObjectLiteralElementLike,
  key: string
): boolean => {
  let byEntry = slotRewrites.get(flow)
  if (!byEntry) slotRewrites.set(flow, (byEntry = new WeakMap()))
  let byKey = byEntry.get(entry)
  if (!byKey) byEntry.set(entry, (byKey = new Map()))
  const known = byKey.get(key)
  if (known !== undefined) return known
  const property = checker.getTypeAtLocation(root).getProperty(key)
  const writes = [...flow.writesToDeclaration(entry), ...(property ? flow.writesToSymbol(property) : [])]
  // Mutating a member of the stored object does not replace this slot.
  const answer = writes.some((write) => write.slot === 'whole' && write.site !== entry)
  byKey.set(key, answer)
  return answer
}

const activeMethodCalls = new Set<ts.CallExpression>()
/**
 * Targets this call has already been PROVEN to enter, while its slot-closure
 * question is still open.
 *
 * Target selection and slot closure are two facts, and only the second is
 * pending during the escape proof: the bodies come from the record's own write
 * plan and the `slotRewritten` check, both settled before `recordSlotClosed` is
 * ever asked. The escape proof reaches this same call again (a receiver read in
 * callee position is now classified by `invocationTargetsOf`), and answering
 * that re-entry with `null` published "no target is provable" for a target set
 * this frame had already decided -- so the proof refused, closure failed, and a
 * call's own resolution depended on itself.
 *
 * Publishing the decided half is not an assumption used to prove itself: the
 * escape proof consumes these bodies to ask whether THEY leak the receiver, and
 * a leak still fails closure and still makes this call refuse. Delete this
 * buffer when the record/receiver-escape domain moves into the shared solver
 * and the pair becomes one strongly-connected component.
 */
const decidedMethodCallTargets = new Map<ts.CallExpression, readonly RecordMethodTarget[]>()
/** Slot reads whose holder plan is being built; a re-entry (`node = node.next`) refuses. */
const activeSlotReads = new Set<ts.PropertyAccessExpression | ts.ElementAccessExpression>()

/**
 * The closed callables `record.key( ... )` can enter, or null.
 *
 * Three's `WebGLRenderLists` is a factory returning `{ get: get, dispose:
 * dispose }`, and `renderLists.get( scene, depth )` looks a list up in a
 * `WeakMap` inside that `get`. Read as a native `Map.get`, the call named no
 * storage at all and refused; it is a call of the one function the record's
 * `get` slot was created holding.
 *
 * Non-null only when all of these hold:
 * - the checker is present and cannot type the receiver as a native
 *   `Map`/`WeakMap`/`ReadonlyMap` (a receiver that may be a real map is not
 *   classified as a record, whatever its origins);
 * - the receiver's own record plan (`sourceRecordDataWritePlanOf` for `key`,
 *   under the same authority) is complete, and every allocation carries
 *   `key` as exactly one own data entry -- no default-prototype lookup;
 * - each entry holds a source function with a body written in place, or names
 *   a function declaration whose binding is never reassigned;
 * - no write the flow index names replaces the entry (`r.get = ...`) --
 *   regardless of any caller proof;
 * - every allocation's aliases are closed: `recordAllocationAliasesClosed`,
 *   or failing that the authority's `recordSlotClosed`.
 *
 * Parameter-position mapping (rest parameters, `arguments`, spreads at the
 * call) is NOT checked here; a caller walking arguments into the target's
 * parameters owns that.
 *
 * A re-entrant query for the same call is answered with the targets this frame
 * has already decided, and refuses only before that point -- see
 * `decidedMethodCallTargets`. The slot-closure half is still pending for such a
 * query, so a re-entrant answer means "these bodies, if this slot closes", and
 * the enclosing frame still returns null when it does not.
 */
/**
 * Array reads that REMOVE and return an element the array already held. Both
 * are answered by the array's own stored-value inventory; neither can yield a
 * value the array never stored. `at`/`[i]` are the non-removing spelling and
 * are already handled by the element-access branch.
 */
const arrayRemovingReadNames = new Set(['pop', 'shift'])

export const recordMethodCallTargetsOf = (
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  authority: OriginAuthority
): readonly RecordMethodTarget[] | null => {
  const checker = authority.checker
  const callee = unwrapErasedExpression(call.expression)
  const key = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isElementAccessExpression(callee)
      ? (() => {
          const argument = unwrapErasedExpression(callee.argumentExpression)
          return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : null
        })()
      : null
  if (key === null || key === '__proto__' || key === 'constructor') return recordRefusal(call, () => 'record:no-key')
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))
    return recordRefusal(call, () => 'record:callee-not-member')
  const receiver = callee.expression
  if (mayBeNativeMap(checker, receiver)) return recordRefusal(call, () => 'record:receiver-may-be-map')
  if (activeMethodCalls.has(call)) {
    // Both halves of this re-entry are hypotheses: the decided targets are a
    // partial answer ("these bodies, IF this slot closes") and the refusal is
    // "unknown while I am answering". An enclosing memo may keep either only
    // while this same call is still open.
    noteHypothesis(call)
    const decided = decidedMethodCallTargets.get(call)
    return decided ?? recordRefusal(call, () => 'record:reentrant-no-decision')
  }
  activeMethodCalls.add(call)
  enterHypothesisGuard(call)
  let answered: readonly RecordMethodTarget[] | null = null
  let completed = false
  try {
    answered = ((): readonly RecordMethodTarget[] | null => {
      const plan = sourceRecordDataWritePlanOf(flow, receiver, key, authority)
      if (plan === null) return recordRefusal(call, () => `record:plan-null key=${key}`)
      if (plan.needsDefaultPrototype) return recordRefusal(call, () => `record:plan-needs-default-prototype key=${key}`)
      const targets = new Set<RecordMethodTarget>()
      for (const root of plan.roots) {
        const entries = root.properties.filter((property) => property.name !== undefined && objectLiteralEntryKeyOf(property.name) === key)
        const entry = entries.length === 1 ? entries[0]! : undefined
        if (!entry || (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)))
          return recordRefusal(root, () => `record:no-single-entry key=${key}`)
        const target = slotCallableOf(checker, flow, entry)
        if (target === null) return recordRefusal(entry, () => `record:slot-callable-null key=${key}`)
        if (slotRewritten(checker, flow, root, entry, key)) return recordRefusal(entry, () => `record:slot-rewritten key=${key}`)
        targets.add(target)
      }
      const decided = [...targets]
      decidedMethodCallTargets.set(call, decided)
      const closed =
        plan.roots.every((root) => recordAllocationAliasesClosed(checker, flow, root)) ||
        authority.recordSlotClosed(receiver, key, plan.roots)
      return closed ? decided : recordRefusal(call, () => `record:slot-not-closed key=${key}`)
    })()
    completed = true
    return answered
  } finally {
    // What every re-entry was handed while this ran: a refusal, unless a
    // decision had already been published. So when this call also ends in a
    // refusal and no decision was ever published, every re-entry was handed
    // exactly the answer the question turned out to have -- the hypothesis was
    // the truth, and the answers that leaned on it lost nothing by leaning
    // (`proof-hypotheses.ts`). That is the `settled` argument, and it is what
    // lets an enclosing memo KEEP a refusal instead of re-deriving it.
    //
    // The three ways it is not claimed are each a case where a re-entry was
    // handed something the question did not turn out to have: a decision
    // published partway means early and late re-entries disagree; a non-null
    // answer means the re-entries' refusal was weaker than the truth; and a
    // throw means there is no truth to compare against yet. `confirmed` stays
    // unconditionally true because a pessimistic guard never makes an answer
    // UNSOUND -- that is a different and weaker claim, deliberately kept apart.
    const published = decidedMethodCallTargets.get(call) !== undefined
    exitHypothesisGuard(call, true, completed && !published && answered === null)
    activeMethodCalls.delete(call)
    decidedMethodCallTargets.delete(call)
  }
}

/** Every value `record.key( ... )` can return: the completions of every
 * callable `recordMethodCallTargetsOf` names, or null when any target's
 * normal completion is unsupported. Target admission remains useful when
 * this separate result query refuses. */
export const recordMethodCallResultsOf = (
  flow: ValueFlowIndex,
  call: ts.CallExpression,
  authority: OriginAuthority
): readonly ts.Expression[] | null => {
  const targets = recordMethodCallTargetsOf(flow, call, authority)
  if (targets === null) return null
  const results: ts.Expression[] = []
  for (const target of targets) {
    const values = callableCompletionValuesOf(flow, target)
    if (values === null) return null
    results.push(...values)
  }
  return results
}

/** The origin-graph key standing for a callable's completions: a function
 * declaration or block body is never itself a value origin. */
const completionKeyOf = (target: RecordMethodTarget): ts.Node =>
  ts.isFunctionDeclaration(target) ? target : ts.isBlock(target.body) ? target.body : unwrapErasedExpression(target.body)

/** A callee whose binding is reassigned names a different function at each
 * call, so its result is not evidence of any one allocation. */
const calleeBindingIsWritten = (flow: ValueFlowIndex, declaration: ts.Declaration): boolean =>
  flow
    .writesToDeclaration(declaration)
    .some(
      (write) =>
        write.slot === 'whole' &&
        (write.edge === 'identifier-assignment' || write.edge === 'compound-assignment' || write.edge === 'logical-assignment')
    )

const numericType = (checker: ts.TypeChecker, expression: ts.Expression): boolean => {
  const check = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(check) : (type.flags & ts.TypeFlags.NumberLike) !== 0)
  return check(checker.getTypeAtLocation(expression))
}

const REFUSED: SeededOriginNode<ts.Node> = { seed: false, admitted: false, dependencies: [] }
const VACUOUS: SeededOriginNode<ts.Node> = { seed: false, admitted: true, dependencies: [] }
const SEED: SeededOriginNode<ts.Node> = { seed: true, admitted: true, dependencies: [] }
const through = (dependencies: readonly ts.Node[]): SeededOriginNode<ts.Node> => ({ seed: false, admitted: true, dependencies })

/** Source allocation evidence for a record write, not descriptor authority.
 * The caller must close all uses of these roots (including deletion and
 * reflective mutation), and discharge the prototype obligation for absent
 * slots. A structural property signature alone establishes neither fact.
 *
 * Origins are solved by strongly connected components (`seeded-origins.ts`)
 * because record storage is reused. Three's `getNextRenderItem`:
 *
 *   let renderItem = renderItems[ renderItemsIndex ];
 *   if ( renderItem === undefined ) {
 *     renderItem = { id: object.id, object: object, ... };
 *     renderItems[ renderItemsIndex ] = renderItem;
 *   } else { renderItem.object = object; ... }
 *
 * `renderItem`'s origins are the element read and the literal; the element
 * read's origins are everything `renderItems` ever stored, which is
 * `renderItem` again. That cycle is seeded by the literal, so the roots are
 * exactly `[ literal ]`. A cycle no allocation feeds stays refused, and a
 * `null`/`undefined` origin (`let currentRenderList = null`) adds no root
 * while refusing nothing -- nothing can be written through it.
 *
 * The caller supplies one complete origin authority. Storage reads refuse
 * when its protocol, numeric-key, or frame evidence cannot close them.
 */
/**
 * `sourceRecordDataWritePlanOf` solves a fresh strongly-connected-component
 * origin graph (`seededOriginSolver`) from zero on EVERY call -- and
 * `callable-reach.ts` alone asks it from nine different call sites inside one
 * member proof, several of them (`fieldDeclarationsOf`, `siblingDeclarationsOf`,
 * `constructionDataMemberOf`, shared invocation targets) about the very same
 * (receiver, key) pair reached through different questions. Measured with
 * `expand` alone at ~2 s self time per profile window, repeated across a
 * whole compile's worth of proofs.
 *
 * Keyed on the caller's `authority` object identity, not its content: every
 * caller constructs one `SourceRecordOriginAuthority` per proof (`callable-
 * reach.ts`'s `recordAuthority`, built once per `closedMemberCallableUses`
 * call) and passes the same object to every one of its own call sites, so
 * sharing a cache bucket per authority object shares exactly the calls that
 * are safe to share -- calls from the SAME proof, which close over the SAME
 * `recordSlotClosed` -- and never a different proof's, since that always gets
 * a new object and therefore a new WeakMap bucket. `flow` is keyed too, purely
 * for extra safety: nothing currently reuses one authority object across two
 * flows, but nothing has to promise it either.
 */
const writePlansByFlow = new WeakMap<
  ValueFlowIndex,
  WeakMap<object, WeakMap<ts.Expression, Map<string, SourceRecordDataWritePlan | null>>>
>()

export const sourceRecordDataWritePlanOf = (
  flow: ValueFlowIndex,
  receiver: ts.Expression,
  key: string,
  authority: OriginAuthority
): SourceRecordDataWritePlan | null => {
  const authorityIdentity = originAuthorityIdentity(authority)
  let byAuthority = writePlansByFlow.get(flow)
  if (!byAuthority) writePlansByFlow.set(flow, (byAuthority = new WeakMap()))
  let byReceiver = byAuthority.get(authorityIdentity)
  if (!byReceiver) byAuthority.set(authorityIdentity, (byReceiver = new WeakMap()))
  let byKey = byReceiver.get(receiver)
  if (!byKey) byReceiver.set(receiver, (byKey = new Map()))
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  if (byKey.has(key)) {
    const cached = byKey.get(key)!
    if (cached && cached.requirements.length > 0 && ledger?.include(cached.requirements) !== true)
      return recordRefusal(receiver, () => `record-plan:cached-ledger-include-fail key=${key}`)
    return cached
  }
  const compute = (): SourceRecordDataWritePlan | null => sourceRecordDataWritePlanUncached(flow, receiver, key, authority)
  // Shared across proofs where the authority can (see `sharedAnswerOf`); the
  // per-authority bucket above still answers this proof's repeats.
  const captured = authority.sharedAnswerOf
    ? authority.sharedAnswerOf(`record-plan:${key}:${nodePathToken(receiver)}`, compute)
    : ledger
      ? ledger.capture(compute)
      : { value: compute(), requirements: [] }
  const answer = captured.value ? { ...captured.value, requirements: captured.requirements } : null
  if (!answer) return recordRefusal(receiver, () => `record-plan:compute-null key=${key}`)
  if (answer.requirements.length > 0 && ledger?.include(answer.requirements) !== true)
    return recordRefusal(receiver, () => `record-plan:ledger-include-fail key=${key}`)
  const planCache = byKey
  authority.whenSettled(() => planCache.set(key, answer))
  return answer
}

const sourceRecordDataWritePlanUncached = (
  flow: ValueFlowIndex,
  receiver: ts.Expression,
  key: string,
  authority: OriginAuthority
): SourceRecordDataWritePlan | null => {
  if (key === '__proto__' || key === 'constructor') return null
  const frames = authority
  const { checker, protocolClosed } = frames
  const original = unwrapErasedExpression
  const roots = new Set<ts.ObjectLiteralExpression>()
  let needsDefaultPrototype = false
  const literal = (value: ts.ObjectLiteralExpression): SeededOriginNode<ts.Node> => {
    let ownData = false
    let nullPrototype = false
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) return REFUSED
      const name = ts.isComputedPropertyName(property.name) ? original(property.name.expression) : property.name
      const named =
        ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) || (!ts.isComputedPropertyName(property.name) && ts.isIdentifier(name))
          ? name.text
          : null
      if (named === null) return REFUSED
      if (named === '__proto__' && ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
        if (original(property.initializer).kind !== ts.SyntaxKind.NullKeyword) return REFUSED
        nullPrototype = true
      }
      if (named !== key) continue
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return REFUSED
      ownData = true
    }
    roots.add(value)
    needsDefaultPrototype ||= !ownData && !nullPrototype
    return SEED
  }
  // A factory's result IS its allocation. Three writes nearly every one of
  // its records that way -- `new ColorBuffer()`, `WebGLState( gl, extensions
  // )`, `WebGLRenderList()` all return an object literal written in place --
  // and reading only the identifier chain stopped at the call, leaving the
  // record with no source allocation at all.
  //
  // Every completion of the callee must yield an origin: each `return`
  // carries one, and the body's last statement is a `return` so control
  // cannot fall off the end into `undefined` (or, under `new`, into `this`).
  // The literals stay the roots, so the caller closes the factory's own uses
  // of them and -- through the return -- the uses at every call site, which
  // is where a record handed to unknown code is caught.
  const factory = (target: RecordMethodTarget): SeededOriginNode<ts.Node> => {
    const results = callableCompletionValuesOf(flow, target)
    return results ? through(results) : refuse(target, 'factory:completion-values-refused')
  }
  /** Logs, under `GEA_ORIGINS_DEBUG`, then returns the shared `REFUSED` node --
   * so every arm below stays a one-line early return while still naming itself. */
  const refuse = (node: ts.Node, reason: string): SeededOriginNode<ts.Node> => {
    refuseWritePlanOrigin(node, reason)
    return REFUSED
  }
  const expand = (node: ts.Node): SeededOriginNode<ts.Node> => {
    if (ts.isParameter(node)) {
      const values = frames.parameterValuesOf(node)
      return values !== null && values.length > 0 ? through(values.map(original)) : refuse(node, 'parameter:values-refused')
    }
    if (ts.isVariableDeclaration(node)) {
      const writes = flow.writesToDeclaration(node).filter((write) => write.slot === 'whole')
      const closed =
        writes.length > 0 &&
        writes.every(
          (write) => (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') && write.value !== null
        )
      return closed ? through(writes.map((write) => original(write.value!))) : refuse(node, 'variable:writes-not-closed')
    }
    if (ts.isFunctionDeclaration(node)) return factory(node)
    // A function expression's block body stands for its completions (`completionKeyOf`).
    if (ts.isBlock(node))
      return ts.isFunctionExpression(node.parent) || ts.isArrowFunction(node.parent)
        ? factory(node.parent)
        : refuse(node, 'block:not-a-factory-body')
    const value = node as ts.Expression
    if (isVacuousOrigin(flow, value)) return VACUOUS
    if (ts.isConditionalExpression(value)) return through([original(value.whenTrue), original(value.whenFalse)])
    if (ts.isObjectLiteralExpression(value)) return literal(value)
    // `renderItems[ renderItemsIndex ]`: whatever that array ever stored.
    if (ts.isElementAccessExpression(value)) {
      const index = value.argumentExpression
      if (!numericType(checker, index) && !frames.numericKey(index)) return refuse(value, 'element-access:non-numeric-key')
      const stored = arrayStoredValuesOf(checker, flow, value.expression, frames)
      return stored ? through(stored.map(original)) : refuse(value, 'element-access:array-stored-values-refused')
    }
    if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
      const callee = original(value.expression)
      if (ts.isCallExpression(value) && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        // A record method: whatever the callable its slot holds returns
        // (`recordMethodCallTargetsOf`). Asked first: a receiver whose origins
        // are all record literals, and whose type admits no map, is no map.
        const methods = recordMethodCallTargetsOf(flow, value, frames)
        if (methods) return through(methods.map(completionKeyOf))
        if (!ts.isPropertyAccessExpression(callee)) return refuse(value, 'call:record-method-targets-refused')
        // An array's own removing READ -- `pop`/`shift` -- yields a value that
        // array once stored, exactly as `renderItems[ i ]` does a few lines
        // above. Three keeps its render states on an explicit stack
        // (`renderStateStack.push( currentRenderState )` then
        // `currentRenderState = renderStateStack.pop()`), so refusing this one
        // shape left every `currentRenderState.*` call open even though the
        // record's allocation is right here. `arrayStoredValuesOf` is the same
        // authority the element-access branch already trusts: it returns null
        // unless the array's whole stored set is closed AND every plan it
        // passes through is `protocolClosed`, so the method NAME alone grants
        // nothing -- the receiver still has to prove out as an array this
        // program owns. A miss yields `undefined`, which is the reader's case
        // here just as it is for an element read.
        if (arrayRemovingReadNames.has(callee.name.text)) {
          const elements = arrayStoredValuesOf(checker, flow, callee.expression, frames)
          return elements ? through(elements.map(original)) : refuse(value, 'call:array-stored-values-refused')
        }
        // A native map's `get`: whatever that map ever stored, under any key.
        if (callee.name.text !== 'get') return refuse(value, 'call:record-method-targets-refused')
        const stored = collectionStoredValuesOf(checker, flow, value, protocolClosed)
        return stored ? through(stored.map(original)) : refuse(value, 'call:map-get-stored-values-refused')
      }
      if (!ts.isIdentifier(callee)) return refuse(value, 'call:callee-not-identifier')
      // An imported factory is the function its module declares: the import
      // binding's own cell is the specifier, and it is never reassigned.
      const named = flow.targetOf(callee)
      const target =
        checker && named?.symbol && (named.symbol.flags & ts.SymbolFlags.Alias) !== 0
          ? resolveFlowSymbolAlias(checker, named.symbol)?.valueDeclaration
          : named?.declaration
      if (!target || !ts.isFunctionDeclaration(target) || !target.body) return refuse(value, 'call:callee-not-function-declaration')
      if (target.asteriskToken || target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        return refuse(value, 'call:callee-generator-or-async')
      if (calleeBindingIsWritten(flow, target)) return refuse(value, 'call:callee-binding-written')
      // Under `new`, a non-object completion (or any `this` use) means the
      // result can be the fresh `this`, which no plan enumerates.
      if (ts.isNewExpression(value) && !constructionYieldsCompletionOf(flow, target))
        return refuse(value, 'new:not-a-concrete-object-completion')
      return through([target])
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return slotRead(value)
    if (!ts.isIdentifier(value)) return refuse(value, `identifier:not-an-identifier:${ts.SyntaxKind[value.kind]}`)
    const declaration = importedCellOf(flow.targetOf(value)?.declaration ?? null)
    if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration)))
      return refuse(value, `identifier:${declaration ? ts.SyntaxKind[declaration.kind] : 'no-declaration'}`)
    return through([declaration])
  }
  // An import binding is the exported cell read from another module: its
  // writes are the declaring module's, which the flow index files against
  // that declaration. Three imports `ColorManagement` into every renderer
  // module.
  const importedCellOf = (declaration: ts.Node | null): ts.Node | null => {
    if (!declaration || !checker || (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration)) || !declaration.name)
      return declaration
    const resolved = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(declaration.name))?.valueDeclaration
    return resolved && ts.isVariableDeclaration(resolved) && !resolved.getSourceFile().isDeclarationFile ? resolved : null
  }
  // `state.buffers` in three's `WebGLRenderer`: whatever the holder's slot
  // holds. The holder's own plan names its allocations; each carries the key
  // as one data entry, whose initializer is the slot's first value. Any other
  // value needs a store, so no write the flow index files against the entry
  // may exist, and every alias of the holder must be closed against slot
  // replacement -- this module's own proof, or failing that the authority's
  // whole-program one, exactly as a record method call asks.
  const slotRead = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): SeededOriginNode<ts.Node> => {
    const values = frames.slotValuesOf?.(access) ?? sourceRecordSlotValuesOf(flow, access, frames)
    return values === null ? refuse(access, 'slot-read:values-refused') : through(values)
  }

  const verdict = seededOriginSolver(expand)(original(receiver))
  return verdict === 'allocated' && roots.size > 0 ? { roots: [...roots], needsDefaultPrototype, requirements: [] } : null
}

/** The stored values of a closed own record slot. The allocation, descriptor,
 * alias and replacement checks are shared with nested record-origin reads;
 * a consumer must still establish the provenance of each returned value. */
export const sourceRecordSlotValuesOf = (
  flow: ValueFlowIndex,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  authority: OriginAuthority
): readonly ts.Expression[] | null => {
  const { checker } = authority
  if (activeSlotReads.has(access)) {
    // A slot read still being answered refuses; anything that leaned on that
    // refusal is reusable only while this same read is open.
    noteHypothesis(access)
    return null
  }
  const original = unwrapErasedExpression
  const argument = ts.isElementAccessExpression(access) ? original(access.argumentExpression) : null
  const key = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
      ? argument.text
      : null
  if (key === null || key === '__proto__' || key === 'constructor') return null
  const holder = access.expression
  activeSlotReads.add(access)
  enterHypothesisGuard(access)
  let answered: readonly ts.Expression[] | null = null
  try {
    answered = ((): readonly ts.Expression[] | null => {
      const plan = sourceRecordDataWritePlanOf(flow, holder, key, authority)
      if (plan === null || plan.needsDefaultPrototype) return null
      const values: ts.Expression[] = []
      for (const root of plan.roots) {
        const entries = root.properties.filter((property) => property.name !== undefined && objectLiteralEntryKeyOf(property.name) === key)
        const entry = entries.length === 1 ? entries[0]! : undefined
        if (!entry || (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry))) return null
        if (slotRewritten(checker, flow, root, entry, key)) return null
        values.push(original(ts.isPropertyAssignment(entry) ? entry.initializer : entry.name))
      }
      const closed =
        plan.roots.every((root) => recordAllocationAliasesClosed(checker, flow, root)) ||
        authority.recordSlotClosed(holder, key, plan.roots)
      return closed ? values : null
    })()
    return answered
  } finally {
    // The re-entry above hands out exactly one thing -- a refusal -- so a
    // refusal here confirms it outright.
    exitHypothesisGuard(access, true)
    activeSlotReads.delete(access)
  }
}
