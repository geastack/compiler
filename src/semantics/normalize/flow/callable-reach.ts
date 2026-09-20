import { runtimeParametersOf } from './targets.js'
import { seededOriginSolvers } from './seeded-origins.js'
import {
  enterHypothesisGuard,
  hypothesisSettledAsTruth,
  hypothesisStats,
  exitHypothesisGuard,
  registerGuardedAnswer,
  hypothesisGuardIsOpen,
  hypothesisNotes,
  noteHypothesis,
  popHypothesisTrail,
  pushHypothesisTrail
} from './proof-hypotheses.js'
import { unwrapErasedExpression } from '../producers/erasure.js'
import ts from 'typescript'
import {
  heritageClassOrInterfaceOf,
  isClassSpelledSourceClass,
  isConstructorFunction,
  type FlowCallSite,
  type SourceClass,
  type ValueFlowIndex,
  type ValueWrite
} from './model.js'
import { isObjectLiteralPrototypeSetter } from '../assignment-patterns.js'
import { isModuleExportedDeclaration, isTypePositionReference, resolveFlowSymbolAlias, unwrapNaming } from './targets.js'
import { inProgramImportReferencesOf } from './export-importers.js'
import {
  closedConstructorForwardingTargetsOf,
  classConstructorKeepsInstanceOf,
  sourceConstructorSelectionsOf,
  exactClassAllocationOriginsOf,
  type ClassAllocationAuthority,
  ordinarySourceClassInstanceTestOf,
  type ExactClassAllocationOrigins,
  type CallCompletionValuesAt,
  thisConstructorFamilyOf
} from './member-call-forwarding.js'
import { ownedClassReceiverInventoryOf } from './owned-class-receivers.js'
import { sourceConstructionFramesOf } from './source-construction-frames.js'
import { collectionKeyArgumentIsInert, collectionStoredValuesOf, collectionValueContinuationsOf } from './collection-value-continuation.js'
import { objectBindingReadsOf } from './object-binding-continuation.js'
import { callableArrayTargetsOf, closedCallableTargetsOf, type CallableArrayOriginAuthority } from './callable-array-origins.js'
import { arrayStoredValuesOf } from './array-element-continuation.js'
import { nativeArrayProtocolPlanOf, type NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { recordMethodCallTargetsOf, sourceRecordDataWritePlanOf } from './source-record-data.js'
import { nodePathToken, nodeSetToken } from './node-path-token.js'
import { objectLiteralEntryKeyOf, recordLiteralReceiverClosed } from './record-alias-closure.js'
import { censusArgumentsObjects, type ArgumentsObjectCensus } from '../arguments-objects.js'
import {
  sourceInvocationFrame,
  sourceInvocationFact,
  invocationValueContinuationsOf,
  invocationCompletionValuesOf,
  type SourceInvocationFact
} from './invocation-facts.js'
import {
  declaredDataMemberAccess,
  reflectiveDefinitionMayInstallGetterOf,
  sourceClassConstructorSlotIsOriginal,
  sourceClassDataMemberPlanOf,
  sourceClassKeyReadPlanOf,
  type SourceClassKeyReadPlan
} from './source-class-data.js'
import { intrinsicDataDefinitionTargetOf } from './intrinsic-data-definition.js'
import { coercionHooksAreHost, hostTextSinkArgumentOf } from './host-text-sink.js'
import { enclosingArgumentsFunction, isArgumentsObjectIdentifier } from '../implicit-arguments.js'
import { constructorCallsOf } from './parameter-values.js'
import { outermostErasureOf } from '../producers/erasure.js'
import { intrinsicOwnKeyQueryOf } from '../intrinsic-property-call.js'
import { localBindingValuesOf, localBindingWritesAreComplete } from './value-provenance.js'
import { computedKeySetOf, type ComputedKeySetAuthority } from './computed-key-set.js'
import { callableCompletionValuesOf, constructionYieldsCompletionOf } from './callable-completions.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { isGlobalObjectAssign } from './value-flow.js'
import type { SharedProvenanceAnswer } from './origin-authority.js'

/** Source slots are stable per flow round; their resolved caller frames are proof-local. */
interface MemberImplementationInventory {
  readonly bodies: readonly ts.SignatureDeclaration[]
  readonly values: readonly ts.Expression[]
}
const memberImplementationInventories = new WeakMap<ValueFlowIndex, Map<ts.Declaration, MemberImplementationInventory | null>>()

/**
 * Instance-owned stores indexed by their lexical receiver and property key.
 * JavaScript's binder can give `this.m = value` a fresh declaration even
 * when the class type still resolves `m` to an inherited method. Both values
 * are alternatives of virtual dispatch; declaration identity alone loses
 * the own-property replacement. This is a projection of indexed writes and
 * receiver owners, not another source-tree traversal.
 */
const instanceMemberWriteInventories = new WeakMap<ValueFlowIndex, ReadonlyMap<SourceClass, ReadonlyMap<string, readonly ValueWrite[]>>>()
const instanceMemberWritesOf = (flow: ValueFlowIndex): ReadonlyMap<SourceClass, ReadonlyMap<string, readonly ValueWrite[]>> => {
  const known = instanceMemberWriteInventories.get(flow)
  if (known) return known
  const owners = new Map<SourceClass, Map<string, ValueWrite[]>>()
  for (const write of flow.allWrites) {
    const access = write.naming
    if (write.slot !== 'whole' || !access || (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access))) continue
    const receiver = unwrapNaming(access.expression)
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword && receiver.kind !== ts.SyntaxKind.SuperKeyword) continue
    const key = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
    const frame = flow.receiverOwnerOf(receiver)
    if (key === null || frame === null) continue
    const owner = isConstructorFunction(frame) ? frame : ts.isClassElement(frame) ? frame.parent : null
    if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner) && !isConstructorFunction(owner))) continue
    if (ts.isClassElement(frame) && (ts.getCombinedModifierFlags(frame) & ts.ModifierFlags.Static) !== 0) continue
    let keys = owners.get(owner)
    if (!keys) owners.set(owner, (keys = new Map()))
    let writes = keys.get(key)
    if (!writes) keys.set(key, (writes = []))
    writes.push(write)
  }
  instanceMemberWriteInventories.set(flow, owners)
  return owners
}

const activeRecordProofs = new WeakMap<
  ValueFlowIndex,
  Set<{
    readonly roots: readonly ts.ObjectLiteralExpression[]
    readonly key: string
    readonly purpose: 'data-descriptor' | 'stable-callable-slot'
    readonly receiverTypeAt: (expression: ts.Expression) => ts.Type | null
  }>
>()
type ReceiverTypeAt = (expression: ts.Expression) => ts.Type | null
const ownedConstructionReceiverTypes = new WeakMap<ReceiverTypeAt, ReceiverTypeAt>()
const ownedConstructionReceiverWrappers = new WeakSet<ReceiverTypeAt>()
/**
 * The class a `new` written inside that very class body declares, or null
 * when the site is not one. It reads the checker, the flow index and the
 * syntax alone -- never the `given` authority the wrapper closes over -- so
 * the answer is the same for every proof that asks about this expression.
 * Recomputing it inside a per-proof wrapper repeated the same two checker
 * lookups and an ancestor walk on every ask; a live three.js profile put that
 * at 6.5% of self time, the largest single cost after the proof memo itself.
 */
const ownedConstructionDeclaredTypes = new WeakMap<ValueFlowIndex, Map<ts.Expression, ts.Type | null>>()
const ownedConstructionDeclaredTypeOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, expression: ts.Expression): ts.Type | null => {
  let byExpression = ownedConstructionDeclaredTypes.get(flow)
  if (!byExpression) ownedConstructionDeclaredTypes.set(flow, (byExpression = new Map()))
  const known = byExpression.get(expression)
  if (known !== undefined) return known
  const value = unwrapErasedExpression(expression)
  let declaredClass: ts.Type | null = null
  if (ts.isNewExpression(value) && thisConstructorFamilyOf(checker, flow, value.expression) !== null) {
    const owner = ts.findAncestor(value, ts.isClassLike)
    const symbol = owner && (owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol())
    const declared = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (declared && declared.isClassOrInterface()) declaredClass = declared
  }
  byExpression.set(expression, declaredClass)
  return declaredClass
}

const ownedConstructionReceiverTypeAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, given: ReceiverTypeAt): ReceiverTypeAt => {
  // A nested proof hands the wrapper back in as the given authority; wrapping
  // it again would mint a new identity per nesting level.
  if (ownedConstructionReceiverWrappers.has(given)) return given
  const known = ownedConstructionReceiverTypes.get(given)
  if (known) return known
  const wrapped: ReceiverTypeAt = (expression) => {
    const held = given(expression)
    if (held !== null && (held.flags & ts.TypeFlags.Any) === 0) return held
    return ownedConstructionDeclaredTypeOf(checker, flow, expression) ?? held
  }
  ownedConstructionReceiverTypes.set(given, wrapped)
  ownedConstructionReceiverWrappers.add(wrapped)
  return wrapped
}

const callLookups = new WeakMap<
  ValueFlowIndex,
  {
    readonly sites: ReadonlyMap<ts.Node, FlowCallSite>
    readonly declarations: ReadonlyMap<ts.SignatureDeclaration | ts.JSDocSignature, readonly FlowCallSite[]>
    readonly callees: ReadonlyMap<ts.Expression, readonly FlowCallSite[]>
    readonly writes: ReadonlyMap<ts.Expression, readonly ValueWrite[]>
    readonly writeReceivers: ReadonlySet<ts.Expression>
  }
>()
/** Calls whose callee is a named member access, by key: record method calls
 * the checker cannot attribute are found here and authenticated per proof. */
const callsByMemberName = new WeakMap<ValueFlowIndex, ReadonlyMap<string, readonly FlowCallSite[]>>()

const omittedArguments = new WeakMap<ts.Node, Map<number, ts.Expression>>()
/**
 * The value an omitted argument supplies: `undefined`, spelled as one stable
 * synthetic `void 0` per call and position so frame sets can dedupe it.
 * Parented to the call and placed at its end, so `getSourceFile()`,
 * `getStart()` and `getText()` answer; consumers read it as nullish
 * (`ts.isVoidExpression`), which is what it is.
 */
const omittedArgumentOf = (call: ts.Node, position: number): ts.Expression => {
  let held = omittedArguments.get(call)
  if (!held) omittedArguments.set(call, (held = new Map()))
  const known = held.get(position)
  if (known) return known
  const value = ts.factory.createVoidZero()
  ts.setTextRange(value.expression, { pos: call.end, end: call.end })
  ts.setTextRange(value, { pos: call.end, end: call.end })
  ;(value.expression as { parent: ts.Node }).parent = value
  ;(value as { parent: ts.Node }).parent = call
  held.set(position, value)
  return value
}

const callsOf = (flow: ValueFlowIndex) => {
  const cached = callLookups.get(flow)
  if (cached) return cached
  const sites = new Map<ts.Node, FlowCallSite>()
  const declarations = new Map<ts.SignatureDeclaration | ts.JSDocSignature, FlowCallSite[]>()
  const callees = new Map<ts.Expression, FlowCallSite[]>()
  const writes = new Map<ts.Expression, ValueWrite[]>()
  const writeReceivers = new Set<ts.Expression>()
  for (const write of flow.allWrites) {
    if (write.naming) writeReceivers.add(write.naming)
    if (!write.value) continue
    const entries = writes.get(write.value)
    if (entries) entries.push(write)
    else writes.set(write.value, [write])
  }
  for (const site of flow.calls) {
    sites.set(site.call, site)
    const uses = callees.get(site.operands.callee)
    if (uses) uses.push(site)
    else callees.set(site.operands.callee, [site])
    for (const declaration of new Set([site.inferredDeclaration ?? site.checkerDeclaration, ...site.targets])) {
      if (!declaration) continue
      const entries = declarations.get(declaration)
      if (entries) entries.push(site)
      else declarations.set(declaration, [site])
    }
  }
  const result = { sites, declarations, callees, writes, writeReceivers }
  callLookups.set(flow, result)
  return result
}

/**
 * The member slot a callable is published into by `<receiver>.<name> =
 * <function>`, or null when the callable is not written down that way.
 *
 * Only the function ITSELF is admitted as the right-hand side: that is what
 * makes the slot the sole handle on the function object, which is the fact
 * the caller's closure proof rests on. The receiver is deliberately NOT
 * restricted to `this` -- `hasClosedMemberCallableUses`, which every caller of
 * this function hands the returned name to, already proves the escape
 * question for an ARBITRARY receiver via its own receiver/family walk, so
 * gating recognition to `this` here proves nothing extra; it only hides the
 * slot from that proof. Three's `mesh.onBeforeRender = function ( renderer,
 * object ) { ... }` -- `mesh` an ordinary variable, not `this` -- is exactly
 * an instance override of a class's own declared (empty) stub, and this
 * function returning null for it silently pushed every caller past the
 * closure proof and straight to a hard refusal, which is a stronger claim
 * than the program's own visible shape justifies: the proof was never RUN,
 * let alone failed.
 */
const memberSlotNameOf = (declaration: ts.SignatureDeclaration): ts.MemberName | null => {
  if (!ts.isFunctionExpression(declaration) && !ts.isArrowFunction(declaration)) return null
  const assignment = declaration.parent
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assignment.right !== declaration ||
    !ts.isPropertyAccessExpression(assignment.left)
  )
    return null
  return assignment.left.name
}

/** Return edges name a function's result cell, not its callable binding. */
const callableBindingIsWritten = (flow: ValueFlowIndex, declaration: ts.Declaration): boolean =>
  flow
    .writesToDeclaration(declaration)
    .some(
      (write) =>
        write.slot === 'whole' &&
        (write.edge === 'identifier-assignment' || write.edge === 'compound-assignment' || write.edge === 'logical-assignment')
    )

/**
 * The two transitive questions about a FUNCTION VALUE that no census could
 * answer for itself: which callables can reach a call's callee position, and
 * which calls can reach a callable.
 *
 * Every write-discovery census asks the same thing about a callable it wants
 * to type from its callers -- "have I seen ALL of them?" -- and each answered
 * it with a private, purely LOCAL test: is every mention of this function's
 * own name a call I already counted? That test is right about what it can see
 * and blind to one whole shape of program:
 *
 *     function each( list, cb ) { for (...) cb( list[ i ] ); }
 *     each( items, function ( item ) { ... } );
 *
 * `cb`'s callers are enumerable and `cb( list[i] )` is the callback's ONLY
 * caller -- but the two facts live one indirection apart, so a census looking
 * at the callback sees a value handed to a caller it cannot name, and a census
 * looking at `cb( ... )` sees a call whose callee has no declaration. Measured
 * on the three.js app: 169 unannotated parameters are refused
 * `function-escapes:unnamed:CallExpression` for exactly this, and every one of
 * them is a `function-value-dispatch` ABI publishing `dynamic` for a
 * parameter whose real type the program states at the call.
 *
 * ## What makes an answer here SOUND
 *
 * A wrong parameter type is a silent miscompile; a dynamic one is a box. So
 * this layer answers only when it can prove CLOSURE -- that the set it
 * reports is complete, not merely non-empty -- and otherwise refuses BY NAME.
 * Two independent closures are needed and both are proved, never assumed:
 *
 * 1. **The callable's value goes nowhere else.** Only a callable written
 *    directly in an argument position qualifies here: such an expression node
 *    occurs once in the whole program and is named by nothing, so the
 *    parameter slot it lands in is provably the only place its value can be.
 *    A callable reached by NAME does not qualify -- a name can be imported
 *    into another module, where it resolves to an alias symbol this index
 *    files under a different key, so "no other mention" would be a claim
 *    about the current module rather than the program.
 * 2. **Every mention of the receiving slot is explained.** A parameter is the
 *    one cell kind for which that is decidable cheaply and completely: it is
 *    scoped to one function body and no import, export or property lookup can
 *    name it, so `referencesToDeclaration` really is all of them. Each is
 *    either a CALL through the slot (evidence) or a mention that provably
 *    cannot call or leak the value (`if ( cb )`, `typeof cb`, `cb !== null`).
 *    Anything else -- `h( cb )`, `this.saved = cb`, `cb.bind( ... )`,
 *    `cb || noop` (which yields the value onward) -- means the value reaches
 *    somewhere unenumerated, and the callable stays refused.
 *
 * Both are stated over the shared flow index rather than re-walked here, so
 * this composes edges the index already publishes (`call-argument` for the
 * write, `referencesToDeclaration` for the mentions) instead of adding a
 * seventh private walk. It performs no type query, only symbol resolution, so
 * -- like the index itself -- it is a fixed property of the program and safe
 * to build once, ahead of every census round.
 */
export interface CallableReachIndex {
  /**
   * Every call that can reach this callable through a cell, or `null` when
   * this layer cannot prove the set is CLOSED.
   *
   * `null` is the normal answer and the safe one: it means "no proof", and a
   * consumer must then keep whatever refusal it already had. A non-null answer
   * is a proof that these are ALL of the callable's callers apart from the
   * direct, syntactically-named ones its consumer already enumerates itself.
   */
  readonly enumeratedCallSitesOf: (declaration: ts.SignatureDeclaration) => readonly ts.CallExpression[] | null
  /**
   * Every callable a call's callee position can reach, for a callee the
   * checker resolves to no declaration.
   *
   * Unlike `enumeratedCallSitesOf` this needs no closure proof, because it
   * only ever ADDS evidence: a call that may dispatch into any of several
   * callables is a call site of each, exactly as a virtual call is a call site
   * of every override, and a consumer joining that evidence either agrees or
   * refuses on disagreement. Missing some of the set weakens the answer;
   * it cannot falsify one.
   */
  readonly calleesOf: (call: ts.CallExpression) => readonly ts.SignatureDeclaration[]
  /** How many callables this layer proved closed, for measurement. */
  readonly closedCount: number
  /** Why each candidate callable was refused, counted by reason -- so a low count has an attribution rather than a guess. */
  readonly refusals: ReadonlyMap<string, number>
}

const NO_CALLABLES: readonly ts.SignatureDeclaration[] = []

/** Intrinsic Array methods that call their callback with ( element, index, array ). */
const ELEMENT_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  'forEach',
  'some',
  'every',
  'find',
  'findLast',
  'findIndex',
  'findLastIndex',
  'filter'
])

/** A layer over no program, for callers that state none. */
export const emptyCallableReachIndex: CallableReachIndex = {
  enumeratedCallSitesOf: () => null,
  calleesOf: () => NO_CALLABLES,
  closedCount: 0,
  refusals: new Map()
}

/** A newly inferred inline member callback needs every value use accounted
 * for. Method-name references alone are insufficient: `consume(obj.hook)` is
 * an escape even though the name is part of a normal property access. Follow
 * local aliases only to classify their complete shared reference inventory;
 * calls through an alias must still appear in the caller's counted set. */
interface ClosedValueMode {
  readonly roots: readonly ts.Expression[]
  readonly terminalUse: (reference: ts.Expression) => boolean | null
  /**
   * What this value question IS, for the proof memo. A caller that mints
   * `roots` and `terminalUse` afresh per call (every record-root proof does)
   * hands the memo a key no later call can match; naming the question by
   * content lets the same record family under the same key share one answer.
   * Omitted, the mode object itself is the key.
   */
  readonly identity?: string
  /**
   * A re-entrancy park the CALLER established for this very question and
   * releases the moment this proof returns. It is this proof's own
   * coinduction, exactly like `member` and its families: the answer is the
   * greatest fixpoint over "assume this question true", not a fact borrowed
   * from an enclosing proof. Naming it here is what lets `share` discharge
   * it instead of recording it as an assumption -- and that distinction is
   * the whole value of the memo, because every one of these parks is a
   * freshly allocated object that no later call can ever present again.
   */
  readonly ownPark?: object
  /** Where mentions are anchored when there are no roots (`closedCallableAuthorityOf`). */
  readonly anchor?: ts.Node
  /** A consumer with finalized intrinsic identities may discharge this directly. */
  readonly explicitInvocationIsIntact?: (call: ts.CallExpression) => boolean
  /** Handed this proof's own frame and caller queries before the walk runs. */
  readonly expose?: (authority: ClosedInvocationAuthority) => void
  readonly exposeOrigins?: (authority: ClosedValueOriginAuthority) => void
  /** A data-slot proof follows every instance of these owners. Its field
   * contents are collected separately from the uses of the owning object. */
  readonly field?: { readonly owners: ReadonlySet<SourceClass>; readonly key: string }
}

/** Complete value sources from one shared caller, receiver and slot proof.
 * @semanticCategory generic-primitive
 */
export interface ClosedValueOriginAuthority {
  readonly bindingValuesOf: (declaration: ts.VariableDeclaration) => readonly ts.Expression[] | null
  readonly classAllocationsOf: (expression: ts.Expression) => ExactClassAllocationOrigins | null
  readonly parameterValuesOf: (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null
  readonly fieldValuesOf: (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression) => readonly ts.Expression[] | null
}

/**
 * ONE receiver-type function per checker and ONE arguments-uses function per
 * flow, not one pair per authority. The proof memo keys on the identity of
 * both; an authority minted per anchor -- `closedClassAllocationOriginsOf`
 * asks for one per EXPRESSION, `derived-expression-type` one per query --
 * with fresh closures gave every one of its proofs a key nothing else could
 * match, so the three.js app ran 17,000 distinct top-level walks that were the same
 * few hundred questions.
 */
const checkerTypeAtByChecker = new WeakMap<ts.TypeChecker, ReceiverTypeAt>()
const checkerTypeAtOf = (checker: ts.TypeChecker): ReceiverTypeAt => {
  let held = checkerTypeAtByChecker.get(checker)
  if (!held) checkerTypeAtByChecker.set(checker, (held = (node) => checker.getTypeAtLocation(node)))
  return held
}
const argumentsUsesAtByFlow = new WeakMap<ValueFlowIndex, (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined>()
const argumentsUsesAtOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex
): ((declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined) => {
  let held = argumentsUsesAtByFlow.get(flow)
  if (held) return held
  const argumentsByFile = new Map<ts.SourceFile, ArgumentsObjectCensus>()
  held = (declaration) => {
    const file = declaration.getSourceFile()
    let census = argumentsByFile.get(file)
    if (!census) argumentsByFile.set(file, (census = censusArgumentsObjects(checker, [file])))
    return census.usesByOwner.get(declaration)
  }
  argumentsUsesAtByFlow.set(flow, held)
  return held
}

export const closedValueOriginAuthorityOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  anchor: ts.Expression
): ClosedValueOriginAuthority => {
  let authority: ClosedValueOriginAuthority | undefined
  closedMemberCallableUses(
    checker,
    flow,
    null,
    new Set(),
    checkerTypeAtOf(checker),
    argumentsUsesAtOf(checker, flow),
    undefined,
    new Set(),
    new Set(),
    {
      roots: [],
      terminalUse: () => null,
      anchor,
      exposeOrigins: (answer) => {
        authority = answer
      }
    }
  )
  return (
    authority ?? { bindingValuesOf: () => null, classAllocationsOf: () => null, parameterValuesOf: () => null, fieldValuesOf: () => null }
  )
}

/** Allocation origins with the shared closed-frame and source-slot authority. */
export const closedClassAllocationOriginsOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  expression: ts.Expression
): ExactClassAllocationOrigins | null => closedValueOriginAuthorityOf(checker, flow, expression).classAllocationsOf(expression)

/**
 * This module's own frame and caller queries -- `parameterValuesOf` and
 * `closedCallerSitesOf`, the same closures every proof here asks -- for a
 * consumer that has to pass a real `ClosedCallableAuthority` (the host
 * mutation census, `class-family-member-read`, `array-element-continuation`,
 * `computed-key-set`). Each call opens one proof context whose memos the two
 * closures share; hold one per flow index and census round, never across
 * rounds. A program with no call, class or array literal has no frame to
 * answer for, and every query refuses.
 */
/** @semanticCategory generic-primitive */
export interface ClosedInvocationAuthority extends ComputedKeySetAuthority {
  /** Complete source bodies entered by this call, including member receivers. */
  readonly invocationFactOf: (call: ts.CallExpression) => SourceInvocationFact | null
  /** The call throws before entering any body: its callee cell only ever holds `null`/`undefined`. */
  readonly callThroughUncallable?: (call: ts.CallExpression | ts.NewExpression) => boolean
  /**
   * Every source body this call's callee can denote, established from the
   * ALLOCATION the receiver traces to -- never from a name match on a
   * candidate body -- or null where that set cannot be closed. This is
   * `invocationFactOf`'s own target selection, exposed on its own: a caller
   * that only needs "which bodies can this call enter" (a host-mutation
   * census asking whether a call can reach anything outside this program)
   * must not also demand `invocationFactOf`'s stricter promise, a complete
   * argument-forwarding frame for every one of those bodies. Three's
   * `properties.get( material )` -- `WebGLProperties()` is a plain factory
   * function returning `{ get: get, ... }`, so `new WebGLProperties()` types
   * `any` under the checker's own JS-constructor inference and no checker
   * declaration ever names this call's callee -- closes here exactly because
   * target identity is a separate fact from frame modelling.
   */
  readonly closedCalleeBodiesOf?: (call: ts.CallExpression) => readonly ts.SignatureDeclaration[] | null
}

export const closedCallableAuthorityOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiverTypeAt: (expression: ts.Expression) => ts.Type | null,
  argumentsUsesAt: (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined,
  explicitInvocationIsIntact?: (call: ts.CallExpression) => boolean
): ClosedInvocationAuthority => {
  const anchor: ts.Node | undefined = flow.calls[0]?.call ?? flow.classDeclarations[0] ?? flow.arrayLiterals[0]
  const held: { authority?: ClosedInvocationAuthority } = {}
  if (anchor)
    closedMemberCallableUses(checker, flow, null, new Set(), receiverTypeAt, argumentsUsesAt, undefined, new Set(), new Set(), {
      roots: [],
      terminalUse: () => null,
      anchor,
      ...(explicitInvocationIsIntact ? { explicitInvocationIsIntact } : {}),
      expose: (authority) => {
        held.authority = authority
      }
    })
  return (
    held.authority ?? {
      checker,
      parameterValuesOf: () => null,
      receiverValuesOf: () => null,
      bindingValuesOf: () => null,
      closedCallerSitesOf: () => null,
      arrayElementTargetsOf: () => null,
      explicitInvocationIsIntact: () => false,
      protocolClosed: () => false,
      numericKey: () => false,
      recordSlotClosed: () => false,
      whenSettled: (publish) => publish(),
      invocationFactOf: () => null,
      closedCalleeBodiesOf: () => null
    }
  )
}

/**
 * The array-callee extension of `closedCallableAuthorityOf`, for a consumer
 * that has to pass a real `CallableArrayOriginAuthority` to
 * `callableArrayTargetsOf` -- three's `EventDispatcher.dispatchEvent` calls
 * every listener through `array[ i ].call( this, event )`, a computed
 * element read no symbol names, and closing it needs the same three
 * collection/protocol queries `closedMemberCallableUses` already builds for
 * its own local `elementCalleeAuthority` (see the `.call`/`.apply` branch of
 * `forwardedInvocationUse` above). This is that authority pulled out as a
 * reusable export, built only from the identical `nativeProtocolClosed`
 * closure and the base `ClosedCallableAuthority`, so a caller outside this
 * module's own escape proof -- one with no `member`/`onOpenUse` of its own --
 * can still ask "every function this array element callee can be".
 */
export const closedArrayCalleeAuthorityOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  receiverTypeAt: (expression: ts.Expression) => ts.Type | null,
  argumentsUsesAt: (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined
): CallableArrayOriginAuthority => {
  const base = closedCallableAuthorityOf(checker, flow, receiverTypeAt, argumentsUsesAt)
  const nativeProtocolClosed = (plan: NativeCollectionProtocolPlan): boolean =>
    plan.deferred
      ? deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys(plan.intrinsic, plan.prototypeKeys, plan.location) === true
      : hasClosedValueUses(checker, flow, plan.roots, plan.terminalUse, receiverTypeAt, argumentsUsesAt)
  /**
   * `callableArrayTargetsOf`'s own array-identity walk has no case for a
   * plain object used as a string-keyed RECORD of arrays (`this._listeners[
   * type ]`, three's `EventDispatcher`) -- see the identical fallback and
   * its full rationale on `elementCalleeAuthority` in
   * `closedMemberCallableUses` above, which this mirrors for the external
   * caller (`parameter-bindings.ts`'s alias-declarations census) that has no
   * access to that internal authority. `base` -- `closedCallableAuthorityOf`'s
   * own return -- already satisfies `OriginAuthority`'s required surface
   * (`parameterValuesOf`, `protocolClosed`, `numericKey`, `recordSlotClosed`,
   * `receiverValuesOf`, `closedCallerSitesOf`, `explicitInvocationIsIntact`,
   * `invocationFactOf`, `bindingValuesOf`), so no new authority shape is
   * needed here.
   */
  const arrayElementTargetsViaRecordOf = (
    element: ts.ElementAccessExpression
  ): readonly (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction)[] | null => {
    if (!base.numericKey(element.argumentExpression)) return null
    const values = arrayStoredValuesOf(checker, flow, element.expression, base)
    if (values === null) return null
    const targets = new Set<ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction>()
    for (const value of values) {
      const resolved = closedCallableTargetsOf(checker, flow, value, base)
      if (resolved === null) return null
      for (const body of resolved) targets.add(body)
    }
    return targets.size > 0 ? [...targets] : null
  }
  const authority: CallableArrayOriginAuthority = {
    ...base,
    arrayElementTargetsOf: (element) =>
      callableArrayTargetsOf(checker, flow, element, authority) ?? arrayElementTargetsViaRecordOf(element),
    collectionValuesOf: (read) => collectionStoredValuesOf(checker, flow, read, nativeProtocolClosed),
    collectionReadsOf: (store, value) => collectionValueContinuationsOf(checker, flow, store, value, nativeProtocolClosed),
    arrayProtocolClosed: (array) => {
      const plan = nativeArrayProtocolPlanOf(checker, flow, array)
      return plan !== null && nativeProtocolClosed(plan)
    }
  }
  return authority
}

/**
 * Every place the program can install a value in a member slot, indexed once
 * per flow: named writes by key, computed-key writes, and the intrinsic
 * mutators that define or replace properties on an object they are handed.
 * `memberSlotWritesClosed` asks this per slot; scanning the reachable access
 * list per ask would be hundreds of keys times every access in three.
 */
interface SlotWriteInventory {
  readonly namedWrites: ReadonlyMap<string, readonly (ts.PropertyAccessExpression | ts.ElementAccessExpression)[]>
  readonly computedWrites: readonly ts.ElementAccessExpression[]
  readonly intrinsicMutators: readonly { readonly call: ts.CallExpression; readonly name: string }[]
}
const slotWriteInventories = new WeakMap<ValueFlowIndex, SlotWriteInventory>()
const INTRINSIC_PROPERTY_MUTATORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'])],
  ['Reflect', new Set(['set', 'defineProperty', 'setPrototypeOf'])]
])
/**
 * The standard-library functions whose algorithm invokes user code on an
 * OBJECT argument -- accessor gets over its own properties (`Object.values`),
 * `ToPrimitive`/`ToString` (`String`, `JSON.stringify` and its `toJSON`), the
 * iteration protocol (`Array.from`, the collection constructors), or a
 * thenable's `then` (`Promise.resolve`). `familyInstancesEscape` treats an
 * instance handed to one of these as having left the program; every other
 * library callee only stores or reads what it is given.
 */
const LIBRARY_ARGUMENT_EVALUATORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['values', 'entries', 'fromEntries', 'groupBy'])],
  ['JSON', new Set(['stringify'])],
  ['Array', new Set(['from', 'fromAsync'])],
  ['Promise', new Set(['resolve', 'all', 'allSettled', 'any', 'race'])],
  ['Map', new Set(['groupBy'])]
])
const LIBRARY_ARGUMENT_EVALUATOR_CONSTRUCTORS: ReadonlySet<string> = new Set(['String', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array'])
/** Whether the library call `node` is one of `LIBRARY_ARGUMENT_EVALUATORS`, or `String( x )`/`new Map( x )` and their kind. */
const runsArgumentCode = (node: ts.CallExpression | ts.NewExpression): boolean => {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return LIBRARY_ARGUMENT_EVALUATOR_CONSTRUCTORS.has(callee.text)
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (LIBRARY_ARGUMENT_EVALUATORS.get(callee.expression.text)?.has(callee.name.text) ?? false)
  )
}
/** Whether `access` is written -- assigned, compound-assigned, incremented, deleted, or a destructuring/for-in-of target. */
const accessIsWritten = (access: ts.Expression): boolean => {
  let current: ts.Node = access
  let parent = current.parent
  while (
    (ts.isParenthesizedExpression(parent) && parent.expression === current) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === current) ||
    (ts.isSpreadAssignment(parent) && parent.expression === current) ||
    (ts.isSpreadElement(parent) && parent.expression === current) ||
    (ts.isObjectLiteralExpression(parent) && (parent.properties as readonly ts.Node[]).includes(current)) ||
    (ts.isArrayLiteralExpression(parent) && (parent.elements as readonly ts.Node[]).includes(current))
  ) {
    current = parent
    parent = current.parent
  }
  if (ts.isDeleteExpression(parent) && parent.expression === current) return true
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === current &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return true
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === current &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current)
  )
}
const slotWriteInventoryOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): SlotWriteInventory => {
  const held = slotWriteInventories.get(flow)
  if (held) return held
  const namedWrites = new Map<string, (ts.PropertyAccessExpression | ts.ElementAccessExpression)[]>()
  const computedWrites: ts.ElementAccessExpression[] = []
  for (const access of flow.propertyAccesses) {
    if (!accessIsWritten(access)) continue
    const key = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
    if (key === null) {
      if (ts.isElementAccessExpression(access)) computedWrites.push(access)
      continue
    }
    const entries = namedWrites.get(key)
    if (entries) entries.push(access)
    else namedWrites.set(key, [access])
  }
  const intrinsicMutators: { readonly call: ts.CallExpression; readonly name: string }[] = []
  for (const site of flow.calls) {
    const call = site.call
    if (!ts.isCallExpression(call)) continue
    const callee = unwrapNaming(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) continue
    const names = INTRINSIC_PROPERTY_MUTATORS.get(callee.expression.text)
    if (!names || !names.has(callee.name.text)) continue
    // Only the host's own `Object`/`Reflect`: a program binding shadowing the
    // name is program code, whose writes this inventory already holds. An
    // unresolvable name is kept -- it may still be the host's.
    const symbol = checker.getSymbolAtLocation(callee.expression)
    if (symbol && !(symbol.declarations ?? []).every((declaration) => declaration.getSourceFile().isDeclarationFile)) continue
    intrinsicMutators.push({ call, name: callee.name.text })
  }
  const built: SlotWriteInventory = { namedWrites, computedWrites, intrinsicMutators }
  slotWriteInventories.set(flow, built)
  return built
}

const activeValueProofs = new WeakMap<ValueFlowIndex, Map<readonly ts.Expression[], Set<ClosedValueMode['terminalUse']>>>()
/** The same terminals, flat, so the proof memo can ask whether an assumed one is still in force. */
const activeValueTerminals = new WeakMap<ValueFlowIndex, Set<ClosedValueMode['terminalUse']>>()

/** Follow every use of an explicit value family using the same publication
 * graph as member closure, with protocol-specific terminal observations. */
export const hasClosedValueUses = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  roots: readonly ts.Expression[],
  terminalUse: ClosedValueMode['terminalUse'],
  receiverTypeAt: (expression: ts.Expression) => ts.Type | null,
  argumentsUsesAt: (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined,
  onOpenUse?: (
    reference: ts.Expression,
    kind: 'receiver' | 'containing-object' | 'member-reference-inventory' | 'member-receiver-inventory'
  ) => void,
  identity?: string,
  ownPark?: object
): boolean => {
  let active = activeValueProofs.get(flow)
  if (!active) activeValueProofs.set(flow, (active = new Map()))
  let terminals = active.get(roots)
  if (!terminals) active.set(roots, (terminals = new Set()))
  if (terminals.has(terminalUse)) {
    noteAssumption(terminalUse)
    return true
  }
  let flat = activeValueTerminals.get(flow)
  if (!flat) activeValueTerminals.set(flow, (flat = new Set()))
  terminals.add(terminalUse)
  flat.add(terminalUse)
  try {
    return hasClosedMemberCallableUses(checker, flow, null, new Set(), receiverTypeAt, argumentsUsesAt, onOpenUse, new Set(), new Set(), {
      roots,
      terminalUse,
      ...(identity === undefined ? {} : { identity }),
      ...(ownPark === undefined ? {} : { ownPark })
    })
  } finally {
    terminals.delete(terminalUse)
    flat.delete(terminalUse)
    if (terminals.size === 0) active.delete(roots)
  }
}

type OpenUseKind = 'receiver' | 'containing-object' | 'member-reference-inventory' | 'member-receiver-inventory'

/**
 * Answers to member-closure proofs, shared across the round.
 *
 * A three.js compile runs millions of these proofs over a few hundred
 * distinct members. A top-level proof assumes nothing on entry, so its answer
 * is a pure function of (member, counted calls, receiverTypeAt,
 * argumentsUsesAt, valueMode). A NESTED proof's answer holds only under the
 * `activeMembers`/`activeFamilies` assumptions it actually leaned on, so each
 * answer records `assumed`: the INHERITED assumptions some guard below it
 * fired for. An answer is reusable exactly where every one of those is
 * active again -- the same coinductive park is in force, so the same
 * proof would run the same way -- and a top-level answer (`assumed` empty)
 * is reusable anywhere. Before this, nested proofs were never cached at all,
 * and once the graph session started asking the legacy walk from inside its
 * own solve, the three.js app ran 4.9 million nested proofs in its first 150 s with
 * 6,000 memo hits, most of them recomputing the same member under the same
 * handful of parked families.
 *
 * `assumed` is exact, not conservative: the active sets are read at four
 * guards, each notes the key it fired for on the running proof's trail, and a
 * proof keeps only the keys its CALLER handed it (`activeMembers ∪
 * activeFamilies`). A key the proof or a descendant added itself is that
 * proof's own self-coinduction, which a top-level proof of the same member
 * makes too, so it constrains nothing. What a proof keeps is also what it
 * reports upward, and a memo hit reports its `assumed` the same way, so an
 * enclosing proof's trail is right whether the answer was computed or replayed.
 *
 * ⛔ A hit MUST replay both side effects the proof would have had, or the cache
 * silently degrades the compile rather than speeding it up:
 *   - `onOpenUse`, which `parameter-bindings` uses to build `memberOpenUses`,
 *     the open-use path it reports for a refusal. Dropping it leaves refusals
 *     with an empty, unexplained path.
 *   - the deferred intrinsic-protocol requirements, which reach emitted output.
 *     `guard` only publishes them when the proof answered closed, so the replay
 *     is conditioned the same way.
 */
interface ProofAnswer {
  readonly counted: ReadonlySet<ts.CallExpression | ts.NewExpression>
  /**
   * Mutable, because a hypothesis is not permanent: when the guard that issued
   * one goes on to answer its own question the same way, `exitHypothesisGuard`
   * drops the key from here and this answer becomes that much less conditional
   * -- unconditional once the last one goes. See `proof-hypotheses.ts`.
   */
  readonly assumed: Set<object>
  /**
   * Keys this answer leaned on that it could NEITHER ground (they are not
   * among its inherited parks) NOR discharge (they are not its own member or
   * family). A hit must re-report them, or an enclosing memo would keep an
   * answer resting on a hypothesis it never heard of -- which is precisely
   * what made a refusal unshareable before any of them were recorded.
   */
  readonly escaped: ReadonlySet<object>
  readonly closed: boolean
  readonly requirements: readonly IntrinsicProtocolRequirement[]
  readonly opens: readonly (readonly [ts.Expression, OpenUseKind])[]
}
type ReceiverTypeAtFn = (expression: ts.Expression) => ts.Type | null
type ArgumentsUsesAtFn = (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined
/**
 * Indexed by every identity-compared part of the key before the list, so a
 * lookup scans only answers that can match. A flat list per member scanned
 * 120 million entries in the three.js app's first 150 s: value-mode proofs mint a
 * fresh `valueMode` object per call, so every one of them was a miss that
 * still walked the 5,000 entries before it.
 */
type ProofAnswerIndex = WeakMap<
  ValueFlowIndex,
  Map<ts.Symbol | null, WeakMap<ReceiverTypeAtFn, WeakMap<ArgumentsUsesAtFn, Map<ClosedValueMode | string | undefined, ProofAnswer[]>>>>
>
const proofAnswers: ProofAnswerIndex = new WeakMap()
const sameCountedCalls = (
  a: ReadonlySet<ts.CallExpression | ts.NewExpression>,
  b: ReadonlySet<ts.CallExpression | ts.NewExpression>
): boolean => {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const call of a) if (!b.has(call)) return false
  return true
}

const activeFieldReadsByFlow = new WeakMap<ValueFlowIndex, Set<ts.Expression>>()

/**
 * Shared answers to `fieldValuesOf`'s class-instance walk, by content.
 *
 * The walk's own field-mode proof mints a fresh `terminalUse` closure per
 * call and COLLECTS the field's values as a side effect of that closure, so
 * the proof memo can neither key it nor replay it: in the three.js app 456,000 of the
 * 459,000 answers the memo stored in three minutes were field-mode proofs
 * that no later call could match. The question is a function of (owner
 * classes, key, receiverTypeAt, argumentsUsesAt) and of the parks in force,
 * so it is shared exactly like a proof answer: `assumed` names the parks the
 * walk leaned on, and a hit replays the open uses and the intrinsic
 * requirements the computation reported.
 */
interface FieldAnswer {
  readonly assumed: ReadonlySet<object>
  /** See `ProofAnswer.escaped`: replayed on a hit, never part of applicability. */
  readonly escaped: ReadonlySet<object>
  readonly values: readonly ts.Expression[] | null
  readonly requirements: readonly IntrinsicProtocolRequirement[]
  readonly opens: readonly (readonly [ts.Expression, OpenUseKind])[]
}
type FieldAnswerIndex = WeakMap<
  ValueFlowIndex,
  WeakMap<ReceiverTypeAtFn, WeakMap<ArgumentsUsesAtFn, WeakMap<ts.Expression, FieldAnswer[]>>>
>
const fieldAnswers: FieldAnswerIndex = new WeakMap()
const fieldStats = { asks: 0, hits: 0, stores: 0 }

/**
 * A provenance answer (`OriginAuthority.sharedAnswerOf`) shared across
 * proofs exactly like a field answer: keyed by its caller-spelled identity,
 * the two key functions and the value mode's explicit-invocation check (the
 * only piece of a value mode a record plan or array inventory can observe),
 * and valid wherever the parks it leaned on are in force.
 */
interface SharedAnswer {
  readonly assumed: ReadonlySet<object>
  /** See `ProofAnswer.escaped`: replayed on a hit, never part of applicability. */
  readonly escaped: ReadonlySet<object>
  readonly value: unknown
  readonly requirements: readonly IntrinsicProtocolRequirement[]
  readonly opens: readonly (readonly [ts.Expression, OpenUseKind])[]
}
type SharedAnswerIndex = WeakMap<ValueFlowIndex, WeakMap<ReceiverTypeAtFn, WeakMap<ArgumentsUsesAtFn, Map<string, SharedAnswer[]>>>>
const sharedAnswers: SharedAnswerIndex = new WeakMap()
/**
 * `GEA_REFUSAL_MEMO=0` recomputes every refusal instead of replaying the
 * stored one.
 *
 * It exists because the tree this is measured in has several editors at once:
 * a before/after pair taken hours apart also carries everyone else's root
 * fixes, and neither `boxed` nor the refusal SITE set can then be attributed.
 * Two runs of ONE build, one with the switch off, isolate exactly this memo.
 * The trail bookkeeping stays armed in both arms -- it is what makes the
 * stored refusal sound, not what makes it fast.
 */
const refusalMemoEnabled = process.env['GEA_REFUSAL_MEMO'] !== '0'

const sharedStats = { asks: 0, hits: 0, stores: 0, refusals: 0, ungrounded: 0 }
const intactCheckIds = new WeakMap<object, number>()
let intactChecksSeen = 0
const intactCheckIdOf = (check: object | undefined): string => {
  if (!check) return 'ledger'
  let id = intactCheckIds.get(check)
  if (id === undefined) intactCheckIds.set(check, (id = ++intactChecksSeen))
  return String(id)
}

/**
 * The assumption trail machinery lives in `proof-hypotheses.ts` so a module
 * this one imports (`source-record-data.ts`) can record ITS re-entry guards on
 * the same stack; an optimistic park and a re-entry refusal are the same kind
 * of hypothesis and a memo must weigh both the same way.
 */
const noteAssumption = noteHypothesis

/**
 * `GEA_PROOF_STATS=<n>` prints the memo's counters to stderr every n proof
 * entries. A whole-program compile is one synchronous computation, so an exit
 * hook or a timer would report nothing from a run that has to be killed to be
 * observed; a line every n entries is what survives.
 */
/**
 * How many CONDITIONAL answers one proof key keeps before it stops storing
 * more. Tunable with `GEA_ANSWER_LIMIT` so the cap itself can be measured
 * rather than argued about.
 */
const CONDITIONAL_ANSWER_LIMIT = Number(process.env['GEA_ANSWER_LIMIT'] ?? 8)
const proofStatsEvery = Number(process.env['GEA_PROOF_STATS'] ?? 0)
// TEMPORARY INSTRUMENT -- not for landing. Attributes proof entries to the
// call site that asked, which is the only thing that says whether the
// millions of entries are distinct questions or one caller re-asking.
const askSites = new Map<string, number>()
// TEMPORARY INSTRUMENT -- not for landing. Names the QUESTION each proof entry
// asks, so repeats can be told from distinct work, and captures the call chain
// behind the hottest one.
const askQuestions = new Map<string, number>()
/** TEMPORARY INSTRUMENT -- not for landing. Memoized member names for the census above. */
const nullMemberName: object = Object.freeze({})
const askMemberNames = new WeakMap<ts.Symbol | object, string>()
// The host runs node with --stack-trace-limit=10; the chain behind a repeated
// question is deeper than that.
Error.stackTraceLimit = 40
const askChains = new Map<string, Map<string, number>>()
const proofStats = {
  entries: 0,
  nested: 0,
  hits: 0,
  stores: 0,
  scanned: 0,
  longest: 0,
  members: 0,
  receiverFns: 0,
  argumentFns: 0,
  valueModes: 0,
  valueModeStores: 0,
  // TEMPORARY INSTRUMENT -- not for landing. `longest` says a bucket reached
  // thousands of answers but not WHICH question owns it, and with 68 members
  // and millions of entries that name is the whole lead.
  longestMember: '',
  longestNested: false,
  unconditionalStores: 0,
  topLevelEntries: 0,
  droppedByGuard: 0,
  droppedByLimit: 0,
  kept: 0,
  // TEMPORARY INSTRUMENT -- not for landing. Classifies what a stored answer
  // leaned on, to tell a DURABLE park (member/family nesting, which recurs)
  // from a park whose key is a per-call throwaway object that can never be
  // presented again.
  assumedRecordProof: 0,
  assumedValueTerminal: 0,
  assumedFieldRead: 0,
  assumedMemberFamily: 0
}
const topAskSites = (): string =>
  [...askSites.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([site, count]) => `\n    ${count} ${site}`)
    .join('')
const topQuestions = (): string => {
  const ranked = [...askQuestions.entries()].sort((a, b) => b[1] - a[1])
  const lines = ranked.slice(0, 8).map(([question, count]) => `\n    ${count}  ${question.slice(0, 120)}`)
  const hottest = ranked[0]
  const chains = hottest ? [...(askChains.get(hottest[0]) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]) : []
  const shown = chains.slice(0, 3).map(([chain, count]) => `\n      x${count} ${chain}`)
  return `${askQuestions.size} distinct${lines.join('')}\n    [CHAINS of hottest]${shown.join('')}`
}
export const memberProofStats = (): string =>
  `[PROOF-STATS] entries=${proofStats.entries} nested=${proofStats.nested} hits=${proofStats.hits} stores=${proofStats.stores} ` +
  `scanned=${proofStats.scanned} longest=${proofStats.longest}/${proofStats.longestMember}${proofStats.longestNested ? ':nested' : ':top'} ` +
  `topLevel=${proofStats.topLevelEntries} unconditionalStores=${proofStats.unconditionalStores} assumptionHits=${hypothesisNotes()} originSolvers=${seededOriginSolvers()} ` +
  `kept=${proofStats.kept} droppedByGuard=${proofStats.droppedByGuard} droppedByLimit=${proofStats.droppedByLimit} ` +
  `hyp: registered=${hypothesisStats.registered} confirmed=${hypothesisStats.confirmed} struck=${hypothesisStats.struck} discarded=${hypothesisStats.discarded} ` +
  `leans: recordProof=${proofStats.assumedRecordProof} valueTerminal=${proofStats.assumedValueTerminal} fieldRead=${proofStats.assumedFieldRead} memberFamily=${proofStats.assumedMemberFamily} ` +
  `shared: asks=${sharedStats.asks} hits=${sharedStats.hits} stores=${sharedStats.stores} refusalStores=${sharedStats.refusals} ungroundedRefusals=${sharedStats.ungrounded} ` +
  `keys: members=${proofStats.members} receiverFns=${proofStats.receiverFns} argumentFns=${proofStats.argumentFns} valueModes=${proofStats.valueModes} valueModeStores=${proofStats.valueModeStores} ` +
  `fields: asks=${fieldStats.asks} hits=${fieldStats.hits} stores=${fieldStats.stores}` +
  `\n  [ASK-SITES]${topAskSites()}` +
  `\n  [QUESTIONS] ${topQuestions()}`

const EMPTY_KEYS: ReadonlySet<never> = new Set()

/**
 * The class (or constructor function) a member declaration belongs to.
 *
 * At module level because the member proof's memo needs it BEFORE the proof
 * body's own scope exists: `share` has to tell a key its own coinduction
 * discharged from one it merely leaned on, and the first kind is exactly the
 * families of the member being proven.
 */
const memberOwnerClassIn = (flow: ValueFlowIndex, declaration: ts.Node): SourceClass | null => {
  if (ts.isClassElement(declaration)) {
    const owner = declaration.parent
    return ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? owner : null
  }
  const assignment = ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) ? declaration.parent : declaration
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    (!ts.isPropertyAccessExpression(assignment.left) && !ts.isElementAccessExpression(assignment.left)) ||
    unwrapNaming(assignment.left.expression).kind !== ts.SyntaxKind.ThisKeyword
  )
    return null
  const frame = flow.receiverOwnerOf(unwrapNaming(assignment.left.expression))
  // A constructor function OWNS the `this.<key> = ...` writes in its own
  // body the way a class owns its elements -- there is no enclosing class to
  // step out to, and asking for one is why every member of three's pre-ES6
  // renderer factories had no owner class and so no family at all.
  if (frame && isConstructorFunction(frame)) return frame
  const owner = frame && ts.isClassElement(frame) ? frame.parent : undefined
  return owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) ? owner : null
}

export const hasClosedMemberCallableUses = (...parameters: Parameters<typeof closedMemberCallableUses>): boolean => {
  const checker = parameters[0]
  const flow = parameters[1]
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  const [, , member, counted, givenReceiverTypeAt, argumentsUsesAt, onOpenUse, activeMembers, activeFamilies, valueMode] = parameters
  const inheritedMembers: ReadonlySet<ts.Symbol> = activeMembers ?? EMPTY_KEYS
  const inheritedFamilies: ReadonlySet<SourceClass> = activeFamilies ?? EMPTY_KEYS
  // Key on the one wrapper per given authority, so a nested proof (handed the
  // wrapper) and a top-level one (handed the raw function) share answers.
  const receiverTypeAt = ownedConstructionReceiverTypeAt(checker, flow, givenReceiverTypeAt)
  const nested = inheritedMembers.size !== 0 || inheritedFamilies.size !== 0
  proofStats.entries++
  if (proofStatsEvery > 0) {
    // `getName()` per entry made the census itself a measurable slice of the
    // very function it instruments -- 10M symbol lookups charged to the memo
    // probe, which is the opposite of what an instrument is for.
    let memberName = askMemberNames.get(member ?? nullMemberName)
    if (memberName === undefined) askMemberNames.set(member ?? nullMemberName, (memberName = member?.getName() ?? '(null-member)'))
    const modeName = valueMode?.identity ?? (valueMode === undefined ? '(no-mode)' : '(unkeyed-mode)')
    const question = `${memberName} | ${modeName}`
    askQuestions.set(question, (askQuestions.get(question) ?? 0) + 1)
  }
  if (nested) proofStats.nested++
  if (proofStatsEvery > 0 && proofStats.entries % proofStatsEvery === 0) console.error(memberProofStats())
  let byMember = proofAnswers.get(flow)
  if (!byMember) proofAnswers.set(flow, (byMember = new Map()))
  let byReceiverTypeAt = byMember.get(member)
  if (!byReceiverTypeAt) {
    proofStats.members++
    byMember.set(member, (byReceiverTypeAt = new WeakMap()))
  }
  let byArgumentsUsesAt = byReceiverTypeAt.get(receiverTypeAt)
  if (!byArgumentsUsesAt) {
    proofStats.receiverFns++
    byReceiverTypeAt.set(receiverTypeAt, (byArgumentsUsesAt = new WeakMap()))
  }
  let byValueMode = byArgumentsUsesAt.get(argumentsUsesAt)
  if (!byValueMode) {
    proofStats.argumentFns++
    byArgumentsUsesAt.set(argumentsUsesAt, (byValueMode = new Map()))
  }
  const modeKey = valueMode?.identity ?? valueMode
  let answers = byValueMode.get(modeKey)
  if (!answers) {
    proofStats.valueModes++
    byValueMode.set(modeKey, (answers = []))
  }
  if (!nested) proofStats.topLevelEntries++
  if (answers.length > proofStats.longest) {
    proofStats.longest = answers.length
    proofStats.longestMember = member?.getName() ?? '(no member)'
    proofStats.longestNested = nested
  }
  // The parks an answer may lean on: the member and family sets this proof
  // was handed, plus the two module-level coinductions -- an active record
  // proof (`recordRootsClosed`) and an active value proof (`hasClosedValueUses`)
  // -- which park by object identity and are in force for exactly as long as
  // their object is in the active set.
  // Split so `share` (below) can tell a DURABLE park -- the member/family
  // nesting and the three coinductive proof sets, all bounded by this whole
  // program's own proof depth -- from a re-entry GUARD, which is `answers`'
  // own newest kind of assumption and the cheapest-looking, most misleading
  // one: `source-record-data.ts`'s per-call-site re-entrancy tracking notes
  // one of these per method call or slot read that happened to be re-entrant
  // WHILE this member was being proven, and it closes the instant that one
  // synchronous call returns. An answer gated on one is still correct to
  // keep -- `inherited` below still requires the guard to be open again
  // before reuse -- but it is also, for all practical purposes, gated on a
  // fact that will never recur: the three.js app's `answers` arrays grew without
  // bound on exactly these entries, and this proof's linear scan over them
  // (`inherited(key)` per assumed key, per stored answer, per call) was over
  // 90% of a stuck compile's sampled time (`measurements/live-*.cpuprofile`).
  // `share` skips caching an answer whose assumed set leans on a guard for
  // exactly that reason -- not a correctness fix, a population-growth one;
  // recomputing on the rare re-ask is always safe.
  const inheritedPark = (key: object): boolean =>
    inheritedMembers.has(key as ts.Symbol) ||
    inheritedFamilies.has(key as SourceClass) ||
    (activeRecordProofs.get(flow)?.has(key as never) ?? false) ||
    (activeValueTerminals.get(flow)?.has(key as ClosedValueMode['terminalUse']) ?? false) ||
    (activeFieldReadsByFlow.get(flow)?.has(key as ts.Expression) ?? false)
  const inherited = (key: object): boolean => inheritedPark(key) || hypothesisGuardIsOpen(key)
  // The three per-`flow` park sets are read once for the whole scan instead of
  // three WeakMap lookups per assumed key per stored answer. Nothing between
  // here and the loop's `return` can install or replace them: the scan only
  // reads, and the callbacks that could mutate (`noteAssumption`, `onOpenUse`,
  // `ledger.include`) run on the HIT path, after which this returns
  // immediately. `share` still calls the unhoisted `inheritedPark`, because it
  // runs AFTER the proof body and must see the sets as they are then.
  //
  // This is the scan's dominant term, not a micro-optimisation: a live profile
  // of a three.js compile put `inheritedPark` at 14.3% of all samples on its
  // own (`measurements/live-baseline.cpuprofile`), reached
  // `answers.length` x `assumed.size` times per question.
  const scanRecordProofs = activeRecordProofs.get(flow)
  const scanValueTerminals = activeValueTerminals.get(flow)
  const scanFieldReads = activeFieldReadsByFlow.get(flow)
  const scanInherited = (key: object): boolean =>
    inheritedMembers.has(key as ts.Symbol) ||
    inheritedFamilies.has(key as SourceClass) ||
    (scanRecordProofs?.has(key as never) ?? false) ||
    (scanValueTerminals?.has(key as ClosedValueMode['terminalUse']) ?? false) ||
    (scanFieldReads?.has(key as ts.Expression) ?? false) ||
    hypothesisGuardIsOpen(key)
  for (const answer of answers) {
    proofStats.scanned++
    if (!sameCountedCalls(answer.counted, counted)) continue
    let applies = true
    for (const key of answer.assumed)
      if (!scanInherited(key)) {
        applies = false
        break
      }
    if (!applies) continue
    proofStats.hits++
    for (const key of answer.assumed) noteAssumption(key)
    for (const key of answer.escaped) noteAssumption(key)
    for (const [reference, kind] of answer.opens) onOpenUse?.(reference, kind)
    if (answer.closed && ledger) ledger.include(answer.requirements)
    return answer.closed
  }
  // Deduplicated: a nested memo hit replays its open uses into THIS proof's
  // record, so the same (reference, kind) arrives once per nested question
  // that reported it, and every enclosing proof would have stored a copy.
  // The three.js app retained 20 GB of these lists in 50 s before the map.
  const opens = new Map<ts.Expression, Set<OpenUseKind>>()
  const record = (reference: ts.Expression, kind: OpenUseKind): void => {
    let kinds = opens.get(reference)
    if (!kinds) opens.set(reference, (kinds = new Set()))
    if (kinds.has(kind)) return
    kinds.add(kind)
    onOpenUse?.(reference, kind)
  }
  const observed = [...parameters] as Parameters<typeof closedMemberCallableUses>
  observed[6] = record
  // The families this proof parks on its own behalf, read lazily: the answer
  // for `member` is a greatest fixpoint over them, so leaning on them is a
  // discharge, not an open assumption.
  let ownFamilies: Set<SourceClass> | null = null
  const ownCoinduction = (): ReadonlySet<SourceClass> => {
    if (ownFamilies === null) {
      ownFamilies = new Set()
      for (const declaration of member?.declarations ?? []) {
        const owner = memberOwnerClassIn(flow, declaration)
        if (owner !== null) ownFamilies.add(owner)
      }
    }
    return ownFamilies
  }
  const trail = pushHypothesisTrail()
  const work = (): boolean => {
    try {
      return closedMemberCallableUses(...observed)
    } finally {
      popHypothesisTrail()
    }
  }
  const share = (closed: boolean, requirements: readonly IntrinsicProtocolRequirement[]): void => {
    const assumed = new Set<object>()
    // A key that is neither inherited nor this proof's OWN coinduction is a
    // hypothesis nobody here can discharge, and an enclosing memo has to hear
    // about it -- that is what makes a refusal shareable or not. The own
    // member and its families are exactly what this proof does discharge, so
    // they stop here; passing them on would make every enclosing answer look
    // ungroundable and the memo would keep nothing.
    const escaped = new Set<object>()
    // Whether any assumed key is a re-entry GUARD rather than a durable park
    // -- see `inheritedPark`/`inherited` above. Gates whether this answer is
    // worth the shared list's own scan cost, never whether it is correct.
    let leansOnReentryGuard = false
    for (const key of trail) {
      // This proof's OWN parks, discharged here and passed to nobody -- the
      // same treatment `member` and `ownCoinduction` already get, and for the
      // same reason. `hasClosedValueUses` parks `terminalUse` for this call
      // alone, and a record-root proof parks `ownPark` for this call alone;
      // both are released the instant this returns. Recording them as
      // assumptions made every value-mode answer permanently inapplicable --
      // of 157,871 answers one three.js run stored, 18 were unconditional --
      // so the memo held nothing and the same question was re-proven millions
      // of times. A park an ENCLOSING proof established is untouched by this:
      // it is not this mode's own, so it still lands in `assumed`.
      if (valueMode !== undefined && (key === valueMode.terminalUse || key === valueMode.ownPark)) continue
      if (inherited(key)) {
        assumed.add(key)
        noteAssumption(key)
        if (!inheritedPark(key)) leansOnReentryGuard = true
      } else if (key !== member && !ownCoinduction().has(key as SourceClass)) {
        escaped.add(key)
        noteAssumption(key)
      }
    }
    proofStats.stores++
    if (leansOnReentryGuard) proofStats.droppedByGuard++
    if (assumed.size === 0) proofStats.unconditionalStores++
    else {
      let recordProof = false
      let valueTerminal = false
      let fieldRead = false
      let memberFamily = false
      for (const key of assumed) {
        if (inheritedMembers.has(key as ts.Symbol) || inheritedFamilies.has(key as SourceClass)) memberFamily = true
        else if (activeRecordProofs.get(flow)?.has(key as never)) recordProof = true
        else if (activeValueTerminals.get(flow)?.has(key as ClosedValueMode['terminalUse'])) valueTerminal = true
        else if (activeFieldReadsByFlow.get(flow)?.has(key as ts.Expression)) fieldRead = true
      }
      if (recordProof) proofStats.assumedRecordProof++
      if (valueTerminal) proofStats.assumedValueTerminal++
      if (fieldRead) proofStats.assumedFieldRead++
      if (memberFamily) proofStats.assumedMemberFamily++
    }
    if (valueMode !== undefined) proofStats.valueModeStores++
    const recorded: (readonly [ts.Expression, OpenUseKind])[] = []
    for (const [reference, kinds] of opens) for (const kind of kinds) recorded.push([reference, kind])
    // A guard-gated answer used to be dropped here, on the reasoning that the
    // guard will not be open again once this synchronous call returns. The
    // reasoning was right and the conclusion was wrong: the guard does not
    // reopen, but the question it protects gets a REAL answer moments later,
    // and when that answer is what the guard handed out the hypothesis has
    // become a fact. `registerGuardedAnswer` holds the answer until then and
    // `exitHypothesisGuard` settles it -- discharging the key, or striking the
    // answer if the real answer contradicted it.
    //
    // Dropping them instead was the whole cost: in 200,000 three.js proof
    // entries this memo computed 156,070 answers and KEPT 119. Every later ask
    // of the same question proved it again, which is how 64 distinct questions
    // become millions of proof entries.
    //
    // The list is still BOUNDED. An unconditional answer always applies and is
    // always worth keeping; a conditional one is kept only while the bucket is
    // short enough that scanning it stays cheaper than the recompute it saves.
    // Dropping a storable answer is never a correctness question -- a miss
    // recomputes and gets the same result.
    if (assumed.size !== 0 && answers.length >= CONDITIONAL_ANSWER_LIMIT) proofStats.droppedByLimit++
    if (assumed.size === 0 || answers.length < CONDITIONAL_ANSWER_LIMIT) {
      proofStats.kept++
      const stored: ProofAnswer = { counted, assumed, escaped, closed, requirements, opens: recorded }
      answers.push(stored)
      if (leansOnReentryGuard)
        registerGuardedAnswer(stored, () => {
          const at = answers.indexOf(stored)
          if (at !== -1) answers.splice(at, 1)
        })
    }
  }
  if (!ledger) {
    const closed = work()
    share(closed, [])
    return closed
  }
  const captured = ledger.capture(work)
  if (captured.value) ledger.include(captured.requirements)
  share(captured.value, captured.requirements)
  return captured.value
}

/**
 * `GEA_MEMBER_CLOSURE_DEBUG=<member>[,<member>]|*` names WHICH of this proof's
 * refusal points answered "open" for a member slot.
 *
 * The two instruments beside it each see half of that. `GEA_RECEIVER_DEBUG`
 * traces the receiver WALK, so it stops at the boundary where the walk asks
 * this proof a question; `GEA_BINDING_DEBUG` prints the chain of open uses,
 * which simply ENDS -- with no reason attached -- whenever the refusal is one
 * of the inventory closures at the bottom of this function that report no open
 * use at all. `Object3D.copy` refused there, and both instruments showed a
 * chain that terminated for no stated cause.
 */
const memberClosureDebug = process.env['GEA_MEMBER_CLOSURE_DEBUG']

/**
 * How many receiver/container/publish questions have been answered OPEN so far,
 * and the count as it stood when the frame now executing began.
 *
 * A refusal that raised the count during its own body is REPEATING a refusal
 * from below; one that did not is a LEAF -- the place the chain actually stops.
 * The whole-program proof is one strongly connected component, so a bare
 * refusal count ranks the wrong population: 3988 sites reporting
 * `receiver-open` for the same scene graph are 3988 repetitions of a handful of
 * leaves, and only the leaves are fixable.
 *
 * ⚠ MODULE level, not per proof. A member-slot question re-enters through a
 * FRESH `indexCallableReach`, so counters scoped to one proof cannot see the
 * refusals raised inside a nested one -- which made every `receiver-cell:this
 * callers=null` line report as a leaf when the thing that actually refused was
 * the member-closure proof it launched. The counters are a monotonic tick, so
 * sharing them across instances is what makes "did anything below me refuse"
 * mean what it says.
 */
let openWalkAnswers = 0
let walkFrame = 0
/** How many leaf lines have been emitted, so one refusal is reported once. */
let leafReports = 0
const watchedLeafDebug = process.env['GEA_LEAF_DEBUG']

/**
 * `GEA_LEAF_DEBUG='*'` used to see only the `receiver` walk's own leaves
 * (through `leafRefusal`/`traceReceiver`): `receiverInFamily`'s seven
 * sub-checks (behind `GEA_RECEIVER_FAMILY_DEBUG`) and the member-closure
 * scan's own refusal points (behind `GEA_MEMBER_CLOSURE_DEBUG`) reported to
 * two DIFFERENT env vars, so a `'*'` leaf run never saw them and a session
 * had to already suspect which arm was refusing before it could watch it.
 * `recordLeafSummary` is the one place all three arms funnel into once
 * `GEA_LEAF_DEBUG='*'`, module-level for the reason `openWalkAnswers` is
 * (a member-slot question re-enters through a fresh proof instance, and the
 * summary has to span every one of them, not just the last).
 */
const leafSummary = new Map<string, Map<string, { count: number; readonly sites: string[] }>>()
let leafSummaryAtExitArmed = false
const recordLeafSummary = (arm: string, ownerMember: string, site: string): void => {
  if (watchedLeafDebug !== '*') return
  if (!leafSummaryAtExitArmed) {
    leafSummaryAtExitArmed = true
    process.on('exit', () => {
      for (const [reportedArm, byOwner] of [...leafSummary].sort(([left], [right]) => left.localeCompare(right)))
        for (const [owner, { count, sites }] of [...byOwner].sort(([, left], [, right]) => right.count - left.count))
          console.error(`[LEAF-SUMMARY] arm=${reportedArm} owner.member=${owner} count=${count} first-sites=${sites.join('|')}`)
    })
  }
  let byOwner = leafSummary.get(arm)
  if (!byOwner) leafSummary.set(arm, (byOwner = new Map()))
  let entry = byOwner.get(ownerMember)
  if (!entry) byOwner.set(ownerMember, (entry = { count: 0, sites: [] }))
  entry.count += 1
  if (entry.sites.length < 3) entry.sites.push(site)
}

const describeNode = (node: ts.Node): string => {
  const file = node.getSourceFile()
  // The TEXT, not only the position: every three.js file the walk reports on is
  // rewritten by a source transform before the compiler sees it, so a reported
  // line does not address anything on disk without it.
  const text = node.getText().slice(0, 90).replace(/\s+/g, ' ')
  return ` ${file.fileName.split('/').pop()}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} [${text}]`
}

/**
 * Whether `type` is, or nominally descends from, the class `baseSymbol` names.
 *
 * MODULE level, not proof-local: `virtualMethodDeclarationsOf`,
 * `virtualAccessorsOf` and `slotDeclarationsOf` each ask this once per
 * (candidate descendant, base) pair for EVERY reachable class declaration --
 * and a proof-scoped cache only catches repeats WITHIN one member's proof.
 * The real repetition is ACROSS proofs: the three.js app asks "does this class descend
 * from `Object3D`/`Vector3`/..." from thousands of different member proofs
 * over the course of one compile, and a proof-local cache starts over every
 * time. Measured at 5.8% of the whole compile with a proof-local cache that
 * still missed almost every call.
 *
 * Safe at this scope because the answer depends on nothing proof-specific --
 * not `flow`, not `member`, not `countedCalls` -- only `type` and `baseSymbol`,
 * which are immutable checker facts for the process's one `ts.Program`. Two
 * different rounds share the same checker and the same answer for the same
 * pair, exactly like `isConstructorFunction`'s module-level cache in
 * `model.ts`.
 */
const descendsFromCache = new WeakMap<ts.Type, Map<ts.Symbol, boolean>>()
const descendsFromNominal = (checker: ts.TypeChecker, type: ts.Type, baseSymbol: ts.Symbol): boolean => {
  let byBase = descendsFromCache.get(type)
  if (!byBase) descendsFromCache.set(type, (byBase = new Map()))
  const known = byBase.get(baseSymbol)
  if (known !== undefined) return known
  const seen = new Set<ts.Type>()
  const walk = (current: ts.Type): boolean => {
    if (seen.has(current)) return false
    seen.add(current)
    if (current.getSymbol() === baseSymbol) return true
    const declared = heritageClassOrInterfaceOf(current)
    return (declared === null ? [] : (checker.getBaseTypes(declared) ?? [])).some(walk)
  }
  const answer = walk(type)
  byBase.set(baseSymbol, answer)
  return answer
}

/**
 * Every accessor body under `key` on `stated` or any nominal descendant of it.
 *
 * MODULE level for the same reason `descendsFromNominal` above is, and the
 * proof-local map in `virtualAccessorsOf` is not a substitute for it: that one
 * is keyed by the receiver EXPRESSION, so it catches only repeats of the same
 * syntactic access within one proof, while the walk itself sweeps the whole
 * round's `flow.classDeclarations` -- hundreds of classes for three.js, each
 * costing a `getDeclaredTypeOfSymbol` and a heritage descent. The three.js app ran that
 * sweep once per (proof, access) and it was the largest SELF-time entry in the
 * compiler's own modules (5.5%).
 *
 * The answer depends on nothing proof-specific. `receiverTypeAt` is a proof
 * parameter and stays outside: it only chooses WHICH type is `stated`, and
 * from there the result is a function of (round, that type, key) alone. The
 * returned map is shared, so callers must treat it as read-only -- both of
 * them only ever `get(kind)` out of it.
 */
const virtualAccessorsByType = new WeakMap<
  ValueFlowIndex,
  WeakMap<ts.Type, Map<string, ReadonlyMap<ts.SyntaxKind, readonly ts.AccessorDeclaration[]>>>
>()
const virtualAccessorsFor = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  stated: ts.Type,
  key: string,
  descendsFrom: (type: ts.Type, baseSymbol: ts.Symbol) => boolean
): ReadonlyMap<ts.SyntaxKind, readonly ts.AccessorDeclaration[]> => {
  let byType = virtualAccessorsByType.get(flow)
  if (!byType) virtualAccessorsByType.set(flow, (byType = new WeakMap()))
  let byKey = byType.get(stated)
  if (!byKey) byType.set(stated, (byKey = new Map()))
  const known = byKey.get(key)
  if (known) return known
  const baseSymbol = stated.getSymbol()
  const found = new Map<ts.SyntaxKind, ts.AccessorDeclaration[]>([
    [ts.SyntaxKind.GetAccessor, []],
    [ts.SyntaxKind.SetAccessor, []]
  ])
  const owners: ts.Type[] = [stated]
  if (baseSymbol !== undefined)
    for (const owner of flow.classDeclarations) {
      const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : undefined
      if (!symbol) continue
      const instance = checker.getDeclaredTypeOfSymbol(symbol)
      if (descendsFrom(instance, baseSymbol)) owners.push(instance)
    }
  for (const owner of owners)
    for (const node of owner.getProperty(key)?.declarations ?? []) {
      if (!ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) continue
      const bodies = found.get(node.kind)!
      if (!bodies.includes(node)) bodies.push(node)
    }
  byKey.set(key, found)
  return found
}

/**
 * Shared by every `closedMemberCallableUses` proof of the same round: keyed by
 * `flow` rather than kept proof-local, because `declared`, the round's class
 * list and `descendsFrom` are all round-fixed facts, so two different member
 * proofs asking about the same slot in the same round must get the same
 * answer -- and a proof-local cache made every one of them redo the walk.
 */
/**
 * One slot of an object: an array element, or a member named by key -- or,
 * where the key is not written down, by the declaration it resolves to.
 * `HopId` is the name two hops share exactly when they select the same slot.
 */
type HopId = string
interface Hop {
  readonly kind: 'property' | 'element'
  readonly member: ts.Declaration | null
  readonly key: string | null
  /**
   * The walk arrived at this hop BACKWARDS -- from `holder.member` or
   * `holder[ i ]` to `holder` -- so it knows the followed value is reachable
   * through SOME value in this slot but not which one. Every value ever
   * stored into the slot then has to be published too: three reuses a pooled
   * render item read back out of `renderItems[ i ]`, and the same item object
   * is still referenced from last frame's `opaque` array.
   */
  readonly owesStores: boolean
}
/**
 * Where the followed value sits inside the object a reference denotes, read
 * from the reference outwards: `tail` is what the next hop lands on, and a
 * null tail means the next hop IS the followed value.
 *
 * A `summary` node stands for every path `hops* exit`: the followed value is
 * reachable by some sequence of the listed hops, then the exit path. It is
 * what a path becomes when it would repeat a hop -- `this.parts[0].owner =
 * this` (`RenderTarget.js`: `this.textures[ i ].renderTarget = this`)
 * extends `owner . parts . [] . owner . parts ...` forever, and three's
 * render lists put a list into an array whose elements hold the list's own
 * arrays. Every unfolding is contained in the summary, so treating a read as
 * possibly carrying the value along any of its hops is only ever STRICTER
 * than the unfolded path; and because a plain chain has distinct hop ids and
 * a summary's hop set is drawn from a finite universe, there are finitely
 * many paths and the walk terminates without assuming anything.
 *
 * This replaces a "cycle" marker that answered every repeated hop with
 * `true`. That marker cut on a repeated hop regardless of which OBJECT
 * carried it, so `inner.parts[0].owner = held; outer.owner = inner;
 * unknownConsumer( outer )` never walked `outer`, and any element hop nested
 * in another (`grid[0][0].owner = held`) was not walked at all.
 */
interface MemberPath {
  readonly kind: 'property' | 'element' | 'summary'
  /** The declaration a property hop was published through; null for an element or a summary. */
  readonly member: ts.Declaration | null
  readonly key: string | null
  readonly owesStores: boolean
  /** The rest of the path; a summary's exit. */
  readonly tail: MemberPath | null
  /** summary only: the hops the summary may repeat. */
  readonly hops: ReadonlySet<HopId>
  /** summary only: the repeatable hops whose stores are owed (see `Hop.owesStores`). */
  readonly owing: ReadonlySet<HopId>
}
/** One read of a slot, stated the way `readMatches` compares it with a hop. */
interface SlotRead {
  readonly element: boolean
  readonly declaration: ts.Declaration | null
  readonly key: string | null
}
const ELEMENT_READ: SlotRead = { element: true, declaration: null, key: null }
const ELEMENT_HOP: Hop = { kind: 'element', member: null, key: null, owesStores: false }
const OWED_ELEMENT_HOP: Hop = { kind: 'element', member: null, key: null, owesStores: true }
const NO_HOPS: ReadonlySet<HopId> = new Set()

/**
 * Path interning, shared by every `closedMemberCallableUses` proof of the round
 * rather than rebuilt inside each one.
 *
 * `plainPath` and `summaryPath` are pure functions of the program: a hop and a
 * tail name the same slot sequence no matter which member proof is asking, and
 * `declarationIdOf` only needs ids that are stable and distinct. Keeping these
 * four tables proof-local meant every one of the ~20k proofs in a three.js
 * compile rebuilt the whole interning universe -- the `MemberPath` objects, the
 * nested `Map`s that intern them, and the declaration ids -- which showed up as
 * 6.2 GB of `Map` allocation and 13% of the run in the collector.
 *
 * Sharing them is not merely cheaper, it is MORE canonical: two proofs asking
 * about the same slot sequence now get the identical `MemberPath` object, so
 * the proof-local answer tables that key by path (`containerAnswers`,
 * `publishAnswers`, `classAnswers`) no longer hold one entry per proof-private
 * duplicate of the same path. Nothing here depends on proof state, and a
 * rebuilt flow index starts a new round with a fresh interning universe.
 */
interface PathInterning {
  readonly declarationIds: Map<ts.Declaration, number>
  readonly propertyPaths: Map<ts.Declaration | null, Map<string | null, Map<boolean, Map<MemberPath | null, MemberPath>>>>
  readonly elementPaths: Map<boolean, Map<MemberPath | null, MemberPath>>
  readonly summaryPaths: Map<MemberPath, Map<string, MemberPath>>
}
const pathInternings = new WeakMap<ValueFlowIndex, PathInterning>()
const pathInterningOf = (flow: ValueFlowIndex): PathInterning => {
  let held = pathInternings.get(flow)
  if (!held)
    pathInternings.set(
      flow,
      (held = { declarationIds: new Map(), propertyPaths: new Map(), elementPaths: new Map(), summaryPaths: new Map() })
    )
  return held
}

const slotDeclarationsCaches = new WeakMap<ValueFlowIndex, Map<ts.Declaration, readonly ts.Declaration[]>>()

const closedMemberCallableUses = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  member: ts.Symbol | null,
  countedCalls: ReadonlySet<ts.CallExpression | ts.NewExpression>,
  givenReceiverTypeAt: (expression: ts.Expression) => ts.Type | null,
  argumentsUsesAt: (declaration: ts.SignatureDeclaration) => readonly ts.Identifier[] | undefined,
  givenOpenUse?: (
    reference: ts.Expression,
    kind: 'receiver' | 'containing-object' | 'member-reference-inventory' | 'member-receiver-inventory'
  ) => void,
  activeMembers: ReadonlySet<ts.Symbol> = new Set(),
  activeFamilies: ReadonlySet<SourceClass> = new Set(),
  valueMode?: ClosedValueMode
): boolean => {
  if (member && activeMembers.has(member)) {
    noteAssumption(member)
    return true
  }
  // The open-use sink is swappable so a shared sub-answer (`fieldValuesOf`)
  // can record what its computation reports and replay it on a later hit.
  let openSink = givenOpenUse
  const onOpenUse = (reference: ts.Expression, kind: OpenUseKind): void => openSink?.(reference, kind)
  // The checker types `new this.constructor()` as `any`. The construction is
  // one of the enclosing class's owned family (`thisConstructorFamilyOf`), so
  // it is at least that class: its declared type names every member the
  // fresh object can be read through -- `.copy` in three's `clone()` -- and
  // the family's overrides are found from there the way any base-typed
  // receiver's are. Without this every member read on the clone had no
  // declaration and the container walk stopped at `no-declaration`.
  //
  // One wrapper per given authority, not one per call: `recordRootsClosed`'s
  // coinduction parks an open proof keyed on the identity of this function,
  // and a fresh closure per nested invocation never matched a parked proof
  // -- `root.nodes.push( makeNode() )` re-entered its own record proof until
  // the stack overflowed.
  const receiverTypeAt = ownedConstructionReceiverTypeAt(checker, flow, givenReceiverTypeAt)
  const nestedMembers = new Set(activeMembers)
  if (member) nestedMembers.add(member)
  /**
   * The class families whose ORIGIN proof is already open somewhere up the
   * stack, parked exactly as `activeMembers` parks a member.
   *
   * `ownerOriginsClosed` asks a question about a CLASS -- is every construction
   * and every initializer receiver of this family accounted for -- but the only
   * re-entrancy guard it had was `activeMembers`, keyed by whichever METHOD
   * happened to ask. Three's scratch-singleton idiom turns that into a cycle
   * with no leaf: `const _v1 = new Vector3()` is read by nearly every method of
   * `Vector3`, so proving `fromArray` closed walks `_v1`, whose `_v1.set(...)`
   * mention launches a fresh proof of `set`, which asks the identical `Vector3`
   * family question again through a different member symbol -- and the guard
   * never fires because the symbols differ. Nothing in the loop is grounded by
   * an independent fact, so it unfolded to the depth limit and answered open.
   *
   * Parking it is the same coinduction the member guard already is: assume the
   * family closes, and let any concrete use that contradicts it answer false --
   * and it must be armed for the WHOLE of this proof, not only while its own
   * family stage runs: `setFromMatrixColumn` refuses at the earlier
   * receiver-open stage, so a sibling proof reached from there would ask the
   * unparked question before this one ever got to its own.
   *
   * Filled lazily because `memberOwnerClassOf` is declared below this point.
   */
  const openFamilies = new Set(activeFamilies)
  let ownFamiliesArmed = false
  // The parks this instance can lean on: everything it hands its nested
  // proofs (its own member and families included -- from a sub-question's
  // point of view those are assumptions, not self-coinduction), plus the
  // module-level ones. A shared answer is valid exactly where its assumed
  // parks are all in force.
  const parked = (key: object): boolean =>
    nestedMembers.has(key as ts.Symbol) ||
    openFamilies.has(key as SourceClass) ||
    (activeRecordProofs.get(flow)?.has(key as never) ?? false) ||
    (activeValueTerminals.get(flow)?.has(key as ClosedValueMode['terminalUse']) ?? false) ||
    (activeFieldReadsByFlow.get(flow)?.has(key as ts.Expression) ?? false) ||
    hypothesisGuardIsOpen(key)
  const sharedAnswerOf = <T>(
    identity: string,
    compute: () => T | null,
    shareable?: (value: T | null) => boolean
  ): SharedProvenanceAnswer<T> => {
    sharedStats.asks++
    let byReceiverTypeAt = sharedAnswers.get(flow)
    if (!byReceiverTypeAt) sharedAnswers.set(flow, (byReceiverTypeAt = new WeakMap()))
    let byArgumentsUsesAt = byReceiverTypeAt.get(receiverTypeAt)
    if (!byArgumentsUsesAt) byReceiverTypeAt.set(receiverTypeAt, (byArgumentsUsesAt = new WeakMap()))
    let byIdentity = byArgumentsUsesAt.get(argumentsUsesAt)
    if (!byIdentity) byArgumentsUsesAt.set(argumentsUsesAt, (byIdentity = new Map()))
    const keyed = `${intactCheckIdOf(valueMode?.explicitInvocationIsIntact)}:${identity}`
    let answers = byIdentity.get(keyed)
    if (!answers) byIdentity.set(keyed, (answers = []))
    for (const answer of answers) {
      let applies = true
      for (const key of answer.assumed)
        if (!parked(key)) {
          applies = false
          break
        }
      if (!applies) continue
      sharedStats.hits++
      for (const key of answer.assumed) noteAssumption(key)
      for (const key of answer.escaped) noteAssumption(key)
      for (const [reference, kind] of answer.opens) onOpenUse(reference, kind)
      return { value: answer.value as T, requirements: answer.requirements }
    }
    const trail = pushHypothesisTrail()
    const opens = new Map<ts.Expression, Set<OpenUseKind>>()
    const outerSink = openSink
    openSink = (reference, kind) => {
      let kinds = opens.get(reference)
      if (!kinds) opens.set(reference, (kinds = new Set()))
      if (kinds.has(kind)) return
      kinds.add(kind)
      outerSink?.(reference, kind)
    }
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    let computed: SharedProvenanceAnswer<T>
    try {
      computed = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
    } finally {
      popHypothesisTrail()
      openSink = outerSink
    }
    const assumed = new Set<object>()
    // Every key the computation leaned on is passed outward, not only the ones
    // this frame can ground: an enclosing memo must see a hypothesis this
    // frame cannot name, or it stores an answer resting on something nobody
    // recorded. `parked` here is a superset of any enclosing frame's, so a key
    // this frame drops is one that frame drops too -- no positive answer's
    // scope changes.
    const escaped = new Set<object>()
    for (const key of trail) {
      // Three outcomes, not two. A key still parked is an assumption, as ever.
      // A key whose guard CLOSED while this computation was still running used
      // to fall straight to `escaped`, and that is the whole cost: the guard
      // `recordMethodCallTargetsOf` opens closes inside the walk that an
      // enclosing `record-plan:` ask is making, so by the time this frame
      // classifies, a hypothesis that was perfectly legitimate when it was
      // noted looks like something nobody recorded. The refusal is dropped and
      // the same nine questions are re-derived a hundred thousand times.
      //
      // `hypothesisSettledAsTruth` is the guard reporting that it handed its
      // re-entries the answer the question actually had. Leaning on it cost
      // the computation nothing, so the key is discharged -- neither an
      // assumption nor an escape. `parked` is asked FIRST so a key held open
      // for any other reason keeps scoping the answer.
      if (parked(key)) assumed.add(key)
      else if (!hypothesisSettledAsTruth(key)) escaped.add(key)
      noteAssumption(key)
    }
    const grounded = escaped.size === 0
    // A REFUSAL is an answer like any other once the hypotheses behind it are
    // named. It used to be thrown away wholesale -- "a refusal can come from a
    // re-entry guard of the asking proof" -- which was true only because no
    // re-entry guard recorded itself: `activeInvocationFacts`,
    // `activeMethodCalls`, `activeSlotReads`, `resolvingImplementations` and
    // the inherited-caller guard all refused silently. They note themselves on
    // the trail now (`proof-hypotheses.ts`), so `assumed` scopes a refusal to
    // exactly the parks and open questions that produced it, and `grounded` is
    // the fail-closed half: a refusal leaning on a key this frame cannot name
    // is still not stored. The three.js app asked `record-plan:` 1.5M times and kept
    // 16k answers because 98% of the asks refused.
    if (computed.value === null && !grounded) sharedStats.ungrounded++
    if ((shareable?.(computed.value) ?? true) && (computed.value !== null || (grounded && refusalMemoEnabled))) {
      const recorded: (readonly [ts.Expression, OpenUseKind])[] = []
      for (const [reference, kinds] of opens) for (const kind of kinds) recorded.push([reference, kind])
      sharedStats.stores++
      if (computed.value === null) sharedStats.refusals++
      answers.push({ assumed, escaped, value: computed.value, requirements: computed.requirements, opens: recorded })
    }
    return computed
  }
  const nestedFamilies = (): ReadonlySet<SourceClass> => {
    if (!ownFamiliesArmed) {
      ownFamiliesArmed = true
      for (const declaration of member?.declarations ?? []) {
        const owner = memberOwnerClassOf(declaration)
        if (owner !== null) openFamilies.add(owner)
      }
    }
    return openFamilies
  }
  const closureTracing =
    memberClosureDebug !== undefined &&
    member !== null &&
    (memberClosureDebug === '*' || memberClosureDebug.split(',').includes(member.getName()))
  const openMember = (reason: string, at?: ts.Node): false => {
    // The member NAME alone is ambiguous and was misleading: `copy` is
    // declared by two dozen unrelated three.js classes, and the rollup read
    // as one huge refusal when it is twenty small ones. The owner and the
    // nesting depth are what tell a TOP-LEVEL refusal -- the only kind a
    // caller in `parameter-bindings.ts` ever sees -- from one discovered
    // inside a short-circuiting `every` that some sibling already decided.
    if (closureTracing || watchedLeafDebug === '*') {
      const owner = member?.declarations?.[0]?.parent
      const owning = owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) ? (owner.name?.text ?? '(anonymous)') : '-'
      if (closureTracing)
        console.error(`[MEMBER-CLOSURE] depth=${activeMembers.size} ${owning}.${member?.getName()} ${reason}${at ? describeNode(at) : ''}`)
      // `GEA_LEAF_DEBUG='*'` also watches this arm -- it used to be visible
      // only through the separate `GEA_MEMBER_CLOSURE_DEBUG`, filtered by
      // member name, so a `'*'` leaf run never saw a member-closure refusal
      // that was the real cause behind an "open" answer several frames up.
      if (watchedLeafDebug === '*') {
        const site = at ?? member?.declarations?.[0]
        const file = site?.getSourceFile()
        const name = file ? (file.fileName.split('/').pop() ?? file.fileName) : '-'
        const line = site && file ? file.getLineAndCharacterOfPosition(site.getStart()).line + 1 : 0
        recordLeafSummary(`member-closure:${reason}`, `${owning}.${member?.getName() ?? '-'}`, `${name}#${line}`)
      }
    }
    return false
  }
  const declarationName =
    member?.valueDeclaration ?? member?.declarations?.[0] ?? valueMode?.roots[0]?.getSourceFile() ?? valueMode?.anchor?.getSourceFile()
  if (!declarationName) return false
  const memberSite = ts.isBinaryExpression(declarationName)
    ? declarationName.left
    : ts.isPropertyAssignment(declarationName)
      ? declarationName.initializer
      : ts.isMethodDeclaration(declarationName) && ts.isIdentifier(declarationName.name)
        ? declarationName.name
        : null
  // Coinductive through `coinduct` below: a mention re-entered while its own
  // answer is pending holds, and a FAILED answer is never read back as `true`
  // the way a seen-set that never un-marked did.
  const visitAnswers = new Map<ts.Node, Answer>()
  const visit = (reference: ts.Expression): boolean => coinduct(visitAnswers, reference, () => visitMention(reference))
  const visitMention = (reference: ts.Expression): boolean => {
    const parent = reference.parent
    if (!parent) return false
    if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return visit(parent)
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === reference) return countedCalls.has(parent)
    if (ts.isBinaryExpression(parent) && parent.left === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true
    if (ts.isMethodDeclaration(parent) && parent.name === reference) return true
    if (ts.isPropertyAssignment(parent) && parent.name === reference) return true
    // Every other spelling of "this is where the member is written down".
    // `Mesh` declares `geometry;` as a bare typed field, and reading its own
    // declaration name as a use of the member left that field's receiver
    // unexplained -- the terminal of 35 escapes.
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isShorthandPropertyAssignment(parent)) &&
      parent.name === reference
    )
      return true
    if (ts.isVariableDeclaration(parent)) {
      if (parent.name === reference) return true
      if (parent.initializer === reference && ts.isIdentifier(parent.name)) {
        const symbol = checker.getSymbolAtLocation(parent.name)
        return symbol !== undefined && flow.referencesToSymbol(symbol).every(visit)
      }
    }
    if (ts.isIdentifier(reference)) {
      const declaration = checker.getSymbolAtLocation(reference)?.valueDeclaration
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.name === reference) return true
    }
    const erased = outermostErasureOf(reference)
    if (erased !== reference && ts.isExpression(erased)) return visit(erased)
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && EXPLICIT_THIS_METHODS.has(parent.name.text)) {
      const call = parent.parent
      return ts.isCallExpression(call) && call.expression === parent && countedCalls.has(call)
    }
    return classifyMention(checker, reference, declarationName).kind === 'inert'
  }
  const references = (member?.declarations ?? []).flatMap((declaration) => flow.referencesToDeclaration(declaration))
  /**
   * A member NOTHING in this program names has an empty use inventory, and an
   * empty inventory is complete. No expression selects the member, so no call
   * can be written against it and no receiver can be collected for it; the
   * only way to reach it is through an object that escaped, which is the very
   * thing the walk enclosing this proof enumerates -- an escape it admitted
   * would fail that walk, not this one.
   *
   * The member-replacement inventory at the bottom still runs: a member that
   * is never READ can still be WRITTEN, and a write of an external callable
   * is an open use whether or not anything names the slot.
   */
  const unnamed =
    !valueMode &&
    references.every((reference) => {
      // The declaration's own name is not a mention of the member: it is where
      // the member is written down.
      const parent = reference.parent
      return (
        (ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
        parent.name === reference
      )
    })
  // (Every mention in `references` is classified by `visit` at the end of this
  // proof, once the coinduction it runs under is defined.)

  // The member inventory alone cannot prove closure: an unknown consumer
  // receiving its containing object can call or replace the member without
  // ever spelling it in this program. Follow only inventory-backed local
  // bindings and calls into written function bodies; every other publication
  // of the receiver remains an escape.
  const inertReceiverUse = (reference: ts.Expression): boolean => {
    const parent = reference.parent
    if (ts.isExpressionStatement(parent) && parent.expression === reference) return true
    if (ts.isBinaryExpression(parent) && parent.left === reference && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
      return ordinarySourceClassInstanceTestOf(checker, flow, parent)
    // HasProperty does not read a data value or invoke an accessor. Key
    // coercion can execute user code, so only a primitive key is inert.
    if (ts.isBinaryExpression(parent) && parent.right === reference && parent.operatorToken.kind === ts.SyntaxKind.InKeyword)
      return primitive(checker.getTypeAtLocation(unwrapValue(parent.left)))
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      parent.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    )
      return false
    // A computed access on the receiver whose key cannot be this member --
    // every arm numeric, or a string literal naming another key -- neither
    // reads nor writes the member, whichever side of an assignment it is on:
    // `bag[Date.now()] = 1` through `const bag: any = a`. The write inventory
    // (`memberSlotWritesClosed`) already admits exactly these keys through the
    // same `computedKeyMayBeMember`; refusing them here as an unexplained use
    // of the alias made this proof stricter than the writes it is proving.
    if (ts.isElementAccessExpression(parent) && parent.expression === reference && member !== null)
      return !computedKeyMayBeMember(checker, parent.argumentExpression, member.getName())
    // `Object.assign(receiver, { x: 2 })` writes exactly the keys its sources
    // spell: every source an object literal, none naming this member, and the
    // receiver is untouched at this key. A source whose keys cannot be read
    // (`JSON.parse('{}')`) stays an open use.
    if (ts.isCallExpression(parent) && parent.arguments[0] === reference && member !== null) {
      const sources = objectAssignSourcesOf(checker, parent)
      if (sources !== null) {
        const key = member.getName()
        return sources.every((source) => {
          const keys = spelledLiteralKeysOf(source)
          return keys !== null && !keys.has(key)
        })
      }
    }
    return classifyMention(checker, reference, declarationName).kind === 'inert'
  }
  const primitive = (type: ts.Type): boolean =>
    type.isUnion()
      ? type.types.every(primitive)
      : (type.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.ESSymbolLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Never)) !==
        0
  /**
   * The class a member written inside it belongs to: a class element's own
   * class, or the class whose constructor or method writes `this.<key> = ...`.
   * Null for a member of anything else -- an object literal, a plain
   * function's `this`.
   */
  const memberOwnerClassOf = (declaration: ts.Node): SourceClass | null => memberOwnerClassIn(flow, declaration)
  const memberKeyOf = (declaration: ts.Node): string | null => {
    if (ts.isBinaryExpression(declaration)) {
      const left = declaration.left
      return ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left) ? accessKeyOf(left) : null
    }
    if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) return memberKeyOf(declaration.parent)
    const name = ts.getNameOfDeclaration(declaration as ts.Declaration)
    return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : null
  }
  /**
   * The slot one level up the class chain that a member written in a class
   * overrides: `found` with its declarations, `none` when no base declares the
   * key, `opaque` when one does in a shape whose callers cannot be named (an
   * abstract or bodiless method, a data slot, an accessor).
   */
  const baseMemberOf = (
    declaration: ts.SignatureDeclaration
  ): { readonly kind: 'found'; readonly base: ts.MethodDeclaration } | { readonly kind: 'none' | 'opaque' } => {
    const owner = memberOwnerClassOf(declaration)
    const key = memberKeyOf(declaration)
    if (owner === null || key === null) return { kind: 'none' }
    const ownerSymbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    // No symbol means no readable chain. A constructor function has no base by
    // admission, so "no base member" is the answer rather than an opaque one.
    if (!ownerSymbol) return isClassSpelledSourceClass(owner) && owner.heritageClauses?.length ? { kind: 'opaque' } : { kind: 'none' }
    // `getBaseTypes` ASSERTS its argument is a class-or-interface type; it is not
    // a query that answers "no bases" for anything else. A pre-ES6 JS constructor
    // function whose body declares nested helper functions -- three's
    // `WebGLRenderer` exactly -- resolves `ownerSymbol` to the FUNCTION symbol,
    // whose declared type is not that class type, and the cast threw out of the
    // whole proof. `heritageClassOrInterfaceOf` is the same guard the nominal
    // descent above already uses; when it declines, this class chain is simply
    // unreadable, which is the no-symbol answer, not a crash.
    const declared = heritageClassOrInterfaceOf(checker.getDeclaredTypeOfSymbol(ownerSymbol))
    if (declared === null) return isClassSpelledSourceClass(owner) && owner.heritageClauses?.length ? { kind: 'opaque' } : { kind: 'none' }
    for (const base of checker.getBaseTypes(declared) ?? []) {
      const member = checker.getPropertyOfType(base, key)
      if (!member) continue
      const found = member.valueDeclaration ?? member.declarations?.[0]
      if (found && found !== declaration && ts.isMethodDeclaration(found) && found.body && (member.declarations?.length ?? 0) === 1)
        return { kind: 'found', base: found }
      return { kind: 'opaque' }
    }
    return { kind: 'none' }
  }
  const inheritingCallerSites = new Set<ts.SignatureDeclaration>()
  /** Proof-local: the census view this proof reads is fixed for its duration. */
  const callerSites = new Map<
    ts.SignatureDeclaration,
    {
      readonly value: readonly FlowCallSite[] | null
      readonly requirements: readonly IntrinsicProtocolRequirement[]
    }
  >()
  const closedCallerSitesOf = (declaration: ts.SignatureDeclaration): readonly FlowCallSite[] | null => {
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    let answer = callerSites.get(declaration)
    if (!answer) {
      answer = ledger
        ? ledger.capture(() => closedCallerSitesUncached(declaration))
        : { value: closedCallerSitesUncached(declaration), requirements: [] }
      // An inherited answer is taken while the base's own frame is open;
      // only a settled answer and its supporting obligations may be retained.
      if (inheritingCallerSites.size === 0) callerSites.set(declaration, answer)
    }
    if (answer.value === null) return null
    // A successful cached answer still owes its prototype dependencies to
    // each consuming proof. Replaying only the sites loses the obligation
    // when an earlier speculative consumer withdrew its own publication.
    if (answer.requirements.length > 0 && ledger?.include(answer.requirements) !== true) return null
    return answer.value
  }
  const explicitInvocationIsIntact = (call: ts.CallExpression): boolean => {
    if (!callsOf(flow).sites.get(call)?.explicitThis) return false
    const wrapper = unwrapValue(call.expression)
    if (!ts.isPropertyAccessExpression(wrapper)) return false
    const method = checker.getSymbolAtLocation(wrapper.name)
    if (!method || flow.writesToSymbol(method).length > 0) return false
    return valueMode?.explicitInvocationIsIntact
      ? valueMode.explicitInvocationIsIntact(call)
      : deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys('Function', { names: [wrapper.name.text] }, call) === true
  }
  const closedCallerSitesUncached = (declaration: ts.SignatureDeclaration): readonly FlowCallSite[] | null => {
    if (ts.isConstructorDeclaration(declaration)) {
      const calls = constructorCallsOf(checker, flow, declaration)
      if (calls === null) return null
      const sites: FlowCallSite[] = []
      for (const call of calls) {
        const source = callsOf(flow).sites.get(call)
        if (!source) return null
        sites.push({ ...source, targets: [declaration], checkerDeclaration: declaration })
      }
      return sites
    }
    const own = callsOf(flow).declarations.get(declaration) ?? []
    // A call through a base-typed receiver runs the override the runtime
    // object selects: `camera.copy( source )` resolves to the base's `copy`,
    // and a `PerspectiveCamera`'s override runs. Its callers ARE the base's
    // callers -- that is what dispatch means -- whether or not the override
    // also has calls written against it, and leaving them out when it did let
    // `a.m( v )` with `a: A` holding a `B` bind `B.m`'s parameter from `B`'s
    // own calls alone. Answering "no callers, therefore nothing is proven"
    // refused every three.js `copy`/`clone` override and, through the `super`
    // receiver, the whole family behind it. A base whose slot has no nameable
    // callers -- abstract, data, accessor -- refuses.
    //
    // Zero call sites is an answer, not a gap: the closure proof below decides
    // whether it is a complete one. Refusing instead meant that a method this
    // program never calls -- three's `BufferGeometry` carries a dozen,
    // `rotateX` among them -- could say nothing about its own `this`.
    const base = baseMemberOf(declaration)
    if (base.kind === 'opaque') return null
    let inherited: readonly FlowCallSite[] = []
    if (base.kind === 'found' && inheritingCallerSites.has(declaration)) noteAssumption(declaration)
    if (base.kind === 'found' && !inheritingCallerSites.has(declaration)) {
      inheritingCallerSites.add(declaration)
      enterHypothesisGuard(declaration)
      // The re-entry above only notes the assumption and leaves `inherited`
      // empty, so what this guard hands out is "the base contributes no
      // inherited caller sites". It is confirmed exactly when that is what the
      // real walk found.
      try {
        const found = closedCallerSitesOf(base.base)
        if (found === null) return null
        inherited = found
      } finally {
        exitHypothesisGuard(declaration, true)
        inheritingCallerSites.delete(declaration)
      }
    }
    const calls = [...own, ...inherited.filter((site) => !own.includes(site))]
    const counted = new Set(own.map((site) => site.call))
    // `this.setSize = function ( width, height ) { ... }` is a method slot
    // written the other way round. Three's `WebGLOutput` publishes its whole
    // API that way, and `closedCallerSitesOf` was the one place still
    // spelling "method" syntactically -- `fieldDeclaration` below already
    // states that a special assignment is a declaration form. The member slot
    // is the only handle on the function object, which is why the right-hand
    // side must be the function ITSELF and not a value routed through a
    // binding first; with that, the obligation is the same one the method arm
    // discharges, asked of the same symbol.
    const slot = memberSlotNameOf(declaration) ?? (ts.isMethodDeclaration(declaration) ? declaration.name : null)
    if (slot !== null && 'body' in declaration && declaration.body !== undefined) {
      const symbol = checker.getSymbolAtLocation(slot)
      // A call the checker resolves against the symbol's STATED declaration --
      // `Object3D`'s own `onBeforeRender(){}` stub, for a call through a
      // receiver the checker types `Object3D` -- never indexes under an
      // INSTANCE override written elsewhere (`mesh.onBeforeRender = function
      // ( renderer, object ) { ... }`), because the checker has no
      // flow-sensitive model of "this receiver was later given its own
      // property". `memberImplementationsOf` is the existing, already-proven
      // authority for "every function this exact slot can hold" -- the same
      // one the receiver walk below asks -- so a sibling it names is folded in
      // here too: a call counted against ANY of them is evidence for ALL of
      // them, because at runtime exactly one is installed and it is this
      // proof's caller who receives whichever one that is. Soundness rides on
      // `memberImplementationsOf` itself refusing (returning null) the moment
      // some write into the slot cannot be named -- this only ever ADDS
      // sites, it never trims the ones already found.
      const canonical = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
      const siblings = canonical ? memberImplementationsOf(canonical) : null
      // A failed slot inventory is not permission to fall back to the
      // syntactically attributed callers. Every possible installed value
      // must participate in the same callable-family authority.
      if (siblings === null || siblings.length === 0) return null
      const sites = [...calls]
      for (const sibling of siblings) {
        if (sibling === declaration) continue
        for (const site of callsOf(flow).declarations.get(sibling) ?? []) if (!sites.includes(site)) sites.push(site)
      }
      const siblingCounted = new Set(sites.map((site) => site.call))
      const closedMember =
        symbol !== undefined &&
        hasClosedMemberCallableUses(
          checker,
          flow,
          symbol,
          siblingCounted,
          receiverTypeAt,
          argumentsUsesAt,
          onOpenUse,
          nestedMembers,
          nestedFamilies()
        )
      return closedMember ? sites : null
    }
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body) return null
    if ((argumentsUsesAt(declaration)?.length ?? 0) > 0 || callableBindingIsWritten(flow, declaration)) return null
    // An export is a mention no expression spells: code outside the program
    // can call it. `inProgramImportReferencesOf` answers null when anything
    // could expose the binding outside the stated module set, and otherwise
    // names every importer's mention -- which are classified below exactly
    // like the declaring module's own. Refusing every IMPORTED export here
    // was where three's `WebGLBackground.setClearColor`/`setClearAlpha` and
    // `WebGLOutput.setSize`/`setEffects`/`begin` all stopped.
    const exported = isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null)
    const imported = exported ? inProgramImportReferencesOf(checker, flow, declaration) : []
    if (imported === null) return null
    const sites = [...calls]
    for (const reference of new Set([...flow.referencesToDeclaration(declaration), ...imported])) {
      if (reference === declaration.name || isTypePositionReference(reference)) continue
      const parent = reference.parent
      // `@type {ReturnType<typeof WebGLRenderList>}`: a type query evaluates nothing.
      if (ts.isTypeQueryNode(parent) && parent.exprName === reference) continue
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === reference) {
        if (counted.has(parent)) continue
        // An importer's call -- `make()`, `ns.make()` -- is a caller even where
        // the call index filed it under the import binding instead.
        const site = imported.includes(reference) ? callsOf(flow).sites.get(parent) : undefined
        if (site) {
          if (!sites.includes(site)) sites.push(site)
          continue
        }
      }
      // `export { f }`, `import { f }`, `import f`, `import * as ns`: the
      // binding itself, not a use of its value. Every use through the local
      // alias is filed under this declaration (`value-flow.ts`'s
      // `recordReference`), a namespace's whole-object uses included.
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent))
        continue
      // `{ sort: sort }` / `{ sort }` in three's `WebGLRenderList`: the
      // function goes into a record slot, and every call through the slot is
      // one of its callers -- provided the slot itself is closed.
      const slotCalls = recordSlotCallersOf(declaration, reference)
      if (slotCalls !== null) {
        for (const site of slotCalls) if (!sites.includes(site)) sites.push(site)
        continue
      }
      const mention = classifyMention(checker, reference, declaration.name)
      if (mention.kind === 'call' && counted.has(mention.call)) {
        const site = callsOf(flow).sites.get(mention.call)
        if (site?.explicitThis && unwrapValue(site.explicitThis.callee) === unwrapValue(reference)) {
          if (!ts.isCallExpression(mention.call) || !explicitInvocationIsIntact(mention.call)) return null
          continue
        }
      }
      if (mention.kind !== 'inert') return null
    }
    return sites
  }
  const memberNamedCallsOf = (key: string): readonly FlowCallSite[] => {
    let index = callsByMemberName.get(flow)
    if (!index) {
      const built = new Map<string, FlowCallSite[]>()
      for (const site of flow.calls) {
        const callee = ts.isCallExpression(site.call) ? unwrapNaming(site.call.expression) : null
        if (!callee || !ts.isPropertyAccessExpression(callee)) continue
        const entries = built.get(callee.name.text)
        if (entries) entries.push(site)
        else built.set(callee.name.text, [site])
      }
      callsByMemberName.set(flow, (index = built))
    }
    return index.get(key) ?? []
  }
  /**
   * The calls through the record slot a function-name mention fills, or null
   * when the mention is not a record slot or the slot is not closed.
   *
   * A record method call names no declaration the checker can hand back when
   * the record is untyped -- three reads `currentRenderList` out of an `any`
   * -- so the calls are found by key and admitted only where
   * `recordMethodCallTargetsOf` includes this body in the complete target set. The
   * slot's own closure proof then counts exactly those calls: a call through
   * the slot to anything else, or an extraction of the slot, is an open use.
   */
  const recordSlotCallersOf = (declaration: ts.FunctionDeclaration, reference: ts.Expression): readonly FlowCallSite[] | null => {
    const property = reference.parent
    const slotted =
      (ts.isPropertyAssignment(property) && property.initializer === reference) ||
      (ts.isShorthandPropertyAssignment(property) && property.name === reference)
    if (
      !slotted ||
      !ts.isObjectLiteralExpression(property.parent) ||
      (ts.isPropertyAssignment(property) && isObjectLiteralPrototypeSetter(property))
    )
      return null
    const key = publicationKeyOf(property.name)
    const slot = checker.getSymbolAtLocation(property.name)
    if (key === null || slot === undefined) return null
    const through = memberNamedCallsOf(key).filter(
      (site) =>
        ts.isCallExpression(site.call) && recordMethodCallTargetsOf(flow, site.call, computedKeyAuthority)?.includes(declaration) === true
    )
    const counted = new Set<ts.CallExpression | ts.NewExpression>(through.map((site) => site.call))
    for (const site of callsOf(flow).declarations.get(declaration) ?? []) counted.add(site.call)
    return hasClosedMemberCallableUses(
      checker,
      flow,
      slot,
      counted,
      receiverTypeAt,
      argumentsUsesAt,
      onOpenUse,
      nestedMembers,
      nestedFamilies()
    )
      ? through
      : null
  }
  /**
   * The family a `this` denotes, for the allocation-origins walk.
   *
   * `this` in a class member is an instance of that member's class or of a
   * subclass, and the inventory enumerates exactly that -- refusing outright
   * when an unknown subclass could exist, so an admitted answer is complete
   * rather than a lower bound. Supplied as a callback because
   * `member-call-forwarding.ts` cannot import the inventory: that module is
   * imported BY `owned-class-receivers.ts`, so the dependency runs one way.
   *
   * A STATIC member's `this` is the CONSTRUCTOR, not an instance, and has no
   * place in an instance family -- admitting it would put the class object
   * into a set every consumer reads as "instances of this family".
   */
  const thisFamilyAt = (expression: ts.Expression): ExactClassAllocationOrigins | null => {
    const frame = flow.receiverOwnerOf(expression)
    if (frame === null || !ts.isFunctionLike(frame)) return null
    const ownFrame = isConstructorFunction(frame)
    if (!ownFrame && (ts.getCombinedModifierFlags(frame as ts.Declaration) & ts.ModifierFlags.Static) !== 0) return null
    const holder = ownFrame ? frame : frame.parent
    if (!ts.isClassDeclaration(holder) && !ts.isClassExpression(holder) && !isConstructorFunction(holder)) return null
    const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([holder as SourceClass]))
    return inventory === null
      ? null
      : {
          classes: inventory.classes,
          constructions: new Map(inventory.constructionFacts.map(({ call, familyProjection }) => [call, familyProjection]))
        }
  }
  /**
   * `enumeratedParameterValuesOf` (`global-host-mutations.ts`) now calls this
   * for every call-argument reference whose static declaration is an
   * identifier parameter, program-wide -- not once per parameter. Three's
   * heavily forwarded parameters (`material`, `object`, `camera`, `scene`)
   * each have thousands of such reference sites across `WebGLRenderer.js` and
   * its satellites, and every one of them used to redo the full
   * `closedCallerSitesOf` + call-site + write-set walk below from scratch.
   *
   * This mirrors `closedCallerSitesOf` immediately above on purpose, and got
   * there in two cuts, both of which broke the same two census specs
   * ("preserves global alias provenance") for two DIFFERENT reasons:
   *
   * 1. Caching only the VALUE starved every consumer after the first of the
   *    `IntrinsicProtocolRequirement`s the answer depended on.
   *    `ledger.capture`'s bookkeeping is per ACTIVE CAPTURE FRAME, not per
   *    computation: a requirement raised while computing the answer lands in
   *    whichever frame was open at THAT moment, and does nothing for a frame
   *    that becomes active later and merely reads the cached value. Fixed by
   *    capturing `{ value, requirements }` on the cache write and replaying
   *    the stored `requirements` into whichever frame is active at READ
   *    time, on every read, cached or not -- `closedCallerSitesOf`'s own
   *    shape, below.
   * 2. `pushHypothesisTrail`/`popHypothesisTrail` bracket a computation to
   *    observe what IT leans on, but `noteHypothesis` only ever writes the
   *    TOP frame (`proof-hypotheses.ts`): pushing a frame here and never
   *    re-emitting what it collected made this function an opaque wall to
   *    any ENCLOSING proof's own trail -- `parameterValuesOf` is called from
   *    deep inside `closedMemberCallableUses`'s own coinduction (member/
   *    family provenance, several call sites below), and that outer proof's
   *    `share()` needs to see every key this call leaned on to know its OWN
   *    answer is hypothesis-dependent too. Silently eating those notes is
   *    exactly how a construction whose provenance depends on a REASSIGNED
   *    class binding (`NativeView = replacement`) stopped reading as tainted:
   *    the outer member proof cached itself as unconditionally closed.
   *    Fixed the same way `share()` (above) does it for its own trail: after
   *    popping, re-emit every collected key with `noteAssumption` so it
   *    lands in whatever frame is now on top -- observed here for the cache
   *    gate, AND forwarded, never one or the other.
   */
  const parameterValuesCache = new Map<
    ts.ParameterDeclaration,
    { readonly value: readonly ts.Expression[] | null; readonly requirements: readonly IntrinsicProtocolRequirement[] }
  >()
  const parameterValuesOf = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] | null => {
    // DIAGNOSTIC BYPASS -- TEMPORARY, remove before landing. Answers, in ONE
    // build, whether this session's memo is what broke the two global-alias
    // provenance specs: with the flag set the function behaves exactly as it
    // did in the last GREEN spec run (always recompute, no memo, no hypothesis
    // frame). An unconditional `return` here instead of a flag makes every
    // statement below unreachable, and TypeScript's flow analysis then refuses
    // to narrow `answer`, which is why this is a runtime switch and not a
    // deleted line.
    if (process.env['GEA_NO_PARAMETER_VALUES_CACHE'] === '1') return parameterValuesUncached(parameter)
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    let answer = parameterValuesCache.get(parameter)
    if (!answer) {
      const trail = pushHypothesisTrail()
      try {
        answer = ledger
          ? ledger.capture(() => parameterValuesUncached(parameter))
          : { value: parameterValuesUncached(parameter), requirements: [] }
      } finally {
        popHypothesisTrail()
      }
      // Forward to whichever trail is now on top (an enclosing proof, if one
      // is running) BEFORE deciding whether to cache: an empty trail is what
      // makes the answer as settled as `closedCallerSitesOf`'s own cache
      // requires before IT will keep one, but the forward has to happen
      // regardless of that outcome, or an enclosing proof never learns what
      // a non-cached, still-hypothesis-dependent answer leaned on either.
      for (const key of trail) noteAssumption(key)
      if (trail.size === 0) parameterValuesCache.set(parameter, answer)
    }
    if (answer.value === null) return null
    // Replay into the CURRENT active capture, cache hit or miss alike -- the
    // ledger-side half of the same rule the trail forward above pays for the
    // hypothesis side.
    if (answer.requirements.length > 0 && ledger?.include(answer.requirements) !== true) return null
    return answer.value
  }
  const parameterValuesUncached = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] | null => {
    const watchedOrigins = process.env['GEA_ORIGINS_DEBUG']
    const traceParameter = (reason: string): void => {
      if (watchedOrigins === undefined) return
      const text = parameter.getText().replace(/\s+/g, ' ')
      if (watchedOrigins !== '*' && !text.includes(watchedOrigins)) return
      const file = parameter.getSourceFile()
      const line = file.getLineAndCharacterOfPosition(parameter.getStart()).line + 1
      console.error(`[PARAMETER-ORIGINS] ${file.fileName}:${line} ${text} ${reason}`)
    }
    const owner = parameter.parent
    // A class element is unconditionally strict (ECMA-262 `ClassTail`), so its
    // `arguments` is the UNMAPPED kind and cannot alias a parameter binding --
    // see `isAlwaysStrictClassElement` in `parameter-values.ts` for the full
    // argument. The frame refusal is for the mapped object, which only a
    // non-strict simple-parameter function ever gets.
    const strictClassElement = ts.isClassElement(owner) && (ts.isClassDeclaration(owner.parent) || ts.isClassExpression(owner.parent))
    if (
      !ts.isFunctionLike(owner) ||
      owner.parameters.some((entry) => entry.dotDotDotToken) ||
      (!strictClassElement && (argumentsUsesAt(owner)?.length ?? 0) > 0)
    )
      return null
    const values = new Set<ts.Expression>()
    // The value graph is the authority for what a parameter holds; a complete
    // graph answer is taken as is. Where the graph is still open the legacy
    // caller walk below answers for a function, and a setter -- whose callers
    // are the stores that run it, which only the graph enumerates -- refuses.
    const graph = sourceValueSessionOf(checker, flow).parameterValuesOf(parameter)
    if (graph !== null && graph.every(ts.isExpression)) return graph
    if (ts.isSetAccessorDeclaration(owner)) {
      traceParameter('setter-stores-open')
      return null
    } else {
      // An exported function's unknown callers are refused by
      // `closedCallerSitesOf` itself, which admits only an export nothing
      // imports.
      const calls = closedCallerSitesOf(owner)
      if (!calls) {
        traceParameter('open-callers')
        const callbackValues = callbackParameterValuesOf(parameter)
        if (callbackValues === null) traceParameter('callback-values-refused')
        return callbackValues
      }
      const position = runtimeParametersOf(owner).indexOf(parameter)
      if (position < 0) {
        traceParameter('runtime-position-missing')
        return null
      }
      for (const { call, operands } of calls) {
        const args = operands.args
        if (args?.some(ts.isSpreadElement)) {
          traceParameter('spread-call-argument')
          return null
        }
        // An omitted argument with no default IS the value `undefined` -- a
        // known value, not a missing one. Three constructs `new
        // MeshDistanceMaterial()` and `new MeshDepthMaterial()` bare, and
        // refusing those frames made `Material.setValues`' key set refuse.
        values.add(args?.[position] ?? parameter.initializer ?? omittedArgumentOf(call, position))
      }
    }
    for (const write of flow.writesToDeclaration(parameter)) {
      // Mutating a pointee's member, element or collection entry does not
      // replace the parameter reference. Its contents are a separate origin
      // query; only whole-cell writes can add a different receiver here.
      if (write.slot !== 'whole') continue
      // A parameter property shares declaration identity with the instance
      // slot, but writing `this.x` does not rebind the constructor's `x`.
      // Field contents consume these stores; argument origins do not.
      if (
        ts.isParameterPropertyDeclaration(parameter, parameter.parent) &&
        write.naming &&
        (ts.isPropertyAccessExpression(write.naming) || ts.isElementAccessExpression(write.naming))
      )
        continue
      // A rest slot states what the parameter's array CONTAINS, never what the
      // parameter holds; the call-site loop above already named that array.
      if (write.edge === 'rest-argument') continue
      if (!write.value) {
        traceParameter(`${write.slot}/${write.edge}-value-missing`)
        return null
      }
      if (write.edge !== 'call-argument' && write.edge !== 'default-parameter' && write.edge !== 'identifier-assignment') {
        traceParameter(`unsupported-whole-write:${write.edge}`)
        return null
      }
      values.add(write.value)
    }
    return [...values]
  }
  /**
   * Every value `arguments[ i ]` can read inside `owner`, for an `i` this
   * file already knows is numeric but not which one -- three's
   * `Object3D.add` walks `arguments` exactly this way to admit several
   * children in one call. Unlike `parameterValuesOf` (one declared position),
   * an unindexed read can land on ANY actual argument at ANY position, so
   * every position of every closed caller site is in the set, not only the
   * ones a declared parameter names. A caller passing `...spread` or one
   * this file cannot enumerate at all refuses the whole owner, the same bar
   * `parameterValuesOf` holds its own callers to.
   */
  const argumentsElementValuesOf = (owner: ts.SignatureDeclaration): readonly ts.Expression[] | null => {
    const calls = closedCallerSitesOf(owner)
    if (!calls) return null
    const values: ts.Expression[] = []
    for (const { operands } of calls) {
      const args = operands.args
      if (!args || args.some(ts.isSpreadElement)) return null
      values.push(...args)
    }
    return values
  }
  /**
   * Every value a parameter receives when its function is used as an
   * intrinsic Array callback, or null when some use is anything else.
   *
   * Three's `painterSortStable( a, b )` is never called by name: it is handed
   * to `opaque.sort( customOpaqueSort || painterSortStable )`, and the sort
   * calls it with pairs of the array's own elements. That is a closed frame
   * -- every element the array ever stored, by `arrayStoredValuesOf` -- as
   * long as each mention of the function is a direct call or the callback of
   * an intrinsic element method on an array whose protocol is closed.
   */
  const callbackParameterValuesOf = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] | null => {
    const owner = parameter.parent
    if (!ts.isFunctionDeclaration(owner) || !owner.name || !owner.body || callableBindingIsWritten(flow, owner)) return null
    if ((argumentsUsesAt(owner)?.length ?? 0) > 0 || owner.parameters.some((entry) => entry.dotDotDotToken)) return null
    const imported = isModuleExportedDeclaration(checker, owner, checker.getSymbolAtLocation(owner.name) ?? null)
      ? inProgramImportReferencesOf(checker, flow, owner)
      : []
    if (imported === null) return null
    const position = runtimeParametersOf(owner).indexOf(parameter)
    if (position < 0) return null
    const values = new Set<ts.Expression>()
    for (const reference of new Set([...flow.referencesToDeclaration(owner), ...imported])) {
      if (reference === owner.name || isTypePositionReference(reference)) continue
      const parent = reference.parent
      if (ts.isTypeQueryNode(parent) && parent.exprName === reference) continue
      // The import and export bindings themselves; their uses are in `imported`.
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent))
        continue
      if (ts.isCallExpression(parent) && parent.expression === reference) {
        if (parent.arguments.some(ts.isSpreadElement)) return null
        values.add(parent.arguments[position] ?? parameter.initializer ?? omittedArgumentOf(parent, position))
        continue
      }
      // The function value may pass through `||`, `??`, `?:` and parentheses
      // on its way to the argument position; each yields it unchanged.
      let argument: ts.Expression = reference
      for (;;) {
        const holder: ts.Node = argument.parent
        if (
          ts.isParenthesizedExpression(holder) ||
          (ts.isBinaryExpression(holder) &&
            (holder.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
              holder.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
          (ts.isConditionalExpression(holder) && holder.condition !== argument)
        ) {
          argument = holder as ts.Expression
          continue
        }
        break
      }
      const call = argument.parent
      if (!ts.isCallExpression(call) || call.arguments[0] !== argument || call.arguments.some(ts.isSpreadElement)) return null
      const callee = unwrapValue(call.expression)
      if (!ts.isPropertyAccessExpression(callee) || !intrinsicArrayMember(callee) || !arrayValued(callee.expression)) return null
      const method = callee.name.text
      const elementSlot = method === 'sort' ? position <= 1 : ELEMENT_CALLBACK_METHODS.has(method) ? position === 0 : null
      if (elementSlot === null || !arrayProtocolClosedAt(callee.expression)) return null
      // The index slot holds a number and the third slot the array itself;
      // neither is an object this answer is asked about, so they refuse.
      if (!elementSlot) return null
      const stored = arrayContentsOf(callee.expression)
      if (stored === null) return null
      for (const value of stored) values.add(value)
    }
    for (const write of flow.writesToDeclaration(parameter)) {
      if (write.slot === 'member') continue
      if (write.slot !== 'whole' || !write.value) return null
      if (write.edge !== 'call-argument' && write.edge !== 'default-parameter' && write.edge !== 'identifier-assignment') return null
      values.add(write.value)
    }
    return [...values]
  }
  /**
   * The whole origin authority for a record plan. Three's pooled render item
   * is read back out of `renderItems[ renderItemsIndex ]`, and the list out of
   * `listArray[ renderCallDepth ]`: such reads are origins only with the
   * intrinsic protocols closed, and an index the checker types `any` (an
   * unannotated parameter) counts as numeric where this proof's census view
   * types it so.
   */
  const computedKeyAuthority: ClosedInvocationAuthority = {
    parameterValuesOf,
    receiverValuesOf: (callable) => receiverValuesOf(callable),
    bindingValuesOf: (declaration) => bindingValuesOf(declaration),
    invocationFactOf: (call) => invocationFactOf(call),
    closedCalleeBodiesOf: (call) => closedCalleeBodiesCascade(call),
    callThroughUncallable: (call) => callThroughUncallableBinding(call),
    whenSettled: (publish) => {
      const pending = frames[frames.length - 1]
      if (pending) pending.parked.push(publish)
      else publish()
    },
    sharedAnswerOf,
    checker,
    closedCallerSitesOf: (callable) => closedCallerSitesOf(callable),
    arrayElementTargetsOf: (element) => callableArrayTargetsOf(checker, flow, element, elementCalleeAuthority),
    explicitInvocationIsIntact: (call) => explicitInvocationIsIntact(call),
    protocolClosed: (plan) => nativeProtocolClosed(plan),
    numericKey: (key) => numericArrayIndex(key),
    // `_this.renderLists = renderLists` publishes three's render-list record
    // onto the renderer; whether any use of those literals can replace the
    // called slot is this proof's record-closure walk over the roots the
    // record-method route hands back. (Asking `constructionDataMemberOf` of
    // the receiver instead would re-derive the very plan being built.)
    recordSlotClosed: (receiver, key, roots) => recordRootsClosed(roots, key, receiver, false, 'stable-callable-slot'),
    slotValuesOf: (access) => {
      const values = sourceValueSessionOf(checker, flow).valuesOf(access)
      return values !== null && values.every(ts.isExpression) ? values : null
    },
    graphValuesOf: (expression) => {
      const values = sourceValueSessionOf(checker, flow).valuesOf(expression)
      return values !== null && values.every(ts.isExpression) ? values : null
    }
  }
  const arrayContentsOf = (source: ts.Expression): readonly ts.Expression[] | null =>
    arrayStoredValuesOf(checker, flow, source, computedKeyAuthority)

  /**
   * Every receiver a class family's instances are ever named by: the `this` of
   * each constructor and field initializer across the family's ancestor
   * closure, and every `new` of it anywhere in the program.
   *
   * THREE places asked this and each spelled it out again -- `ownerOriginsClosed`,
   * `factoryResult`'s constructor branch, and `classInstancesUse`. They are one
   * question with one answer, and keeping three copies meant the coinductive
   * park that grounds the scratch-singleton cycle reached only the copy it was
   * written in: the walk could refuse through `factoryResult` a family it had
   * already assumed closed through `ownerOriginsClosed`.
   *
   * `use` is what differs and is the whole reason they are not one memo: the
   * two path-less callers ask "does this family escape", `classInstancesUse`
   * asks "does the followed value escape through this family at `path`".
   */
  const familyReceiversClosed = (
    roots: ReadonlySet<SourceClass>,
    use: (expression: ts.Expression) => boolean,
    open?: (reason: string, at?: ts.Node) => false
  ): boolean => {
    const inventory = ownedClassReceiverInventoryOf(checker, flow, roots)
    if (inventory === null)
      return open?.(`family-inventory-unbuildable roots=${[...roots].map((root) => root.name?.text ?? '(anonymous)').join(',')}`) ?? false
    for (const initializer of inventory.initializers)
      for (const reference of initializer.references) if (!use(reference)) return open?.('family-initializer-this-open', reference) ?? false
    for (const { call } of inventory.constructionFacts) if (!use(call)) return open?.('family-construction-open', call) ?? false
    return true
  }
  const factoryResult = (declaration: ts.SignatureDeclaration, use: (expression: ts.Expression) => boolean = receiverUse): boolean => {
    const owner = ts.isConstructorDeclaration(declaration) ? declaration.parent : declaration
    if (ts.isConstructorDeclaration(declaration) && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner))) {
      // The park applies only to the path-less question -- a walk carrying a
      // member path is asking something else about the same family and must
      // still walk it.
      if (use === receiverUse && activeFamilies.has(owner)) {
        noteAssumption(owner)
        return true
      }
      return familyReceiversClosed(new Set([owner]), use)
    }
    const calls = closedCallerSitesOf(declaration)
    const watchedNull = process.env['GEA_FACTORY_RESULT_DEBUG']
    if (calls === null) {
      if (watchedNull !== undefined) {
        const who = ts.isFunctionLike(declaration) && declaration.name ? declaration.name.getText() : '(anonymous)'
        if (watchedNull === '*' || watchedNull === who) console.error(`[FACTORY-RESULT] ${who} caller-sites-not-closed`)
      }
      return false
    }
    // `GEA_FACTORY_RESULT_DEBUG=<name>` names the SITE that breaks the
    // `.every`, which no other instrument reports. The member-closure trace
    // stops at `receiver-open ... [this]` -- true but not actionable, because
    // the obligation it stands for is "every call site's RESULT is accounted
    // for", and with ~1300 `.add(...)` sites the whole question is WHICH one.
    const watchedFactory = process.env['GEA_FACTORY_RESULT_DEBUG']
    if (watchedFactory === undefined) return calls.every((site) => use(site.call))
    const named = ts.isFunctionLike(declaration) && declaration.name ? declaration.name.getText() : '(anonymous)'
    if (watchedFactory !== '*' && watchedFactory !== named) return calls.every((site) => use(site.call))
    let closed = true
    for (const site of calls)
      if (!use(site.call)) {
        closed = false
        console.error(
          `[FACTORY-RESULT] ${named} open-site ${site.call.getSourceFile().fileName.split('/').slice(-1)[0]}:${
            site.call.getSourceFile().getLineAndCharacterOfPosition(site.call.getStart()).line + 1
          } ${site.call.getText().slice(0, 80).replace(/\s+/g, ' ')}`
        )
      }
    return closed
  }
  const publicationKeyOf = (name: ts.PropertyName): string | null =>
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null
  const accessKeyOf = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null =>
    ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
  /**
   * A private member's declarations, resolved the way the checker itself
   * resolved this exact access -- never by re-deriving a string key and
   * asking a candidate class's declared type for it.
   *
   * `checker.getPropertyOfType(declaredType, key)` looks a property up by its
   * SOURCE-TEXT name ("#dispatch"), but the checker stores a private member
   * under a name it mangles with the declaring class's own internal symbol id
   * (`getSymbolNameForPrivateIdentifier`) precisely so two unrelated classes'
   * same-spelled `#dispatch` do not collide. That mangled name is not
   * reconstructible from outside the checker, so every `origins.classes` owner
   * asked this way answers "no such property" -- not because the member is
   * unknown, but because the question was unanswerable in that form. A
   * private access has no such ambiguity to begin with: `#name` is resolved
   * lexically to the one class body it is written in, is never inherited or
   * overridden by a subclass (a subclass's own `#name` is a wholly separate
   * field), and so denotes the same declaration for every value the receiver
   * could dynamically hold -- `checker.getSymbolAtLocation` already answers
   * that, unmangled, with no class to loop over.
   */
  const privateMemberDeclarationsOf = (name: ts.PrivateIdentifier): readonly ts.Declaration[] | null => {
    const symbol = checker.getSymbolAtLocation(name)
    return symbol?.declarations?.length ? symbol.declarations : null
  }
  const { declarationIds, propertyPaths, elementPaths, summaryPaths } = pathInterningOf(flow)
  const declarationIdOf = (declaration: ts.Declaration): number => {
    let id = declarationIds.get(declaration)
    if (id === undefined) declarationIds.set(declaration, (id = declarationIds.size))
    return id
  }
  const hopIdOf = (hop: Hop | MemberPath): HopId =>
    hop.kind === 'element' ? '[]' : hop.key !== null ? `.${hop.key}` : `#${declarationIdOf(hop.member!)}`
  /** Whether a read selects the slot a hop names -- by key where the hop has one, by declaration where it does not. */
  const readMatches = (id: HopId, read: SlotRead): boolean => {
    if (read.element) return id === '[]'
    if (read.key !== null && id === `.${read.key}`) return true
    return read.declaration !== null && id.startsWith('#') && declarationIds.get(read.declaration) === Number(id.slice(1))
  }
  const plainPath = (hop: Hop, tail: MemberPath | null): MemberPath => {
    let byTail: Map<MemberPath | null, MemberPath> | undefined
    if (hop.kind === 'element') {
      byTail = elementPaths.get(hop.owesStores)
      if (!byTail) elementPaths.set(hop.owesStores, (byTail = new Map()))
    } else {
      let names = propertyPaths.get(hop.member)
      if (!names) propertyPaths.set(hop.member, (names = new Map()))
      let owes = names.get(hop.key)
      if (!owes) names.set(hop.key, (owes = new Map()))
      byTail = owes.get(hop.owesStores)
      if (!byTail) owes.set(hop.owesStores, (byTail = new Map()))
    }
    let path = byTail.get(tail)
    if (!path) byTail.set(tail, (path = { ...hop, tail, hops: NO_HOPS, owing: NO_HOPS }))
    return path
  }
  const summaryPath = (hops: ReadonlySet<HopId>, owing: ReadonlySet<HopId>, exit: MemberPath): MemberPath => {
    const signature = `${[...hops].sort().join(' ')}|${[...owing].sort().join(' ')}`
    let bySignature = summaryPaths.get(exit)
    if (!bySignature) summaryPaths.set(exit, (bySignature = new Map()))
    let path = bySignature.get(signature)
    if (!path) bySignature.set(signature, (path = { kind: 'summary', member: null, key: null, owesStores: false, tail: exit, hops, owing }))
    return path
  }
  /**
   * How many times one hop may occur on a plain chain before the chain is
   * folded into a summary.
   *
   * Folding at the FIRST repeat is sound but loses the shape a nested
   * container really has: three keeps a list of render lists, each holding
   * arrays of render items -- `[] . opaque . [] . object` repeats the element
   * hop without any object graph closing on itself -- and a summary of `{ [],
   * opaque }` would make every mention along the way possibly an array AND
   * possibly a list record. Two occurrences keep that exact; a real cycle
   * (`this.parts[0].owner = this`) still folds on its next unfolding, and
   * every chain stays finite.
   */
  const PLAIN_REPEATS = 2
  /**
   * `hop` followed by `tail`, folded into a summary where the hop would occur
   * more than `PLAIN_REPEATS` times. The summary repeats every hop from the new
   * one down to the hop's nearest occurrence, which becomes its exit. Scanning
   * passes through a summary into its exit, collecting its hops, so a repeat
   * found below a summary absorbs it.
   */
  const extendPath = (hop: Hop, tail: MemberPath | null): MemberPath => {
    const id = hopIdOf(hop)
    if (tail?.kind === 'summary' && tail.hops.has(id))
      return !hop.owesStores || tail.owing.has(id) ? tail : summaryPath(tail.hops, new Set([...tail.owing, id]), tail.tail!)
    const collected = new Set<HopId>([id])
    const owing = new Set<HopId>(hop.owesStores ? [id] : [])
    let first: MemberPath | null = null
    let repeats = 0
    for (let node = tail; node; node = node.tail) {
      if (node.kind === 'summary') {
        if (first === null) {
          for (const held of node.hops) collected.add(held)
          for (const held of node.owing) owing.add(held)
          if (node.hops.has(id)) return summaryPath(collected, owing, node.tail!)
        } else if (node.hops.has(id)) repeats += PLAIN_REPEATS
        continue
      }
      const nodeId = hopIdOf(node)
      if (nodeId === id) {
        repeats += 1
        first ??= node
      } else if (first === null) {
        collected.add(nodeId)
        if (node.owesStores) owing.add(nodeId)
      }
    }
    return repeats >= PLAIN_REPEATS ? summaryPath(collected, owing, first!) : plainPath(hop, tail)
  }
  /**
   * Every path the followed value can still be at after a read of `read` from
   * an object at `path`; empty when the read selects a sibling slot. A null
   * entry means the read yields the followed value itself. Every entry must be
   * closed: a summary can both repeat and exit on the same hop.
   */
  const stepPath = (path: MemberPath, read: SlotRead): readonly (MemberPath | null)[] => {
    if (path.kind !== 'summary') return readMatches(hopIdOf(path), read) ? [path.tail] : []
    const exits = stepPath(path.tail!, read)
    for (const id of path.hops) if (readMatches(id, read)) return [path, ...exits]
    return exits
  }
  /**
   * Where a value STORED through `read` into an object at `path` has to be
   * published: the continuation of every owed hop the store selects (see
   * `Hop.owesStores`). A null continuation would say the stored value is the
   * followed value itself, whose aliases the walk already enumerates from its
   * own allocations, so it contributes nothing.
   */
  const storeObligations = (path: MemberPath, read: SlotRead): readonly MemberPath[] => {
    const found: MemberPath[] = []
    for (let node: MemberPath | null = path; node;) {
      if (node.kind !== 'summary') {
        if (node.owesStores && node.tail !== null && readMatches(hopIdOf(node), read)) found.push(node.tail)
        break
      }
      if ([...node.owing].some((id) => readMatches(id, read))) found.push(node)
      node = node.tail
    }
    return found
  }
  /** Every hop a read at `path` could be selecting. */
  const headsOf = (path: MemberPath): readonly HopId[] =>
    path.kind === 'summary' ? [...path.hops, ...headsOf(path.tail!)] : [hopIdOf(path)]
  const headsOwe = (path: MemberPath): boolean => (path.kind === 'summary' ? path.owing.size > 0 || headsOwe(path.tail!) : path.owesStores)
  const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/
  /**
   * Whether a named read at `path` can be told apart from every hop the path
   * could be taking: a key compared with keys. A hop named only by its
   * declaration could share its runtime slot with any key, and a numeric key
   * names an element.
   */
  const siblingKeyed = (path: MemberPath, key: string | null): key is string =>
    key !== null && headsOf(path).every((id) => !id.startsWith('#') && (id !== '[]' || !CANONICAL_INDEX.test(key)))
  /** The followed value, or an object holding it at `continuation`. */
  const onward = (expression: ts.Expression, continuation: MemberPath | null): boolean =>
    continuation ? containerUse(expression, continuation) : receiverUse(expression)
  /**
   * Coinduction with a Tarjan low-link, shared by every memoized walk of this
   * proof.
   *
   * A walk re-entering a question still being answered assumes it holds --
   * the greatest fixpoint, which is what makes a cyclic object graph provable
   * at all. But an answer computed under that assumption is only as good as
   * the assumption, so it is cached only once the question it leaned on has
   * itself been answered `true`: until then it is parked with the frame that
   * owns the assumption and dropped if that frame fails. A plain "seen" set
   * never un-marks, and inside `a || b` a mention first marked in a FAILED
   * branch `a` answered `true` in branch `b`.
   */
  type Answer = boolean | number
  interface ProofFrame {
    lowest: number
    readonly parked: (() => void)[]
  }
  const frames: ProofFrame[] = []
  const coinduct = <K>(table: Map<K, Answer>, key: K, compute: () => boolean): boolean => {
    const held = table.get(key)
    if (held === true || held === false) return held
    if (held !== undefined) {
      const top = frames[frames.length - 1]
      if (top && held < top.lowest) top.lowest = held
      return true
    }
    const depth = frames.length
    const frame: ProofFrame = { lowest: Number.POSITIVE_INFINITY, parked: [] }
    table.set(key, depth)
    frames.push(frame)
    let result = false
    try {
      result = compute()
    } finally {
      frames.pop()
      if (!result) table.set(key, false)
      else if (frame.lowest >= depth) {
        table.set(key, true)
        for (const settle of frame.parked) settle()
      } else {
        table.delete(key)
        const parent = frames[frames.length - 1]
        if (parent) {
          if (frame.lowest < parent.lowest) parent.lowest = frame.lowest
          parent.parked.push(...frame.parked, () => table.set(key, true))
        }
      }
    }
    return result
  }
  const containerAnswers = new Map<MemberPath, Map<ts.Node, Answer>>()
  const publishAnswers = new Map<MemberPath | null, Map<ts.Node, Answer>>()
  const receiverAnswers = new Map<ts.Node, Answer>()
  const arrayAnswers = new Map<ts.Node, Answer>()
  /**
   * A member lookup asks which DECLARATION a key names, and a receiver still
   * carrying its nullish arms names the same one: `output.setEffects` where
   * `output` is `WebGLOutput | null` reaches exactly one `setEffects`, and a
   * receiver that really is null throws AT the access rather than reaching some
   * other declaration -- so the null arm contributes no member and no escape
   * path. `field-bindings.ts`'s `memberSymbolOf` already states this for the
   * same question; asking it differently here left every call through an
   * unnarrowed nullable receiver without a declaration, and a receiver whose
   * method calls cannot be named cannot be proven closed.
   *
   * The strip stops at a union: `getPropertyOfType` on a multi-arm union
   * synthesizes a union property whose declaration is a single arm's node, and
   * a closure proof walking that one node would silently miss the others.
   * Where removing the nullish arms would expose a union, the old refusal is
   * still the honest answer.
   */
  const fieldDeclarationOf = (expression: ts.Expression, key: string | null): ts.Declaration | null => {
    const receiver = receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression)
    const nonNullable = checker.getNonNullableType(receiver)
    const named = nonNullable === receiver || !nonNullable.isUnion() ? nonNullable : receiver
    const symbol = key !== null ? checker.getPropertyOfType(checker.getApparentType(named), key) : undefined
    const declared = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (declared) return declared
    if (key === null) return null
    const plan = sourceClassDataMemberPlanOf(
      checker,
      flow,
      { kind: 'value', receiver: receiver, expression: expression, originsOf: allocationOriginsOf },
      key
    )
    return plan?.declarations.length === 1 ? plan.declarations[0]! : null
  }
  /**
   * Every declaration a named member of `expression` can be: the checker's
   * own, else every source class that can construct the receiver, else the
   * entry of each object literal the receiver can have been allocated as.
   *
   * The last is how three's pooled render items are read: `renderItem` comes
   * back out of an untyped array, so the checker names no `id` on it, but
   * every render item is the one literal `getNextRenderItem` writes. Empty
   * when any allocation lacks the key -- a prototype lookup is not a slot.
   */
  const fieldDeclarationsOf = (expression: ts.Expression, key: string | null): readonly ts.Declaration[] => {
    const declared = fieldDeclarationOf(expression, key)
    if (declared) return [declared]
    if (key === null || key === '__proto__' || key === 'constructor') return []
    const receiver = receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression)
    const classPlan = sourceClassDataMemberPlanOf(
      checker,
      flow,
      { kind: 'value', receiver: receiver, expression: expression, originsOf: allocationOriginsOf },
      key
    )
    if (classPlan !== null && classPlan.declarations.length > 0) return classPlan.declarations
    const recordPlan = sourceRecordDataWritePlanOf(flow, expression, key, computedKeyAuthority)
    if (recordPlan === null || recordPlan.needsDefaultPrototype) return []
    const found: ts.Declaration[] = []
    for (const root of recordPlan.roots) {
      const entries = root.properties.filter((property) => property.name !== undefined && publicationKeyOf(property.name) === key)
      if (entries.length !== 1) return []
      found.push(entries[0]!)
    }
    return found
  }
  /**
   * The declarations a named read of a sibling slot can run, over EVERY
   * object `reference` can denote, or null when they cannot all be named.
   *
   * Where the allocations are enumerable record literals, each literal's own
   * entry is the answer. A structural type is not: a second literal of the
   * same shape with a getter under the key -- stored into the same field the
   * render item is -- satisfies `{ id: number }` too, and its getter runs on
   * whichever object is read. So a property signature or a literal entry the
   * checker names is taken only through the record plan; a class member the
   * checker or a source class plan names is taken as the member walk takes it
   * everywhere else.
   */
  const siblingDeclarationsOf = (reference: ts.Expression, key: string): readonly ts.Declaration[] | null => {
    if (key === '__proto__' || key === 'constructor') return null
    const roots = recordRootsAt(reference, key)
    if (roots !== null) {
      const found: ts.Declaration[] = []
      for (const root of roots) {
        const entries = root.properties.filter((property) => property.name !== undefined && publicationKeyOf(property.name) === key)
        if (entries.length !== 1) return null
        found.push(entries[0]!)
      }
      return found
    }
    const declared = fieldDeclarationOf(reference, key)
    if (declared !== null)
      return ts.isPropertySignature(declared) ||
        ts.isMethodSignature(declared) ||
        ts.isPropertyAssignment(declared) ||
        ts.isShorthandPropertyAssignment(declared) ||
        ts.isObjectLiteralExpression(declared.parent)
        ? null
        : [declared]
    const receiver = receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference)
    const classPlan = sourceClassDataMemberPlanOf(
      checker,
      flow,
      { kind: 'value', receiver: receiver, expression: reference, originsOf: allocationOriginsOf },
      key
    )
    return classPlan !== null && classPlan.declarations.length > 0 ? classPlan.declarations : null
  }
  /**
   * Every record literal `reference` can denote when `key` is read, or null.
   * Beyond the record plan's own origins, local bindings consume the same
   * whole-write projection as class origins, including closed iteration.
   */
  const recordRootsAt = (reference: ts.Expression, key: string): readonly ts.ObjectLiteralExpression[] | null => {
    const plan = sourceRecordDataWritePlanOf(flow, reference, key, computedKeyAuthority)
    if (plan !== null) return plan.needsDefaultPrototype ? null : plan.roots
    const value = unwrapValue(reference)
    const declaration = ts.isIdentifier(value) ? flow.targetOf(value)?.declaration : undefined
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null
    if (!flow.writesToDeclaration(declaration).some((write) => write.iterationOrigin !== undefined)) return null
    const stored = bindingValuesOf(declaration)
    if (stored === null) return null
    const roots = new Set<ts.ObjectLiteralExpression>()
    for (const held of stored) {
      const inner = sourceRecordDataWritePlanOf(flow, held, key, computedKeyAuthority)
      if (inner === null || inner.needsDefaultPrototype) return null
      for (const root of inner.roots) roots.add(root)
    }
    return [...roots]
  }
  // Declaration lookup may consult this proof's parameter origins and record
  // closure assumptions. The flow index is shared by proofs with different
  // frames, so it cannot own this cache.
  const fieldDeclarations = new Map<ts.Node, ts.Declaration | null>()
  const fieldDeclaration = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Declaration | null => {
    const held = fieldDeclarations.get(access)
    if (held !== undefined) return held
    const answer = fieldDeclarationUncached(access)
    fieldDeclarations.set(access, answer)
    return answer
  }
  const fieldDeclarationUncached = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.Declaration | null => {
    const target = flow.targetOf(access)?.declaration
    if (target && ts.isDeclarationStatement(target)) return target
    // A declaration-only member access is a declaration node TypeScript's own
    // JS class inference produces; it just is not in the `Declaration` union's
    // static spelling.
    if (target && declaredDataMemberAccess(target)) return target as ts.Declaration
    // A special assignment (`this.setEffects = function ...`) is a declaration
    // form -- `dataDeclaration` below accepts exactly this shape. Leaving it
    // out here discarded an answer the flow index had ALREADY resolved and
    // forced the same question to be re-asked through the receiver's type,
    // which is precisely where an unresolved or nullable receiver has no
    // answer to give. Take the resolved node.
    if (
      target &&
      (ts.isPropertyAssignment(target) ||
        ts.isPropertyDeclaration(target) ||
        ts.isPropertySignature(target) ||
        ts.isMethodDeclaration(target) ||
        (ts.isBinaryExpression(target) &&
          target.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (ts.isPropertyAccessExpression(target.left) || ts.isElementAccessExpression(target.left))))
    )
      return target
    const key = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : ts.isStringLiteralLike(access.argumentExpression)
        ? access.argumentExpression.text
        : null
    const declared = fieldDeclarationOf(access.expression, key)
    if (declared !== null) return declared
    // An untyped receiver whose every allocation carries the key in one
    // literal entry: three reads `currentRenderList` out of an `any`, and
    // every list is the literal `WebGLRenderList` returns.
    const records = fieldDeclarationsOf(access.expression, key)
    return records.length === 1 ? records[0]! : null
  }
  const dataDeclaration = (declaration: ts.Declaration): boolean =>
    declaredDataMemberAccess(declaration) ||
    ts.isPropertyAssignment(declaration) ||
    ts.isShorthandPropertyAssignment(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isParameterPropertyDeclaration(declaration, declaration.parent) ||
    ts.isPropertySignature(declaration) ||
    (ts.isBinaryExpression(declaration) &&
      declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(declaration.left) || ts.isElementAccessExpression(declaration.left)))
  const constructedData = new Map<ts.Expression, Map<string, boolean>>()
  const recordDataMemberOf = (expression: ts.Expression, key: string): boolean => {
    const plan = sourceRecordDataWritePlanOf(flow, expression, key, computedKeyAuthority)
    return plan !== null && recordRootsClosed(plan.roots, key, expression, plan.needsDefaultPrototype, 'data-descriptor')
  }
  /** Whether every use of these record literals is closed for a read of `key`. */
  const recordRootsClosed = (
    roots: readonly ts.ObjectLiteralExpression[],
    key: string,
    expression: ts.Expression,
    needsDefaultPrototype: boolean,
    purpose: 'data-descriptor' | 'stable-callable-slot'
  ): boolean => {
    let active = activeRecordProofs.get(flow)
    if (!active) activeRecordProofs.set(flow, (active = new Set()))
    // One closure for the whole scan, not one per stored proof: `roots` is
    // fixed for this call, and this loop is walked for every record question
    // the proof asks. A live allocation profile charged `recordRootsClosed`
    // 54% of all sampled bytes (`measurements/live-av-hoisted.cpuprofile`
    // alongside the heap sample), and a per-iteration arrow is the only thing
    // here that allocates per iteration.
    const sameRoots = (root: ts.ObjectLiteralExpression): boolean => roots.includes(root)
    for (const proof of active)
      if (
        proof.key === key &&
        proof.purpose === purpose &&
        proof.receiverTypeAt === receiverTypeAt &&
        proof.roots.length === roots.length &&
        proof.roots.every(sameRoots)
      ) {
        noteAssumption(proof)
        return true
      }
    const proof = { roots, key, receiverTypeAt, purpose }
    active.add(proof)
    try {
      const ledger = deferredIntrinsicProtocolLedgerOf(flow)
      // A root lacking the slot reads exactly `key` through `Object.prototype`.
      if (needsDefaultPrototype && ledger?.requirePrototypeKeys('Object', { names: [key] }, expression) !== true) return false
      // The value-use traversal carries these exact allocations through
      // formal parameters; a callback's ambient incoming type is not a second
      // origin for the record currently being followed.
      const selectsData = (selectedKey: string, reference: ts.Expression): boolean =>
        roots.every((root) => {
          const selected = sourceRecordDataWritePlanOf(flow, root, selectedKey, computedKeyAuthority)
          return (
            selected !== null &&
            (!selected.needsDefaultPrototype || ledger?.requirePrototypeKeys('Object', { names: [selectedKey] }, reference) === true)
          )
        })
      const terminalUse = (reference: ts.Expression): boolean | null => {
        // `const { object, geometry, group } = renderItem` in three's
        // `renderObjects` reads each key exactly as `renderItem.object` would.
        // A rest element copies every own slot out, so it stays with the
        // shared engine.
        const holder = reference.parent
        if (
          ts.isVariableDeclaration(holder) &&
          holder.initializer === reference &&
          ts.isObjectBindingPattern(holder.name) &&
          holder.name.elements.every((element) => !element.dotDotDotToken)
        ) {
          const destructured = objectBindingReadsOf(flow, reference)
          if (destructured !== null && destructured.length === holder.name.elements.length)
            return destructured.every(({ key: selectedKey }) => selectsData(selectedKey, reference))
        }
        const access = reference.parent
        if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) || access.expression !== reference)
          return null
        const context = access.parent
        if (ts.isCallExpression(context) && context.expression === access) return null
        if (ts.isDeleteExpression(context) || ts.isPostfixUnaryExpression(context) || ts.isPrefixUnaryExpression(context)) return false
        // A compound assignment; `this.enabled === false` is a read like any other.
        if (
          ts.isBinaryExpression(context) &&
          context.left === access &&
          context.operatorToken.kind > ts.SyntaxKind.FirstAssignment &&
          context.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          return false
        const selectedKey = ts.isPropertyAccessExpression(access)
          ? access.name.text
          : ts.isStringLiteralLike(access.argumentExpression)
            ? access.argumentExpression.text
            : null
        if (selectedKey === null) return false
        // Plain data can be overwritten without changing its descriptor.
        // That same write invalidates a proof of the original callable slot.
        if (
          purpose === 'stable-callable-slot' &&
          selectedKey === key &&
          ts.isBinaryExpression(context) &&
          context.left === access &&
          context.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
          return false
        return selectsData(selectedKey, reference)
      }
      // The question by content: the same record family read under the
      // same key for the same purpose is the same proof whichever member
      // proof instance asks it, and each instance mints its own `roots`
      // array and `terminalUse` closure.
      const identity = `record:${purpose}:${key}:${nodeSetToken(roots)}`
      return hasClosedValueUses(checker, flow, roots, terminalUse, receiverTypeAt, argumentsUsesAt, onOpenUse, identity, proof)
    } finally {
      active.delete(proof)
    }
  }
  const constructionDataMemberOf = (expression: ts.Expression, key: string | null): boolean => {
    if (key === null || key === '__proto__' || key === 'constructor') return false
    // Probe the cache BEFORE the two checker calls and the record walk. Asking
    // `receiverTypeAt`, `getBaseConstraintOfType` and a full
    // `sourceRecordDataWritePlanOf` first meant the memo below saved only the
    // last of the three costs, on a predicate the walk asks constantly.
    let entries = constructedData.get(expression)
    if (!entries) constructedData.set(expression, (entries = new Map()))
    const held = entries.get(key)
    if (held !== undefined) return held
    if (sourceRecordDataWritePlanOf(flow, expression, key, computedKeyAuthority)) {
      // Record proofs are guarded by their own re-entrancy set and must not be
      // frozen into this class-shaped memo.
      return recordDataMemberOf(expression, key)
    }
    const heldReceiver = receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression)
    const receiver = checker.getBaseConstraintOfType(heldReceiver) ?? heldReceiver
    const result =
      sourceClassDataMemberPlanOf(
        checker,
        flow,
        { kind: 'value', receiver: receiver, expression: expression, originsOf: allocationOriginsOf },
        key
      ) !== null
    entries.set(key, result)
    return result
  }
  const constructionDataMember = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean =>
    constructionDataMemberOf(
      access.expression,
      ts.isPropertyAccessExpression(access)
        ? access.name.text
        : ts.isStringLiteralLike(access.argumentExpression)
          ? access.argumentExpression.text
          : null
    )
  /**
   * A read of `key` off record literals whose every alias is followed
   * (`recordLiteralReceiverClosed`), each holding `key` as its one own data
   * entry: nothing can have replaced that entry with an accessor, since no
   * alias reaches code that could. The allocations are the record plan's --
   * or, for `this` in a function the literal was written holding, the literal
   * itself, which the same proof makes the only possible receiver.
   *
   * Three's `ColorManagement.convert` reads `this.enabled`, and `Color` reads
   * the imported `ColorManagement.workingColorSpace`. The checker names the
   * literal's entry for both -- a name a second literal with a getter under
   * that key would satisfy just as well, which is why it is not evidence.
   */
  const ownLiteralDataMember = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    const key = accessKeyOf(access)
    if (key === null || key === '__proto__' || key === 'constructor') return false
    const roots = ownLiteralRootsOf(access.expression, key)
    return (
      roots !== null &&
      roots.length > 0 &&
      roots.every((literal) => {
        const entries = literal.properties.filter(
          (property) => property.name !== undefined && objectLiteralEntryKeyOf(property.name) === key
        )
        const entry = entries.length === 1 ? entries[0]! : null
        return (
          entry !== null &&
          (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
          recordLiteralReceiverClosed(checker, flow, literal)
        )
      })
    )
  }
  const ownLiteralRootsOf = (expression: ts.Expression, key: string): readonly ts.ObjectLiteralExpression[] | null => {
    const receiver = unwrapValue(expression)
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword) {
      const plan = sourceRecordDataWritePlanOf(flow, expression, key, computedKeyAuthority)
      return plan === null || plan.needsDefaultPrototype ? null : plan.roots
    }
    const owner = receiverOwnerOf(receiver)
    if (owner && ts.isMethodDeclaration(owner) && ts.isObjectLiteralExpression(owner.parent)) return [owner.parent]
    return owner &&
      ts.isFunctionExpression(owner) &&
      !owner.name &&
      ts.isPropertyAssignment(owner.parent) &&
      owner.parent.initializer === owner &&
      ts.isObjectLiteralExpression(owner.parent.parent)
      ? [owner.parent.parent]
      : null
  }
  const descendsFrom = (type: ts.Type, baseSymbol: ts.Symbol): boolean => descendsFromNominal(checker, type, baseSymbol)
  const virtualAccessors = new Map<ts.Node, ReadonlyMap<ts.SyntaxKind, readonly ts.AccessorDeclaration[]>>()
  /**
   * Every accessor body a read or write through this access could actually
   * enter, indexed by which half of the pair the access invokes.
   *
   * An accessor read is a CALL that runs user code with this receiver bound,
   * which is why the member-read arm below refuses one outright. That refusal
   * is stronger than it needs to be: the body is right there to be proven, the
   * same way a method body is. Three's `Camera` states `reversedDepth` as a
   * getter over `this._reversedDepth`, and `this.reversedDepth` inside
   * `updateProjectionMatrix` was the terminal of 35 escapes -- `WebGLState`'s
   * whole buffer family among them -- for a getter that does nothing but read
   * one of its own fields.
   *
   * Every nominal DESCENDANT that declares the key as an accessor of the
   * invoked kind is returned and the caller must prove them all: the runtime
   * type selects the arm. A descendant declaring the key as data or as a
   * method contributes no body, because reading or storing one runs no code.
   */
  const virtualAccessorsOf = (expression: ts.Expression, key: string): ReadonlyMap<ts.SyntaxKind, readonly ts.AccessorDeclaration[]> => {
    const cached = virtualAccessors.get(expression)
    if (cached) return cached
    const receiver = receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression)
    const stated = checker.getApparentType(checker.getNonNullableType(receiver))
    const found = virtualAccessorsFor(checker, flow, stated, key, descendsFrom)
    virtualAccessors.set(expression, found)
    return found
  }
  /** Whether the receiver's STATED type declares `key` only as accessors, so
   * no data slot is written or read by an access to it on that type. */
  const statedAccessorAt = (expression: ts.Expression, key: string): boolean => {
    const receiver = receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression)
    const declarations = checker.getApparentType(checker.getNonNullableType(receiver)).getProperty(key)?.declarations ?? []
    return declarations.length > 0 && declarations.every((node) => ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
  }
  /** Which halves of an accessor pair this access position invokes. */
  const accessorKindsAt = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly ts.SyntaxKind[] => {
    const owner = access.parent
    const both = [ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor]
    if ((ts.isPostfixUnaryExpression(owner) || ts.isPrefixUnaryExpression(owner)) && owner.operand === access) return both
    if (ts.isBinaryExpression(owner) && owner.left === access) {
      const operator = owner.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsToken) return [ts.SyntaxKind.SetAccessor]
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return both
    }
    if (ts.isDeleteExpression(owner) || (ts.isForInStatement(owner) && owner.initializer === access)) return both
    return [ts.SyntaxKind.GetAccessor]
  }
  /**
   * Every function a member slot can hold, or null when something else can.
   *
   * A slot written only with function values is a slot whose calls all enter
   * one of those bodies; a slot written with anything else -- or written in a
   * shape this cannot read -- can hold an external callable, and then no body
   * is named. That distinction is the whole content of the proof, so it is
   * stated once here and asked by both the receiver walk and the argument
   * walk below.
   */
  const resolvedImplementations = new Map<
    ts.Declaration,
    {
      readonly value: readonly ts.SignatureDeclaration[] | null
      readonly requirements: readonly IntrinsicProtocolRequirement[]
    }
  >()
  const resolvingImplementations = new Set<ts.Declaration>()
  const memberImplementationsOf = (declaration: ts.Declaration): readonly ts.SignatureDeclaration[] | null => {
    if (resolvingImplementations.has(declaration)) {
      // Same park as an open invocation fact: "unknown while I am answering".
      noteHypothesis(declaration)
      return null
    }
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const known = resolvedImplementations.get(declaration)
    if (known?.value === null) return null
    if (known && (known.requirements.length === 0 || ledger?.include(known.requirements) === true)) return known.value
    let inventories = memberImplementationInventories.get(flow)
    if (!inventories) memberImplementationInventories.set(flow, (inventories = new Map()))
    let inventory = inventories.get(declaration)
    if (inventory === undefined) {
      inventory = memberImplementationsUncached(declaration)
      inventories.set(declaration, inventory)
    }
    if (inventory === null) return null
    const collected = inventory
    const compute = (): readonly ts.SignatureDeclaration[] | null => {
      const found = new Set(collected.bodies)
      for (const value of collected.values) {
        const targets = closedCallableTargetsOf(checker, flow, value, elementCalleeAuthority)
        if (targets === null) {
          if (process.env['GEA_IMPLEMENTATIONS_DEBUG'] !== undefined)
            console.error(`[IMPLEMENTATIONS] callable-origins-open${describeNode(value)}`)
          return null
        }
        for (const target of targets) found.add(target)
      }
      return [...found]
    }
    resolvingImplementations.add(declaration)
    enterHypothesisGuard(declaration)
    // What the re-entry above hands out is a REFUSAL (`return null`). So the
    // hypothesis is confirmed exactly when this walk also refuses; then every
    // answer that leaned on it rested on something true and becomes
    // unconditional. Passing nothing here said "cannot tell", which strikes
    // them all: measured, 787,705 answers were registered against these guards
    // and 0 were ever confirmed, so 668,256 were struck AND spliced out of
    // their buckets -- which is why the buckets never filled and the same
    // questions kept missing.
    try {
      const answer = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
      // A failed walk may have proved earlier alternatives before meeting an
      // unknown callable. Those partial obligations support no accepted result.
      if (answer.value === null) return null
      if (answer.requirements.length > 0 && ledger?.include(answer.requirements) !== true) return null
      computedKeyAuthority.whenSettled(() => resolvedImplementations.set(declaration, answer))
      return answer.value
    } finally {
      exitHypothesisGuard(declaration, true)
      resolvingImplementations.delete(declaration)
    }
  }
  /**
   * A call through a base-typed receiver enters whichever body the runtime
   * object's class gives the key, so the slot's implementations are the
   * union over the declaring class and every nominal descendant that
   * redeclares it. `class A { m( x ) {} } class B extends A { m( x ) { sink( x
   * ) } }` with `a: A` holding a `B`: `a.m( v )` names `A.m`, and `B.m` is what
   * runs. An accessor anywhere in that family, or a descendant this program
   * cannot name, leaves the slot with no enumerable bodies.
   */
  const memberImplementationsUncached = (declaration: ts.Declaration): MemberImplementationInventory | null => {
    const own = ownImplementationsOf(declaration)
    if (own === null) return null
    const owner = memberOwnerClassOf(declaration)
    if (owner === null) return own
    // A private name is resolved lexically to the one class body that
    // declares it: a subclass cannot override or even redeclare it (its own
    // same-spelled `#name` is a wholly separate, unrelated field), so there is
    // no descendant family to union over. `memberKeyOf` cannot name it either
    // -- it only reads `Identifier`/string/numeric declaration names -- and
    // asking `checker.getPropertyOfType` for it below would fail the same way
    // `callable-reach.ts`'s `privateMemberDeclarationsOf` comment explains for
    // property access: the checker mangles a private property's declared-type
    // key with the declaring class's own internal symbol id. The own
    // implementation this declaration already computed is the whole answer.
    const declaredName = ts.getNameOfDeclaration(declaration)
    if (declaredName && ts.isPrivateIdentifier(declaredName)) return own
    const key = memberKeyOf(declaration)
    const ownerSymbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    if (!ownerSymbol || key === null) return null
    const inherited = new Set(checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(ownerSymbol), key)?.declarations ?? [declaration])
    const found = new Set(own.bodies)
    const values = new Set(own.values)
    for (const [writer, keys] of instanceMemberWritesOf(flow)) {
      const writes = keys.get(key)
      if (!writes) continue
      const symbol = writer.name ? checker.getSymbolAtLocation(writer.name) : checker.getTypeAtLocation(writer).getSymbol()
      if (!symbol || !descendsFrom(checker.getDeclaredTypeOfSymbol(symbol), ownerSymbol)) continue
      for (const write of writes) {
        if (write.value === null) return null
        values.add(write.value)
      }
    }
    // A JavaScript class can write one slot from several places -- `this.m =
    // f` in the constructor and again in a method -- and each is a
    // declaration of the same member.
    for (const node of inherited) {
      if (node === declaration) continue
      if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return null
      const bodies = ownImplementationsOf(node)
      if (bodies === null) return null
      for (const body of bodies.bodies) found.add(body)
      for (const value of bodies.values) values.add(value)
    }
    for (const other of flow.classDeclarations) {
      if (other === owner) continue
      const symbol = other.name ? checker.getSymbolAtLocation(other.name) : checker.getTypeAtLocation(other).getSymbol()
      if (!symbol) {
        // A declaration the checker gives no symbol cannot be placed on any
        // chain, so it is only safe to skip if it declares no base either. A
        // constructor function never does -- `familyRootsOf` refuses the
        // prototype-chain spelling at admission -- so the question is the
        // class-spelled one.
        if (isClassSpelledSourceClass(other) && other.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword))
          return null
        continue
      }
      const instance = checker.getDeclaredTypeOfSymbol(symbol)
      if (!descendsFrom(instance, ownerSymbol)) continue
      for (const node of instance.getProperty(key)?.declarations ?? []) {
        if (inherited.has(node)) continue
        if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return null
        const bodies = ownImplementationsOf(node)
        if (bodies === null) return null
        for (const body of bodies.bodies) found.add(body)
        for (const value of bodies.values) values.add(value)
      }
    }
    return { bodies: [...found], values: [...values] }
  }
  const ownImplementationsOf = (declaration: ts.Declaration): MemberImplementationInventory | null => {
    const bodies: ts.SignatureDeclaration[] = []
    const values = new Set<ts.Expression>()
    if (ts.isMethodDeclaration(declaration) && declaration.body) bodies.push(declaration)
    const written =
      ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
        ? declaration.initializer
        : ts.isShorthandPropertyAssignment(declaration)
          ? declaration.name
          : undefined
    if (written !== undefined) {
      const value = unwrapNaming(written)
      // A definitely non-callable initial value contributes no body; later
      // writes still contribute every callable it may install in this slot.
      if (
        !ts.isNumericLiteral(value) &&
        !ts.isStringLiteralLike(value) &&
        value.kind !== ts.SyntaxKind.TrueKeyword &&
        value.kind !== ts.SyntaxKind.FalseKeyword &&
        !ts.isObjectLiteralExpression(value) &&
        !ts.isArrayLiteralExpression(value)
      )
        values.add(value)
    }
    for (const write of flow.writesToDeclaration(declaration)) {
      if (write.edge === 'return' || write.edge === 'yield') continue
      if (write.value === null || write.slot !== 'whole') return null
      values.add(write.value)
    }
    return { bodies, values: [...values] }
  }
  /**
   * The member declarations whose slots a call through `declared` can read:
   * its own symbol's declarations, and every descendant redeclaration
   * `memberImplementationsOf` took bodies from.
   */
  // MODULE-level, keyed by `flow`: `declared` plus the round's fixed class
  // list and checker facts fully determine the answer (`memberOwnerClassOf`/
  // `memberKeyOf` are pure syntax, not proof state), so every one of a round's
  // many proofs asking about the same slot -- three's many `.add(...)` sites
  // all reaching one `Object3D.prototype.add` -- can share one answer instead
  // of each re-walking `flow.classDeclarations` from zero.
  let slotDeclarationsCache = slotDeclarationsCaches.get(flow)
  if (!slotDeclarationsCache) slotDeclarationsCaches.set(flow, (slotDeclarationsCache = new Map()))
  const slotDeclarationsOf = (declared: ts.Declaration): readonly ts.Declaration[] => {
    const cached = slotDeclarationsCache.get(declared)
    if (cached) return cached
    const found: ts.Declaration[] = [declared]
    const owner = memberOwnerClassOf(declared)
    const key = memberKeyOf(declared)
    if (owner !== null && key !== null) {
      const ownerSymbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
      if (ownerSymbol) {
        for (const other of flow.classDeclarations) {
          const symbol = other.name ? checker.getSymbolAtLocation(other.name) : checker.getTypeAtLocation(other).getSymbol()
          if (!symbol || other === owner || !descendsFrom(checker.getDeclaredTypeOfSymbol(symbol), ownerSymbol)) continue
          const node = checker.getDeclaredTypeOfSymbol(symbol).getProperty(key)?.declarations?.[0]
          if (node && !found.includes(node)) found.push(node)
        }
      }
    }
    slotDeclarationsCache.set(declared, found)
    return found
  }
  /** The member symbol a slot declaration names. */
  const slotSymbolOf = (declaration: ts.Declaration): ts.Symbol | undefined => {
    const name = ts.isBinaryExpression(declaration)
      ? ts.isPropertyAccessExpression(declaration.left)
        ? declaration.left.name
        : undefined
      : ts.getNameOfDeclaration(declaration)
    return name ? checker.getSymbolAtLocation(name) : undefined
  }
  const slotClosures = new Map<
    ts.Symbol,
    { readonly value: boolean; readonly requirements: readonly IntrinsicProtocolRequirement[]; readonly assumed: ReadonlySet<object> }
  >()
  /**
   * Whether no code outside this program can reach a slot: every mention of
   * its key and every receiver it has is closed, every write names a known
   * function. Asked with every call through the slot counted -- a call is not
   * a leak of the function value, and its arguments are the caller's own
   * question. Proof-local: the answer leans only on this proof's census view.
   */
  const memberSlotClosed = (declaration: ts.Declaration): boolean => {
    const symbol = slotSymbolOf(declaration)
    if (!symbol) return false
    const held = slotClosures.get(symbol)
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    if (held !== undefined) {
      // A proof-local cache must still REPORT what its answer leaned on. The
      // parks are constant for this proof, so hiding them was harmless while
      // nothing outside the proof kept an answer -- but a shared refusal memo
      // does, and one that silently dropped a park would be replayed where the
      // park is gone.
      for (const key of held.assumed) noteAssumption(key)
      return held.value && (held.requirements.length === 0 || ledger?.include(held.requirements) === true)
    }
    const calls = new Set<ts.CallExpression | ts.NewExpression>()
    for (const entry of symbol.declarations ?? []) {
      // Inferred receivers can leave the checker's member reference unbound.
      // The shared call inventory still attributes the invocation to this
      // slot; counting it consumes no claim about the argument's provenance.
      if (ts.isFunctionLike(entry)) for (const site of callsOf(flow).declarations.get(entry) ?? []) calls.add(site.call)
      for (const reference of flow.referencesToDeclaration(entry)) {
        const access = ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference ? reference.parent : reference
        const call = access.parent
        if (ts.isCallExpression(call) && call.expression === access) calls.add(call)
      }
    }
    // An untyped record receiver names no declaration the index files the
    // call under: its calls are found by key and admitted where the slot is
    // what they read.
    for (const entry of symbol.declarations ?? []) {
      if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) continue
      const key = publicationKeyOf(entry.name)
      if (key === null) continue
      for (const site of memberNamedCallsOf(key)) {
        const callee = ts.isCallExpression(site.call) ? unwrapNaming(site.call.expression) : null
        const read = callee && ts.isPropertyAccessExpression(callee) ? fieldDeclaration(callee) : null
        if (read !== null && (symbol.declarations ?? []).includes(read)) calls.add(site.call)
      }
    }
    const prove = () =>
      hasClosedMemberCallableUses(checker, flow, symbol, calls, receiverTypeAt, argumentsUsesAt, onOpenUse, nestedMembers, nestedFamilies())
    const trail = pushHypothesisTrail()
    let closed: { readonly value: boolean; readonly requirements: readonly IntrinsicProtocolRequirement[] }
    try {
      closed = ledger ? ledger.capture(prove) : { value: prove(), requirements: [] }
    } finally {
      popHypothesisTrail()
    }
    for (const key of trail) noteAssumption(key)
    slotClosures.set(symbol, { ...closed, assumed: trail })
    return closed.value && (closed.requirements.length === 0 || ledger?.include(closed.requirements) === true)
  }

  /**
   * Whether the slot `declared` names can hold anything but the bodies its
   * class family declares for it -- the TARGET-IDENTITY half of slot closure,
   * answered from the program's writes alone.
   *
   * `memberSlotClosed` answers a stronger question: every mention of the key
   * AND every receiver it has must be closed, so that the callers of the slot
   * -- and the arguments and receivers they supply -- are all known. That is
   * the right question for `parameterValuesOf`/`receiverValuesOf`, and the
   * wrong one for "which bodies can this call reach": a call through an
   * unresolvable receiver is not a write, and it cannot change what the slot
   * holds for anyone. Asked as one conjunction over the whole program, one
   * `geometry.getAttribute( ... )` off an untyped parameter opened
   * `BufferGeometry.getAttribute` for the 1,179 typed call sites of the same
   * key in the three.js app, and every math class's `copy`/`set`/`add` the same way --
   * so every reach proof in three's renderer refused as one cycle, and no
   * fixture-sized fix ever moved the refused-site count (2,227 -> 2,227
   * across six root fixes on 2026-09-14).
   *
   * Everything reachable here is program text compiled by this compiler; the
   * only code that can install a different callable in the slot is a WRITE
   * this walk can see: a named write of the key, a computed-key write whose
   * key may be it, an intrinsic mutator (`Object.assign`/`defineProperty`/
   * `defineProperties`/`setPrototypeOf`, `Reflect.set`/`defineProperty`)
   * handed a receiver that may be a family instance (or the family's
   * `prototype`), a `__proto__`/`prototype` replacement, or a `delete`. Each
   * is refused unless its receiver provably lies OUTSIDE the family; a slot
   * that has such a write at all is left to `memberSlotClosed`, which knows
   * how to admit a closed callable value. Nothing here is a claim about the
   * slot's callers, so nothing here feeds the caller inventories.
   */
  const slotWriteClosures = new Map<ts.Declaration, boolean>()
  const memberSlotWritesClosed = (declared: ts.Declaration): boolean => {
    const cached = slotWriteClosures.get(declared)
    if (cached !== undefined) return cached
    // A re-entry through `allocationOriginsOf` below refuses rather than assumes.
    slotWriteClosures.set(declared, false)
    const answer = slotWritesClosedUncached(declared)
    slotWriteClosures.set(declared, answer)
    return answer
  }
  const slotWritesClosedUncached = (declared: ts.Declaration): boolean => {
    if (!ts.isClassElement(declared)) return false
    const owner = memberOwnerClassOf(declared)
    const key = memberKeyOf(declared)
    if (owner === null || key === null) return false
    const symbolOf = (node: SourceClass): ts.Symbol | undefined =>
      node.name ? checker.getSymbolAtLocation(node.name) : checker.getTypeAtLocation(node).getSymbol()
    const ownerSymbol = symbolOf(owner)
    if (!ownerSymbol) return false
    const inFamily = (node: SourceClass): boolean => {
      const symbol = symbolOf(node)
      return symbol !== undefined && descendsFrom(checker.getDeclaredTypeOfSymbol(symbol), ownerSymbol)
    }
    const classOfReference = (expression: ts.Expression): SourceClass | null => {
      const symbol = checker.getSymbolAtLocation(expression)
      const declaration = symbol?.valueDeclaration
      return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) ? declaration : null
    }
    // A receiver is outside the family only when its allocations are exactly
    // enumerated and none is a family class -- `this` in a member of a class
    // outside the family included. Anything unresolvable may be an instance.
    const mayBeFamilyInstance = (receiver: ts.Expression): boolean => {
      const value = unwrapValue(receiver)
      if (value.kind === ts.SyntaxKind.ThisKeyword || value.kind === ts.SyntaxKind.SuperKeyword) {
        const frame = flow.receiverOwnerOf(value)
        const home = frame && ts.isClassElement(frame) ? frame.parent : null
        return home === null || !(ts.isClassDeclaration(home) || ts.isClassExpression(home)) || inFamily(home)
      }
      // `C.prototype` / `C` for a class outside the family names no instance
      // of it; for a family class it is the shared holder of the slot.
      if (ts.isPropertyAccessExpression(value) && value.name.text === 'prototype') {
        const named = classOfReference(value.expression)
        return named === null || inFamily(named)
      }
      const named = classOfReference(value)
      if (named !== null) return inFamily(named)
      const origins = allocationOriginsOf(value)
      if (origins === null) return true
      for (const allocated of origins.classes) if (inFamily(allocated)) return true
      return false
    }
    const literalKeysOf = spelledLiteralKeysOf
    // A computed key whose static type is numeric, or a literal set not
    // holding the key, cannot address this slot (`computedKeyMayBeMember`,
    // shared with the receiver-alias walk).
    const computedKeyMayBe = (argument: ts.Expression): boolean => computedKeyMayBeMember(checker, argument, key)
    const inventory = slotWriteInventoryOf(checker, flow)
    for (const access of inventory.namedWrites.get(key) ?? []) if (mayBeFamilyInstance(access.expression)) return false
    for (const access of inventory.namedWrites.get('__proto__') ?? []) if (mayBeFamilyInstance(access.expression)) return false
    for (const access of inventory.namedWrites.get('prototype') ?? []) {
      const named = classOfReference(unwrapValue(access.expression))
      if (named === null || inFamily(named)) return false
    }
    for (const access of inventory.computedWrites) {
      if (!computedKeyMayBe(access.argumentExpression)) continue
      if (mayBeFamilyInstance(access.expression)) return false
    }
    for (const { call, name } of inventory.intrinsicMutators) {
      const target = call.arguments[0]
      if (!target || !mayBeFamilyInstance(target)) continue
      if (name === 'setPrototypeOf') return false
      if (name === 'assign') {
        for (const source of call.arguments.slice(1)) {
          const keys = literalKeysOf(source)
          if (keys === null || keys.has(key)) return false
        }
        continue
      }
      if (name === 'defineProperties') {
        const keys = call.arguments[1] ? literalKeysOf(call.arguments[1]) : null
        if (keys === null || keys.has(key)) return false
        continue
      }
      // `defineProperty` / `Reflect.set` / `Reflect.defineProperty`: the key is the second operand.
      const named = call.arguments[1]
      if (!named) return false
      const spelled = unwrapValue(named)
      if (ts.isStringLiteralLike(spelled) ? spelled.text === key : computedKeyMayBe(spelled)) return false
    }
    return true
  }
  /**
   * Whether any instance of this family is handed to a callable this program
   * did not compile.
   *
   * A purely syntactic scan, and deliberately so: the question is asked from
   * inside the slot proof, so anything that re-enters the publication walk
   * (`hasClosedValueUses` over the construction roots) recurses into the very
   * proof it is answering. What it over-approximates is the direction that
   * REFUSES -- an argument reaching a body this program owns is treated as an
   * escape too -- and a refusal is the safe answer for target identity.
   */
  const familyEscapes = new Map<SourceClass, boolean>()
  // `memberSlotClosed`, consulted below for a class-member callee, recurses
  // through `memberSlotWrittenBodiesOf`/`slotClosedForTargets` back into this
  // scan -- for another owner, or for THIS one before `familyEscapes` holds an
  // answer (two families handing each other's instances to their own methods).
  // A re-entry gets the answer every other uncertain case here gets: escape.
  const provingFamilyEscape = new Set<SourceClass>()
  const familyInstancesEscape = (owner: SourceClass): boolean => {
    const cached = familyEscapes.get(owner)
    if (cached !== undefined) return cached
    if (provingFamilyEscape.has(owner)) return true
    provingFamilyEscape.add(owner)
    try {
      const escapes = familyInstancesEscapeUncached(owner)
      familyEscapes.set(owner, escapes)
      return escapes
    } finally {
      provingFamilyEscape.delete(owner)
    }
  }
  const familyInstancesEscapeUncached = (owner: SourceClass): boolean => {
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    const declared = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
    // A `this` argument carries the polymorphic `this` type, which relates to
    // no concrete class; its constraint is the class that declared the body,
    // and every instance reaching that body may be of this family.
    const mayBeFamily = (value: ts.Expression): boolean => {
      if (declared === null) return false
      const at = checker.getTypeAtLocation(value)
      const carried = checker.getBaseConstraintOfType(at) ?? at
      // A top type relates to every class and names none: `x.copy( x )` on an
      // `any` says nothing about THIS family, and reading it as an escape
      // would open every slot in every program that has one unplaced value.
      if ((carried.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false
      return checker.isTypeAssignableTo(carried, declared) || checker.isTypeAssignableTo(declared, carried)
    }
    for (const [node, site] of callsOf(flow).sites) {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) continue
      // `receiver.method()` through a callee this walk cannot name hands
      // `receiver` to that code as ITS `this`, exactly as an explicit argument
      // would: `this.width()` where `width` now holds an ambient callback
      // binds `this` to the very instance `this.leaf()` dispatches on one
      // statement later. Asked first, so that the callee proof below runs
      // only for the sites that hand this family anything at all.
      const receiver = site.operands.receiver
      if (!(node.arguments ?? []).some(mayBeFamily) && !(receiver !== null && mayBeFamily(receiver))) continue
      // A callee this program compiled keeps what it is handed here; one it
      // cannot name -- an ambient `declare function`, a host binding, a member
      // of the global object -- can install anything on what it receives.
      const declaration = checker.getResolvedSignature(node)?.declaration
      const home = declaration?.getSourceFile()
      // So does a STANDARD LIBRARY one, with two exceptions. The intrinsic
      // mutators `memberSlotWritesClosed` already decides precisely, by the
      // keys they are actually given, must not be re-read here as blanket
      // escapes. And a library function that RUNS the argument's own code --
      // `Object.values( owner )` invokes every accessor the owner declares,
      // `JSON.stringify` its `toJSON`, `Array.from` its iterator -- hands the
      // instance to code this program may or may not have compiled, and that
      // code can install anything; those are named in
      // `LIBRARY_ARGUMENT_EVALUATORS` and are escapes. Everything else in the
      // library (`push`, `set`, `console.log`, `Function.prototype.call`
      // forwarding to a compiled body) stores or reads and keeps nothing.
      const libraryCallee = home !== undefined && home.hasNoDefaultLib
      if (libraryCallee && !runsArgumentCode(node)) continue
      // A compiled body keeps what it is handed -- PROVIDED nothing has ALSO
      // handed that callee's own identity to code this program cannot see. A
      // resolved, in-program, body-bearing class member is not yet proof of
      // that: `globalThis.external( target.convert )` leaks the exact
      // function `target.convert( held )` later calls, and `target.convert =
      // globalThis.external` replaces it outright -- neither shows up in
      // `getResolvedSignature`, which answers from the class's STATIC declared
      // signature either way. `memberSlotClosed` is the proof that answers
      // both halves, reads and writes, for a member -- asked for the receiver
      // hand-off too: a leaked `convert` can be called by code outside the
      // program with any receiver and any argument, so what its body does
      // with either is no longer this program's to enumerate.
      const compiledBody =
        home !== undefined && !home.isDeclarationFile && (declaration as ts.FunctionLikeDeclarationBase).body !== undefined
      if (compiledBody && declaration !== undefined && (!ts.isClassElement(declaration) || memberSlotClosed(declaration))) continue
      return true
    }
    // A non-primitive `in` key is coerced (`ToPropertyKey`, which can invoke
    // `Symbol.toPrimitive`/`toString`) before `HasProperty` runs -- the same
    // escape `inertReceiverUse`'s own `InKeyword` arm already refuses per
    // receiver reference. This scan has to see it too: `memberSlotClosed`
    // correctly refuses `run` on `key in owner` with `key: object`, and the
    // syntactic arm re-admitted it because this call-only scan disagreed.
    const files = new Set<ts.SourceFile>()
    for (const call of flow.calls) files.add(call.call.getSourceFile())
    for (const access of flow.propertyAccesses) files.add(access.getSourceFile())
    let coercingInKey = false
    const visit = (node: ts.Node): void => {
      if (coercingInKey) return
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        !primitive(checker.getTypeAtLocation(node.left)) &&
        mayBeFamily(node.right)
      ) {
        coercingInKey = true
        return
      }
      ts.forEachChild(node, visit)
    }
    for (const file of files) visit(file)
    return coercingInKey
  }
  /**
   * Whether TARGET IDENTITY may rest on this slot.
   *
   * `memberSlotWritesClosed` reads every write in the program and finds none
   * that can reach the member. That settles target identity only while no
   * instance carrying the slot has been handed to code this program cannot
   * see: such code can install the member itself, and then the slot holds
   * whatever it installed. `memberSlotClosed` asks this as part of its own
   * proof -- it answers false for `external( held ); held.run( 1 )` -- and the
   * syntactic arm overrode it, so that call named `Derived.run` as its ONE
   * possible target while `external` was free to re-point the receiver. The
   * `this` receiver arm never took the shortcut, which is why `super.copy`
   * refused in the same program while the call reaching it did not.
   */
  const slotClosedForTargets = (slot: ts.Declaration): boolean => {
    // A private METHOD's target identity is fixed by the language, not by
    // this program's writes: `obj.#m = x` is not assignment syntax a private
    // method admits (its home is the internal, non-configurable
    // [[PrivateMethods]] slot, not a writable property), and no subclass can
    // override it -- a subclass's own `#m` is a wholly separate, unrelated
    // field, never a redeclaration. Nothing in `memberSlotClosed`'s call-site
    // walk or `memberSlotWritesClosed`'s write scan can change that answer,
    // and both ask questions this slot cannot even pose: `memberKeyOf`
    // returns `null` for a private name (it only reads
    // `Identifier`/string/numeric declaration names), which is a "cannot
    // tell" a private method never earns -- the slot was never written in
    // the first place, and the program's own call sites are the only
    // possible callers by construction.
    if (ts.isMethodDeclaration(slot) && ts.isPrivateIdentifier(slot.name)) return true
    // The whole-program proof first: besides its answer it FILES the
    // intrinsic-protocol obligations a closed slot leans on (`Object.keys(
    // owner )` parks a requirement on the key-query protocol), and a slot the
    // syntactic arm settles alone would leave those unfiled.
    if (memberSlotClosed(slot)) return true
    if (!memberSlotWritesClosed(slot)) return false
    const owner = memberOwnerClassOf(slot)
    return owner === null || !familyInstancesEscape(owner)
  }
  /**
   * Every additional body a member slot's writes can install, when every
   * write reaching a family instance is itself a plain `receiver.key =
   * <compiled function>` assignment -- or null the moment one is not.
   * `memberSlotWritesClosed` answers "does nothing write this slot", which is
   * stronger than TARGET IDENTITY needs: a write only opens the slot to an
   * unknown callable when what it installs cannot itself be named. Three's
   * `Object3D.prototype.onBeforeRender` is a per-instance render hook --
   * `WebGLBackground.js` does `boxMesh.onBeforeRender = function( renderer,
   * scene, camera ) { ... }` on a local `Mesh` instance, from OUTSIDE any
   * class body, so `instanceMemberWritesOf` (which only sees `this.x =` /
   * `super.x =`) never learns of it -- so `WebGLRenderer.js`'s
   * `scene.onBeforeRender( ... )` calls through a slot with one such
   * override, itself a compiled function this walk can name. A slot written
   * three times with three compiled functions is exactly as closed as a slot
   * written once.
   *
   * Only a bare assignment is admitted. A compound assignment, delete,
   * destructuring target, computed key, `__proto__`/`prototype` swap or
   * intrinsic mutator (`Object.assign`/`defineProperty`/…) reaching the
   * family refuses the WHOLE slot: none of those states what the write
   * installs closely enough to enumerate, and one unenumerable write means
   * the slot can hold anything.
   */
  const memberSlotWrittenBodiesOf = (declared: ts.Declaration): readonly ts.SignatureDeclaration[] | null => {
    if (!ts.isClassElement(declared)) return null
    const owner = memberOwnerClassOf(declared)
    const key = memberKeyOf(declared)
    if (owner === null || key === null) return null
    // Enumerating the bodies the program's own writes install only answers
    // "what can this slot hold" while every instance carrying it is still one
    // this program holds. An instance handed to code this program cannot name
    // can be given a body that program never wrote, and no write here would
    // show it.
    if (familyInstancesEscape(owner)) return null
    const symbolOf = (node: SourceClass): ts.Symbol | undefined =>
      node.name ? checker.getSymbolAtLocation(node.name) : checker.getTypeAtLocation(node).getSymbol()
    const ownerSymbol = symbolOf(owner)
    if (!ownerSymbol) return null
    const inFamily = (node: SourceClass): boolean => {
      const symbol = symbolOf(node)
      return symbol !== undefined && descendsFrom(checker.getDeclaredTypeOfSymbol(symbol), ownerSymbol)
    }
    const classOfReference = (expression: ts.Expression): SourceClass | null => {
      const symbol = checker.getSymbolAtLocation(expression)
      const declaration = symbol?.valueDeclaration
      return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) ? declaration : null
    }
    // Mirrors `slotWritesClosedUncached`'s own receiver test -- see its
    // comments for why each shape is read the way it is.
    const mayBeFamilyInstance = (receiver: ts.Expression): boolean => {
      const value = unwrapValue(receiver)
      if (value.kind === ts.SyntaxKind.ThisKeyword || value.kind === ts.SyntaxKind.SuperKeyword) {
        const frame = flow.receiverOwnerOf(value)
        const home = frame && ts.isClassElement(frame) ? frame.parent : null
        return home === null || !(ts.isClassDeclaration(home) || ts.isClassExpression(home)) || inFamily(home)
      }
      if (ts.isPropertyAccessExpression(value) && value.name.text === 'prototype') {
        const named = classOfReference(value.expression)
        return named === null || inFamily(named)
      }
      const named = classOfReference(value)
      if (named !== null) return inFamily(named)
      const origins = allocationOriginsOf(value)
      if (origins === null) return true
      for (const allocated of origins.classes) if (inFamily(allocated)) return true
      return false
    }
    const computedKeyMayBe = (argument: ts.Expression): boolean => {
      const type = checker.getTypeAtLocation(argument)
      const arms = type.isUnion() ? type.types : [type]
      return arms.some((arm) => {
        if (arm.flags & ts.TypeFlags.NumberLike) return false
        if (arm.isStringLiteral()) return arm.value === key
        return true
      })
    }
    const inventory = slotWriteInventoryOf(checker, flow)
    // None of these installs a value this walk can enumerate, so any one
    // reaching the family refuses the slot whole -- exactly the bar
    // `slotWritesClosedUncached` holds them to.
    for (const access of inventory.namedWrites.get('__proto__') ?? []) if (mayBeFamilyInstance(access.expression)) return null
    for (const access of inventory.namedWrites.get('prototype') ?? []) {
      const named = classOfReference(unwrapValue(access.expression))
      if (named === null || inFamily(named)) return null
    }
    for (const access of inventory.computedWrites) {
      if (!computedKeyMayBe(access.argumentExpression)) continue
      if (mayBeFamilyInstance(access.expression)) return null
    }
    for (const { call } of inventory.intrinsicMutators) {
      const target = call.arguments[0]
      if (target && mayBeFamilyInstance(target)) return null
    }
    const found = new Set<ts.SignatureDeclaration>()
    for (const access of inventory.namedWrites.get(key) ?? []) {
      if (!mayBeFamilyInstance(access.expression)) continue
      const assignment = access.parent
      if (!ts.isBinaryExpression(assignment) || assignment.left !== access || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return null
      const targets = closedCallableTargetsOf(checker, flow, assignment.right, elementCalleeAuthority)
      if (targets === null) return null
      for (const target of targets) found.add(target)
    }
    return [...found]
  }
  // Shared with every proof NESTED under this one, not per proof instance.
  // `fieldValuesOf` proves a field's holders closed with a nested `field`-mode
  // proof, and that proof's walk asks `constructionDataMemberOf`, whose record
  // plan expands a parameter through `parameterValuesOf` back into a
  // `fieldValuesOf` -- of the nested proof, which held its own empty guard. On
  // `object.matrix.parent = object` (three's `Object3D.parent` back-reference)
  // each level spawned a fresh proof asking the same read and the stack
  // overflowed. A re-ask of a read still being answered is the same cycle
  // whichever proof instance asks it, and it already refused within one.
  let activeFieldReads = activeFieldReadsByFlow.get(flow)
  if (!activeFieldReads) activeFieldReadsByFlow.set(flow, (activeFieldReads = new Set()))
  const callCompletionValuesAt: CallCompletionValuesAt = (call) => {
    // `options = Object.assign( { ...defaults }, options )` in three's
    // `RenderTarget`: the intact intrinsic returns its target. The graph
    // models the same call (`bulkAssignOf`); this is the legacy resolver's
    // reading of it, and it goes when `parameterValuesOf` does.
    if (
      isGlobalObjectAssign(checker, call) &&
      call.arguments.length > 0 &&
      !call.arguments.some(ts.isSpreadElement) &&
      deferredIntrinsicProtocolLedgerOf(flow)?.requireMember('Object', 'assign', call) === true
    )
      return [call.arguments[0]!]
    // A native Map/WeakMap `.get()` is not a source invocation -- there is no
    // user-declared signature for `invocationFactOf` to dispatch through --
    // but its stored values are still a closed, provable set once the map's
    // whole history is closed. The container walk (`callOrigins`, below) already
    // leans on `collectionStoredValuesOf` for this identical question; the
    // exact-origin graph asked its every OTHER leaf (`fieldValuesOf`,
    // `parameterValuesOf`, `thisFamilyOf`) but never a call, so a value
    // round-tripped through a WeakMap -- three's `WebGLEnvironments`
    // `cubeMaps.get( texture )`, holding the very `WebGLCubeRenderTarget`
    // `getCube` just allocated -- had no exact origin, and every method later
    // called on it (`cubemap.dispose()` in the map's own dispose listener)
    // refused as `targets:origin-slot-open`.
    const stored = collectionStoredValuesOf(checker, flow, call, nativeProtocolClosed)
    if (stored !== null) return stored
    const fact = invocationFactOf(call)
    return fact === null ? null : invocationCompletionValuesOf(fact)
  }
  const bindingValuesOf = (declaration: ts.VariableDeclaration): readonly ts.Expression[] | null =>
    localBindingValuesOf(flow, declaration, (source) => (arrayProtocolClosedAt(source) ? arrayContentsOf(source) : null))
  const allocationAuthority: ClassAllocationAuthority = {
    parameterValuesOf,
    thisFamilyOf: thisFamilyAt,
    fieldValuesOf: (expression) => fieldValuesOf(expression),
    bindingValuesOf,
    graphValuesOf: (reference) => {
      const values = sourceValueSessionOf(checker, flow).valuesOf(reference)
      return values !== null && values.every(ts.isExpression) ? values : null
    },
    callCompletionValuesOf: callCompletionValuesAt,
    whenSettled: computedKeyAuthority.whenSettled,
    sharedAnswerOf
  }
  const allocationOriginsOf = (expression: ts.Expression): ExactClassAllocationOrigins | null =>
    exactClassAllocationOriginsOf(checker, flow, expression, allocationAuthority)
  const fieldValuesOf = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly ts.Expression[] | null => {
    const traceField = (reason: string): null => {
      const watched = process.env['GEA_FIELD_ORIGIN_DEBUG']
      if (watched !== undefined && (watched === '*' || access.getText().includes(watched))) {
        const file = access.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(access.getStart()).line + 1
        console.error(`[FIELD-ORIGIN] ${file.fileName}:${line} ${access.getText().slice(0, 100)} ${reason}`)
      }
      return null
    }
    if (activeFieldReads.has(access)) {
      // A refusal on the strength of a read still being answered is a park
      // like any other: an answer that leaned on it is reusable only while
      // that read is still active.
      noteAssumption(access)
      return traceField('recursive-read')
    }
    activeFieldReads.add(access)
    try {
      const ledger = deferredIntrinsicProtocolLedgerOf(flow)
      fieldStats.asks++
      // Probed BEFORE the value graph and the allocation-origin walk, not
      // after them. Keyed by the access node, because that is what the walk
      // is a function of once `receiverTypeAt` and `argumentsUsesAt` are
      // fixed -- the two WeakMap levels above already hold those.
      //
      // Placed after the origin walk (where it used to sit) the memo answered
      // 6 questions in 400,000 proof entries: nearly every call refuses at
      // `allocation-origins-open` or is answered by the value graph, both
      // BEFORE the old probe, so the expensive part was never memoized. Worse,
      // this read is parked for the whole walk, so every proof the walk runs
      // underneath stamps its answer with `access` as an assumption -- 306,255
      // of the 312,333 answers stored in that same window. Those answers are
      // only reusable while this exact read is in flight again, so the proof
      // memo held essentially nothing and re-proved the same 68 members
      // hundreds of thousands of times. Memoizing the read itself is what
      // stops the walk from running again at all.
      let byReceiverTypeAt = fieldAnswers.get(flow)
      if (!byReceiverTypeAt) fieldAnswers.set(flow, (byReceiverTypeAt = new WeakMap()))
      let byArgumentsUsesAt = byReceiverTypeAt.get(receiverTypeAt)
      if (!byArgumentsUsesAt) byReceiverTypeAt.set(receiverTypeAt, (byArgumentsUsesAt = new WeakMap()))
      let byAccess = byArgumentsUsesAt.get(argumentsUsesAt)
      if (!byAccess) byArgumentsUsesAt.set(argumentsUsesAt, (byAccess = new WeakMap()))
      let answers = byAccess.get(access)
      if (!answers) byAccess.set(access, (answers = []))
      for (const answer of answers) {
        let applies = true
        for (const assumedKey of answer.assumed)
          if (!parked(assumedKey)) {
            applies = false
            break
          }
        if (!applies) continue
        fieldStats.hits++
        for (const assumedKey of answer.assumed) noteAssumption(assumedKey)
        for (const escapedKey of answer.escaped) noteAssumption(escapedKey)
        for (const [reference, kind] of answer.opens) onOpenUse(reference, kind)
        if (answer.values !== null && ledger) ledger.include(answer.requirements)
        return answer.values ?? traceField('shared-refusal')
      }
      const trail = pushHypothesisTrail()
      const opens = new Map<ts.Expression, Set<OpenUseKind>>()
      const outerSink = openSink
      openSink = (reference, kind) => {
        let kinds = opens.get(reference)
        if (!kinds) opens.set(reference, (kinds = new Set()))
        if (kinds.has(kind)) return
        kinds.add(kind)
        outerSink?.(reference, kind)
      }
      let computed: { readonly value: readonly ts.Expression[] | null; readonly requirements: readonly IntrinsicProtocolRequirement[] }
      try {
        const compute = (): readonly ts.Expression[] | null => readFieldValues(access)
        computed = ledger ? ledger.capture(compute) : { value: compute(), requirements: [] }
      } finally {
        popHypothesisTrail()
        openSink = outerSink
      }
      const assumed = new Set<object>()
      // Passed outward whether this frame can ground it or not: see
      // `sharedAnswerOf`. `parked` here is a superset of any enclosing
      // frame's, so no enclosing positive answer's scope changes.
      const escaped = new Set<object>()
      for (const key of trail) {
        if (parked(key)) assumed.add(key)
        else escaped.add(key)
        noteAssumption(key)
      }
      const recorded: (readonly [ts.Expression, OpenUseKind])[] = []
      for (const [reference, kinds] of opens) for (const kind of kinds) recorded.push([reference, kind])
      fieldStats.stores++
      answers.push({ assumed, escaped, values: computed.value, requirements: computed.requirements, opens: recorded })
      if (computed.value !== null && ledger) ledger.include(computed.requirements)
      return computed.value
    } finally {
      activeFieldReads.delete(access)
    }
  }
  /** Everything the memo above covers: the array-index shortcut, the value
   * graph, and the allocation-origin walk. */
  const readFieldValues = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): readonly ts.Expression[] | null => {
    const traceField = (reason: string): null => {
      const watched = process.env['GEA_FIELD_ORIGIN_DEBUG']
      if (watched !== undefined && (watched === '*' || access.getText().includes(watched))) {
        const file = access.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(access.getStart()).line + 1
        console.error(`[FIELD-ORIGIN] ${file.fileName}:${line} ${access.getText().slice(0, 100)} ${reason}`)
      }
      return null
    }
    {
      if (ts.isElementAccessExpression(access) && numericArrayIndex(access.argumentExpression) && arrayValued(access.expression))
        return arrayContentsOf(access.expression)
      const key = accessKeyOf(access)
      if (key === null) return traceField('key-unknown')
      if (key === 'constructor' || key === '__proto__') return traceField(`key-forbidden:${key}`)
      // The joint value/storage graph resolves a slot together with every
      // write that fills or replaces it, over literals as well as instances:
      // `holder.buffers.color` in a record literal holds `new Child()`, which
      // the class-instance walk below cannot see at all -- it starts from the
      // holder's CLASS origins, and a literal has none. Its answer is the
      // slot's value set wherever it is complete; only a refusal falls through
      // to the walk, and only until the walk is gone (SEMANTIC-AUTHORITY §2).
      const graphed = sourceValueSessionOf(checker, flow).valuesOf(access)
      if (graphed !== null && graphed.every(ts.isExpression)) return graphed
      const origins = allocationOriginsOf(access.expression)
      if (!origins) return traceField('allocation-origins-open')
      return fieldValuesWalk(access, key, origins)
    }
  }
  /** The class-instance walk behind `fieldValuesOf`, shared through `fieldAnswers`. */
  const fieldValuesWalk = (
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    key: string,
    origins: ExactClassAllocationOrigins
  ): readonly ts.Expression[] | null => {
    const traceField = (reason: string): null => {
      const watched = process.env['GEA_FIELD_ORIGIN_DEBUG']
      if (watched !== undefined && (watched === '*' || access.getText().includes(watched))) {
        const file = access.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(access.getStart()).line + 1
        console.error(`[FIELD-ORIGIN] ${file.fileName}:${line} ${access.getText().slice(0, 100)} ${reason}`)
      }
      return null
    }
    {
      const inventory = ownedClassReceiverInventoryOf(checker, flow, origins.classes)
      if (!inventory) return traceField('receiver-inventory-open')
      const declarations = new Set<ts.Declaration>()
      for (const owner of origins.classes) {
        const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
        if (!symbol) return traceField('owner-symbol-missing')
        const plan = sourceClassDataMemberPlanOf(
          checker,
          flow,
          { kind: 'declared', receiver: checker.getDeclaredTypeOfSymbol(symbol) },
          key
        )
        if (!plan) return traceField(`member-plan-missing:${owner.name?.text ?? '(anonymous)'}.${key}`)
        for (const declaration of plan.declarations) declarations.add(declaration)
      }
      const values = new Set<ts.Expression>()
      const admit = (write: ValueWrite): boolean => {
        if (write.edge === 'return' || write.edge === 'yield') return true
        if (write.value === null || !['class-field-initializer', 'property-assignment', 'index-assignment'].includes(write.edge))
          return false
        values.add(write.value)
        return true
      }
      for (const declaration of declarations) {
        if (ts.isParameterPropertyDeclaration(declaration, declaration.parent)) {
          const incoming = parameterValuesOf(declaration)
          if (!incoming) return traceField('parameter-property-frame-open')
          for (const value of incoming) values.add(value)
          const stores = flow
            .writesToDeclaration(declaration)
            .filter((write) => write.edge === 'property-assignment' || write.edge === 'index-assignment' || write.edge === 'delete')
          if (!stores.every(admit)) return traceField('parameter-property-store-open')
        } else if (!flow.writesToDeclaration(declaration).every(admit)) return traceField('member-store-open')
      }
      const terminalUse = (reference: ts.Expression): boolean | null => {
        const selected = reference.parent
        if ((!ts.isPropertyAccessExpression(selected) && !ts.isElementAccessExpression(selected)) || selected.expression !== reference)
          return null
        const assignment = selected.parent
        if (accessKeyOf(selected) !== key || !ts.isBinaryExpression(assignment) || assignment.left !== selected) return null
        if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
        // An erased alias can name no field symbol. The closed receiver walk
        // still reaches its store; retain that indexed write's value too.
        const writes = flow.writesAtSite(assignment).filter((write) => write.value === assignment.right)
        return writes.length > 0 && writes.every(admit) && constructionDataMember(selected)
      }
      const roots = [...inventory.constructionFacts.map(({ call }) => call), ...inventory.initializers.flatMap((entry) => entry.references)]
      const closed =
        roots.length > 0 &&
        hasClosedMemberCallableUses(
          checker,
          flow,
          null,
          new Set(),
          receiverTypeAt,
          argumentsUsesAt,
          onOpenUse,
          nestedMembers,
          nestedFamilies(),
          { roots, terminalUse, field: { owners: origins.classes, key } }
        )
      if (!closed) return traceField('field-receiver-closure-open')
      if (values.size === 0) return traceField('field-values-empty')
      return [...values]
    }
  }
  /**
   * Whether every object `receiver` can denote at run time takes its `declared`
   * slot from `declared`'s own class family -- so the bodies that family names
   * are the ones a call through the slot enters.
   *
   * The checker's receiver type is not that proof. JavaScript binds a JSDoc
   * `@param {A} receiver` to whatever the caller passes: a literal `{ m( x ) {
   * sink( x ) } }`, an instance of `function F() {}` whose `F.prototype.m` was
   * written by hand or inherited through `Object.create( A.prototype )`, an
   * object handed to `Object.setPrototypeOf`. Each of those names `A.m` to the
   * checker and runs its own function. So the receiver is taken only where its
   * allocations are exact source-class constructions of the family (which
   * also proves no family constructor or prototype leaves the program), or it
   * is the `this` of a family class's constructor, field initializer or
   * closed method.
   */
  const receiverInFamily = (receiver: ts.Expression, declared: ts.Declaration): boolean => {
    // WHICH of the seven sub-checks refused. `GEA_RECEIVER_DEBUG` reports this
    // whole question as one word (`member-call-argument:receiver-outside
    // -family`), and that word is true of a receiver whose allocations cannot
    // be enumerated, one whose `this` frame is static, and one whose own slot
    // is open alike -- three different fixes. The three.js app's `scene.add( sun )`
    // refused here and there was no way to say which.
    const familyTraced = (reason: string, detail?: () => string): false => {
      if (watchedReceiverFamily !== undefined) {
        const file = receiver.getSourceFile()
        const line = file.getLineAndCharacterOfPosition(receiver.getStart()).line + 1
        const name = file.fileName.split('/').pop() ?? ''
        if (watchedReceiverFamily === '*' || watchedReceiverFamily === name || watchedReceiverFamily === `${name}#${line}`)
          console.error(`[RECEIVER-FAMILY] ${name}#${line} ${receiver.getText().slice(0, 40)} ${reason}${detail ? ` ${detail()}` : ''}`)
      }
      // `GEA_LEAF_DEBUG='*'` also watches this arm -- it used to be visible
      // only through the separate `GEA_RECEIVER_FAMILY_DEBUG`, so a `'*'` leaf
      // run never saw a `receiverInFamily` refusal at all, however many of the
      // proof's other leaves it was the actual cause of.
      if (watchedLeafDebug === '*') {
        const file = receiver.getSourceFile()
        const name = file.fileName.split('/').pop() ?? file.fileName
        const line = file.getLineAndCharacterOfPosition(receiver.getStart()).line + 1
        const owner = member?.declarations?.[0]?.parent
        const owning = owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) ? (owner.name?.text ?? '(anonymous)') : '-'
        recordLeafSummary(`family:${reason}`, `${owning}.${member?.getName() ?? '-'}`, `${name}#${line}`)
      }
      return false
    }
    const owner = memberOwnerClassOf(declared)
    if (owner === null) return familyTraced('member-has-no-owner-class')
    const symbolOf = (node: SourceClass): ts.Symbol | undefined =>
      node.name ? checker.getSymbolAtLocation(node.name) : checker.getTypeAtLocation(node).getSymbol()
    const ownerSymbol = symbolOf(owner)
    if (!ownerSymbol) return familyTraced('owner-class-has-no-symbol')
    const inFamily = (node: SourceClass): boolean => {
      const symbol = symbolOf(node)
      return symbol !== undefined && descendsFrom(checker.getDeclaredTypeOfSymbol(symbol), ownerSymbol)
    }
    const value = unwrapValue(receiver)
    // `super.copy( source )` names the SAME OBJECT as `this` -- `super` only
    // changes which declaration the call dispatches to, never the receiver --
    // so the frame question below answers it exactly. Sending it to
    // `exactClassAllocationOriginsOf` instead asked "which classes can this
    // expression denote" of a keyword that denotes no cell, and every
    // `super.copy` in three's Texture/RenderTarget/DepthTexture chain refused
    // as `allocations-not-enumerable`.
    if (value.kind !== ts.SyntaxKind.ThisKeyword && value.kind !== ts.SyntaxKind.SuperKeyword) {
      // A receiver that arrived as a parameter is answered by THIS proof's
      // frame query, not by the module-level parameter census: enumerating a
      // method's callers means proving its slot closed, and that is the
      // question this proof is already inside, with this proof's counted
      // calls. Without it `Renderer.render( object )` handing `object` to
      // `object.onBeforeRender( this )` left the renderer unplaceable, which
      // is the `object-to-dynamic-conversion` behind three's whole
      // `onBeforeRender` family.
      const origins = allocationOriginsOf(value)
      if (origins === null) {
        // `new this.constructor( ... )` -- three's universal `clone()`, and the
        // receiver of 150 refusals off `Texture.clone` alone -- names a
        // COMPUTED callee, and `exactClassAllocationOriginsOf` resolves only
        // identifiers and namespace members. It is not missing a branch: it is
        // asked standalone, with no candidate family to check `this` against,
        // and deriving one there would re-implement this proof from the wrong
        // layer. This proof already has the candidate -- `owner` -- and already
        // owns the fact that settles it, in `ownConstructorClassOf`: in an
        // instance member of `C` whose callers are closed and never supply an
        // explicit receiver, and whose `constructor` slot nothing writes, the
        // allocation is `C`'s own family.
        const own = ts.isNewExpression(value) ? ownConstructorClassOf(value) : null
        if (own !== null)
          return (
            inFamily(own) ||
            familyTraced(
              'own-constructor-outside-family',
              () => `owner=${owner.name?.text ?? '(anonymous)'} own=${own.name?.text ?? '(anonymous)'}`
            )
          )
        // ⛔ UNSOUND MEASUREMENT ARM (`GEA_RECEIVER_FAMILY_FORCE=1`): prices what
        // this one refusal alone is holding open. Never set it for a kept build.
        if (process.env['GEA_RECEIVER_FAMILY_FORCE'] === undefined)
          return familyTraced('allocations-not-enumerable', () => `owner=${owner.name?.text ?? '(anonymous)'}`)
        return true
      }
      if (![...origins.classes].every(inFamily))
        return familyTraced(
          'allocation-outside-family',
          () =>
            `owner=${owner.name?.text ?? '(anonymous)'} classes=${[...origins.classes].map((entry) => entry.name?.text ?? '(anonymous)').join(',')}`
        )
      return true
    }
    // An arrow function keeps the enclosing `this`; any other function binds
    // its own, which only its callers decide.
    const frame = flow.receiverOwnerOf(value)
    // A constructor function's body IS its constructor, so its `this` is the
    // instance under construction and the function itself is the holder. There
    // is no enclosing class member to be, and no static modifier to carry.
    const ownFrame = frame !== null && isConstructorFunction(frame)
    if (
      !ownFrame &&
      (!frame || (!ts.isConstructorDeclaration(frame) && !ts.isMethodDeclaration(frame) && !ts.isPropertyDeclaration(frame)))
    )
      return familyTraced('this-frame-is-not-a-class-member', () => `frame=${frame ? ts.SyntaxKind[frame.kind] : 'none'}`)
    if (!frame) return familyTraced('this-frame-is-not-a-class-member', () => 'frame=none')
    if (!ownFrame && (ts.getCombinedModifierFlags(frame) & ts.ModifierFlags.Static) !== 0) return familyTraced('this-frame-is-static')
    const holder = ownFrame ? frame : frame.parent
    if (!ts.isClassDeclaration(holder) && !ts.isClassExpression(holder) && !isConstructorFunction(holder))
      return familyTraced('this-frame-has-no-class-holder')
    if (!inFamily(holder)) return familyTraced('this-holder-outside-family', () => `holder=${holder.name?.text ?? '(anonymous)'}`)
    // A method's `this` is whatever its callers pass: `A.prototype.m.call(
    // fake )` and `const f = a.m; f.call( fake )` are both mentions its own
    // slot proof must have counted.
    if (ts.isMethodDeclaration(frame) && !memberSlotClosed(frame)) return familyTraced('this-frame-slot-open')
    if (ownedClassReceiverInventoryOf(checker, flow, new Set([holder])) === null) return familyTraced('holder-inventory-open')
    return true
  }
  const methodReceiverUses = (declaration: ts.Declaration, use: (expression: ts.Expression) => boolean): boolean => {
    const implementations = memberImplementationsOf(declaration)
    // Only the implicit receiver is being followed here. The arguments
    // object contains ordinary arguments, whose publication paths are
    // checked separately when they carry this receiver.
    return (
      implementations !== null &&
      implementations.length > 0 &&
      implementations.every((body) => flow.receiverReferencesToDeclaration(body).every(use))
    )
  }
  const siblingReadClosed = (
    declaration: ts.Declaration,
    constructedData: () => boolean,
    use: (expression: ts.Expression) => boolean
  ): boolean => {
    if (!dataDeclaration(declaration)) return ts.isMethodDeclaration(declaration) && methodReceiverUses(declaration, use)
    if (ts.isBinaryExpression(declaration) && !constructedData()) return false
    // Any alias placing the carried value in a sibling has its own source
    // publication edge. Capturing callable initializers retain receiver uses.
    const value = ts.isPropertyAssignment(declaration)
      ? declaration.initializer
      : ts.isPropertyDeclaration(declaration)
        ? declaration.initializer
        : undefined
    return (
      !value || (!ts.isFunctionExpression(value) && !ts.isArrowFunction(value)) || flow.receiverReferencesToDeclaration(value).every(use)
    )
  }
  const nativeProtocolClosed = (plan: NativeCollectionProtocolPlan): boolean =>
    plan.deferred
      ? deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys(plan.intrinsic, plan.prototypeKeys, plan.location) === true
      : hasClosedValueUses(checker, flow, plan.roots, plan.terminalUse, receiverTypeAt, argumentsUsesAt)
  const dataDefinitionUse = (
    reference: ts.Expression,
    use: (value: ts.Expression) => boolean,
    path: MemberPath | null = null
  ): boolean | null => {
    const plan = intrinsicDataDefinitionTargetOf(checker, reference, (declaration, argument) =>
      flow.referencesToDeclaration(declaration).every((mention) => mention === declaration.name || mention === argument)
    )
    if (!plan) return null
    // A proof following no slot, path or field asks only whether the receiver
    // itself gets out. A data definition stores INTO it -- the same effect as
    // `this.<key> = value` -- and hands it to nothing, so what it installs is
    // the only question: a primitive can neither be a method the proof would
    // have to follow nor hold the receiver back. Three's `Material` defines
    // `id` this way in its constructor, and refusing it here left every
    // receiver-family proof over a material open.
    const refuse = (why: string): false => {
      traceReceiver(reference, 'data-definition', false, () => `keys=${plan.keys.join(',')} ${why}`)
      return false
    }
    if (!member && !path && !valueMode?.field && !plan.values.every((value) => primitive(checker.getTypeAtLocation(value))))
      return refuse('non-primitive-value')
    if (valueMode?.field && plan.keys.includes(valueMode.field.key)) return refuse('defines-field')
    if (member && plan.keys.includes(member.getName())) return refuse('defines-member')
    // A definition installs the named keys and nothing else. The followed
    // value is reached from this container through the path's heads: a hop
    // that names one of those keys, an element hop, or a hop named only by
    // its declaration (any key at runtime) could be what the definition
    // overwrites. Every other named hop is a slot the definition never
    // touches. A SUMMARY path lists several heads -- `.renderTarget,
    // .textures,[],.renderTarget` reaching a render target's textures from a
    // texture in three -- and reading it as "kind is not property" refused
    // `Object.defineProperty(this, 'id', ...)` in `Texture`'s constructor
    // for a definition of `id` that no head of the path names.
    // (`siblingKeyed` is that comparison: an element hop only collides with a
    // canonical index, a declaration-only hop with any key.)
    if (path && !plan.keys.every((key) => siblingKeyed(path, key) && !headsOf(path).includes(`.${key}`))) return refuse('defines-a-head')
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    if (ledger?.requireMember(plan.owner, plan.member, plan.call) !== true) return refuse('protocol-member-open')
    if (
      plan.descriptorPrototypeKeys.length > 0 &&
      !ledger.requirePrototypeKeys('Object', { names: plan.descriptorPrototypeKeys }, plan.call)
    )
      return refuse('descriptor-prototype-open')
    return !plan.returnsTarget || ts.isExpressionStatement(plan.call.parent) || use(plan.call) || refuse('result-use-open')
  }
  const ownKeyQueryUse = (call: ts.CallExpression, reference: ts.Expression): boolean => {
    if (call.arguments.length !== 1 || call.arguments[0] !== reference || ts.isSpreadElement(reference)) return false
    const plan = intrinsicOwnKeyQueryOf(checker, unwrapValue(call.expression))
    return plan !== null && deferredIntrinsicProtocolLedgerOf(flow)?.requireMember(plan.owner, plan.member, call) === true
  }
  /**
   * `callableArrayTargetsOf`'s own array-identity walk (`callable-array-
   * origins.ts`) only traces an array literal through cells, conditionals,
   * `.slice()` copies and `collectionValuesOf`-backed native-map reads -- it
   * has no case at all for a plain object used as a string-keyed RECORD of
   * arrays (`this._listeners[ type ]`, three's `EventDispatcher`), because
   * that identity question is answered by a different, already-general
   * mechanism: `arrayStoredValuesOf` (`array-element-continuation.ts`),
   * which `computedKeyAuthority`/`arrayContentsOf` above already ask for
   * every OTHER array-element read this proof closes (`callbackParameterValuesOf`).
   * Falling back to it here -- only once the narrower walk finds nothing, so
   * nothing that already closed can change -- resolves each stored value's
   * own callable identity through `closedCallableTargetsOf` (the general
   * "every function body this expression denotes" proof, not array-specific)
   * against this SAME authority, so a listener array whose elements are
   * conditionals, parameters or aliased cells still closes exactly as a
   * plain function reference does.
   *
   * MEASURED DEAD END (2026-09-16): the obvious next shape -- a callable at a
   * FIXED tuple slot, `for (const entry of list) entry[0]( out )`, which is
   * how hono's `RegExpRouter` dispatches every route -- cannot be closed from
   * here. A fixed index needs one slot plus the proof that nothing else ever
   * wrote it, and the only enumeration of writes available at this layer is
   * `arrayStoredValuesOf`, which is CIRCULAR for exactly this shape: it
   * refuses the array whose element read is used as a callee, because that
   * use is the one being proven. It refused the minimal case --
   * `const pair: [Handler, number] = [ fn, 0 ]; pair[0]( 'hi' )` -- with no
   * for-of and no record nesting, so neither iteration nor nesting is the
   * gap. Closing it needs a use-walk of its own, beside
   * `callableArrayTargetsOf` in `callable-array-origins.ts`, that admits an
   * element-slot callee the way that walk's own `use`/`callableUse` already
   * admits `array[ i ]( ... )`. A version built without one landed zero
   * closed callees on `hono-hello` and was reverted.
   */
  const arrayElementTargetsViaRecordOf = (
    element: ts.ElementAccessExpression
  ): readonly (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction)[] | null => {
    if (!numericArrayIndex(element.argumentExpression)) return null
    const values = arrayContentsOf(element.expression)
    if (values === null) return null
    const targets = new Set<ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction>()
    for (const value of values) {
      const resolved = closedCallableTargetsOf(checker, flow, value, elementCalleeAuthority)
      if (resolved === null) return null
      for (const body of resolved) targets.add(body)
    }
    return targets.size > 0 ? [...targets] : null
  }
  /** What `callableArrayTargetsOf` needs to name every function an array element callee can be. */
  const elementCalleeAuthority: Parameters<typeof callableArrayTargetsOf>[3] = {
    arrayElementTargetsOf: (element) =>
      callableArrayTargetsOf(checker, flow, element, elementCalleeAuthority) ?? arrayElementTargetsViaRecordOf(element),
    explicitInvocationIsIntact,
    collectionValuesOf: (read) => collectionStoredValuesOf(checker, flow, read, nativeProtocolClosed),
    collectionReadsOf: (store, value) => collectionValueContinuationsOf(checker, flow, store, value, nativeProtocolClosed),
    parameterValuesOf,
    closedCallerSitesOf,
    arrayProtocolClosed: (array) => {
      const plan = nativeArrayProtocolPlanOf(checker, flow, array)
      return plan !== null && nativeProtocolClosed(plan)
    }
  }
  const forwardedInvocationUse = (
    reference: ts.Expression,
    call: ts.CallExpression | ts.NewExpression,
    use: (expression: ts.Expression) => boolean,
    path: MemberPath | null = null
  ): boolean => {
    const site = callsOf(flow).sites.get(call)
    if (!site) return false
    const callee = site.operands.callee
    // A member lookup on a nullish receiver throws or short-circuits before
    // evaluating its arguments. This is operand evaluation, not target inference.
    if (
      site.operands.args.includes(reference) &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      nullishOnly(callee.expression)
    )
      return true
    if (ts.isCallExpression(call) && call.expression.kind !== ts.SyntaxKind.SuperKeyword) {
      const fact = invocationFactOf(call)
      const continuations = fact && invocationValueContinuationsOf(fact, reference)
      return (
        continuations !== null &&
        continuations.every(({ expression, projection }) =>
          projection === 'value'
            ? use(expression)
            : (ts.isParameter(expression.parent) && expression.parent.name === expression) ||
              containerUse(expression, extendPath(ELEMENT_HOP, path))
        )
      )
    }
    const argument = site.operands.args.indexOf(reference)
    if (argument < 0) return false
    // `new WebGLTextures( state )` on a plain source function: `new` binds the
    // arguments to the function's own formals exactly as a call does. What
    // becomes of the fresh `this` is not this argument's question: a factory
    // discards it behind an object completion (`constructionYieldsCompletionOf`),
    // and a pre-class constructor (`isConstructorFunction`: writes `this.x`,
    // returns nothing but `this`) hands it to the `new` site, where it is the
    // allocation whose own receiver references are walked as that function's
    // `this`. Either way the argument reaches only the formal. The
    // class-constructor authority below refuses a constructor function by
    // design -- its body is no `ConstructorDeclaration` -- so three's factory
    // shims were an open escape at every `new` that handed them a record, and
    // so were its `this`-writing renderer modules: `new WebGLTextures( _gl,
    // extensions, state, properties, capabilities, utils, info )` and `new
    // WebGLShadowMap( _this, objects, capabilities )` were 746 of the three.js app's
    // leaf refusals, every one an `objects`/`extensions`/`state` argument.
    const factory = constructorFunctionCalleeOf(call)
    if (factory !== null) {
      const parameter = factory.parameters[argument]
      return parameter === undefined || flow.referencesToDeclaration(parameter).every(use)
    }
    const targets = closedConstructorForwardingTargetsOf(checker, flow, call, argumentsUsesAt)
    return (
      targets !== null &&
      targets.every((target) => {
        const parameter = target.parameters[argument]
        // A body without this ordinary slot ignores the extra argument;
        // implicit arguments and rest frames were excluded by the authority.
        return parameter === undefined || flow.referencesToDeclaration(parameter).every(use)
      })
    )
  }
  /**
   * The plain source function `new F( ... )` runs, when its formals are the
   * only way in: an identifier callee naming an unwritten, non-generator,
   * non-async function declaration with no rest slot and no `arguments`
   * read, that either completes with an object every time or is a
   * pre-class constructor building `this`.
   */
  const constructorFunctionCalleeOf = (call: ts.CallExpression | ts.NewExpression): ts.FunctionDeclaration | null => {
    if (!ts.isNewExpression(call) || call.arguments?.some(ts.isSpreadElement)) return null
    const callee = unwrapValue(call.expression)
    if (!ts.isIdentifier(callee)) return null
    const named = flow.targetOf(callee)
    const target =
      named?.symbol && (named.symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? resolveFlowSymbolAlias(checker, named.symbol)?.valueDeclaration
        : named?.declaration
    if (!target || !ts.isFunctionDeclaration(target) || !target.body || target.getSourceFile().isDeclarationFile) return null
    if (target.asteriskToken || target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null
    if (target.parameters.some((parameter) => parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))) return null
    if ((argumentsUsesAt(target)?.length ?? 0) > 0) return null
    const rebound = flow
      .writesToDeclaration(target)
      .some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
    if (rebound || (!constructionYieldsCompletionOf(flow, target) && !isConstructorFunction(target))) return null
    return target
  }
  /** Parentheses, `!` and type assertions evaluate to the object the expression inside them does. */
  const unwrapValue = unwrapValueExpression
  /** `null`, `undefined` and `void e`: values that hold nothing and whose member accesses throw. */
  const nullishValue = (value: ts.Expression): boolean =>
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    (ts.isIdentifier(value) &&
      value.text === 'undefined' &&
      (checker.getSymbolAtLocation(value)?.declarations ?? []).every((entry) => entry.getSourceFile().hasNoDefaultLib))
  /**
   * Whether every value `expression` can ever hold is nullish. Three's
   * renderer keeps `let _nodesHandler = null` and assigns it only in
   * `setNodesHandler( nodesHandler )`; where nothing calls that setter,
   * `_nodesHandler.renderStart( scene, camera )` is on a receiver that throws
   * before either argument is evaluated. Only a binding whose every write is
   * a spelled value answers: one plain `let`/`var`/`const` statement
   * declaration, or a parameter with a closed frame. A for-of, catch,
   * destructured or redeclared `var` binding receives values no write names.
   */
  const nullishOnly = (expression: ts.Expression, active: Set<ts.Node> = new Set()): boolean => {
    const value = unwrapValue(expression)
    if (nullishValue(value)) return true
    if (ts.isConditionalExpression(value)) return nullishOnly(value.whenTrue, active) && nullishOnly(value.whenFalse, active)
    if (!ts.isIdentifier(value)) return false
    const target = flow.targetOf(value)
    const declaration = target?.declaration
    if (!declaration || active.has(declaration) || target.symbol?.declarations?.length !== 1) return false
    active.add(declaration)
    try {
      if (ts.isParameter(declaration)) {
        const values = ts.isIdentifier(declaration.name) && !declaration.dotDotDotToken ? parameterValuesOf(declaration) : null
        return values !== null && values.every((held) => nullishOnly(held, active))
      }
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
      if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent)) return false
      if (!localBindingWritesAreComplete(flow, declaration)) return false
      if (isModuleExportedDeclaration(checker, declaration, target.symbol ?? null)) return false
      return flow
        .writesToDeclaration(declaration)
        .filter((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
        .every(
          (write) =>
            !!write.value &&
            (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment') &&
            nullishOnly(write.value, active)
        )
    } finally {
      active.delete(declaration)
    }
  }
  const propertyHop = (member: ts.Declaration | null, key: string | null, owesStores = false): Hop => ({
    kind: 'property',
    member,
    key,
    owesStores
  })
  /** An array or object literal written where a value is ASSIGNED TO rather than read (`[ a, b ] = pair`). */
  const destructuringTarget = (literal: ts.Expression): boolean => {
    let node: ts.Node = literal
    while (
      ts.isArrayLiteralExpression(node.parent) ||
      ts.isObjectLiteralExpression(node.parent) ||
      ts.isSpreadElement(node.parent) ||
      ts.isSpreadAssignment(node.parent) ||
      ts.isParenthesizedExpression(node.parent) ||
      ts.isShorthandPropertyAssignment(node.parent) ||
      (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node)
    )
      node = node.parent
    const parent = node.parent
    return (
      (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node)
    )
  }
  const publishedValue = (reference: ts.Expression, tail: MemberPath | null): boolean | null => {
    const parent = reference.parent
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === reference) {
      return containerUse(parent.parent, extendPath(propertyHop(parent, publicationKeyOf(parent.name)), tail))
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === reference) {
      if ((ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Static) !== 0) return false
      const owner = parent.parent
      if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return false
      return classInstancesUse(owner, extendPath(propertyHop(parent, publicationKeyOf(parent.name)), tail))
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === reference) {
      if (isObjectLiteralPrototypeSetter(parent)) return false
      return containerUse(parent.parent, extendPath(propertyHop(parent, publicationKeyOf(parent.name)), tail))
    }
    // `lists.set( scene, [ list ] )`: the literal is a fresh array holding the
    // value one element deep, and walking forward from the literal reaches
    // every alias the array will ever have.
    if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(reference)) {
      if (destructuringTarget(parent)) return false
      return containerUse(parent, extendPath(ELEMENT_HOP, tail))
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === reference &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left))
    ) {
      const left = parent.left
      const flows = (): boolean => ts.isExpressionStatement(parent.parent) || onward(parent, tail)
      // `renderItems[ renderItemsIndex ] = renderItem` puts the value one
      // element deep inside `renderItems`. An index names no member
      // declaration, so the member arm below has nothing to key on; the
      // array's own element slot does.
      if (ts.isElementAccessExpression(left) && numericArrayIndex(left.argumentExpression))
        return (
          (arrayProtocolClosedAt(left.expression) ||
            traceReceiver(reference, 'published-store', false, () => 'element array-protocol-open')) &&
          (publishInto(left.expression, extendPath(ELEMENT_HOP, tail)) ||
            traceReceiver(reference, 'published-store', false, () => 'element owner-open')) &&
          flows()
        )
      // The store must land in a DATA slot on every object the receiver can
      // be: a setter would run with the value as its argument, somewhere no
      // path follows.
      //
      // NAME both halves. This is the ONE authority both walks ask about a
      // store into `<expr>.<key>` -- `receiverUseBody` and `containerUseBody`
      // each consult `publishedValue` before their own assignment arms -- and
      // it is where three's whole scene graph stops: `this.camera = camera`
      // (LightShadow), `object.parent = this` (Object3D.add), `this.textures[
      // i ].renderTarget = this` (RenderTarget). Both of its refusals were a
      // bare `false`, so every instrument showed a chain that ended for no
      // stated cause, and two separate investigations misattributed the
      // terminal to the `isIdentifier` guard in the caller's own arm below --
      // which this branch preempts and which therefore never runs.
      if (!constructionDataMember(left))
        return traceReceiver(reference, 'published-store', false, () => `key=${accessKeyOf(left)} not-a-data-member`)
      return (
        (publishInto(left.expression, extendPath(propertyHop(fieldDeclaration(left), accessKeyOf(left)), tail)) ||
          traceReceiver(reference, 'published-store', false, () => `key=${accessKeyOf(left)} owner-open`)) &&
        flows()
      )
    }
    return null
  }
  const numericParameters = new Map<ts.ParameterDeclaration, boolean>()
  const numericArrayIndex = (expression: ts.Expression): boolean => {
    const numeric = (type: ts.Type): boolean => (type.isUnion() ? type.types.every(numeric) : (type.flags & ts.TypeFlags.NumberLike) !== 0)
    if (numeric(receiverTypeAt(expression) ?? checker.getTypeAtLocation(expression))) return true
    // An unannotated parameter is numeric where every value its closed frame
    // receives is: three's `listArray[ renderCallDepth ]`, whose one caller
    // passes `renderListStack.length`. A re-entered question refuses.
    const value = unwrapValue(expression)
    const declaration = ts.isIdentifier(value) ? flow.targetOf(value)?.declaration : undefined
    if (!declaration || !ts.isParameter(declaration)) return false
    const held = numericParameters.get(declaration)
    if (held !== undefined) return held
    numericParameters.set(declaration, false)
    const values = parameterValuesOf(declaration)
    const answer = values !== null && values.length > 0 && values.every(numericArrayIndex)
    numericParameters.set(declaration, answer)
    return answer
  }
  /**
   * Whether every object `expression` can denote is an Array.
   *
   * The checker says so for most arrays, but not for one read back out of an
   * untyped container: three's `listArray = lists.get( scene )` is `any`, and
   * every value that map ever holds is the literal `[ list ]`. So the origins
   * are asked instead -- literals, the map's stored values, a binding's every
   * write. A re-entered question is assumed: the only value a cycle of
   * bindings can add is the `undefined` of an uninitialized binding, and a
   * member access on that throws before anything runs.
   */
  /**
   * Whether the checker types `expression` as an object that is certainly not
   * an array: every union member a non-array, non-tuple object with no number
   * index. `any`, `unknown` and type parameters are not certain -- three reads
   * its render lists out of an `any` -- and answer false.
   */
  const definiteNonArray = (expression: ts.Expression): boolean => {
    const held = checker.getTypeAtLocation(unwrapValue(expression))
    const type = checker.getNonNullableType(held)
    const members = type.isUnion() ? type.types : [type]
    return (
      members.length > 0 &&
      members.every(
        (member) =>
          (member.flags & ts.TypeFlags.Object) !== 0 &&
          !checker.isArrayType(member) &&
          !checker.isTupleType(member) &&
          member.getNumberIndexType() === undefined &&
          (member as ts.ObjectType).objectFlags !== undefined &&
          ((member as ts.ObjectType).objectFlags & ts.ObjectFlags.Class) !== 0
      )
    )
  }
  const arrayValued = (expression: ts.Expression): boolean => {
    const value = unwrapValue(expression)
    const type = checker.getTypeAtLocation(value)
    if (checker.isArrayType(type) || checker.isTupleType(type)) return true
    return coinduct(arrayAnswers, value, () => arrayOriginsOf(value))
  }
  const arrayOriginsOf = (value: ts.Expression): boolean => {
    if (ts.isArrayLiteralExpression(value) || nullishValue(value)) return true
    if (ts.isConditionalExpression(value)) return arrayValued(value.whenTrue) && arrayValued(value.whenFalse)
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return arrayValued(value.left) && arrayValued(value.right)
      return (operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.CommaToken) && arrayValued(value.right)
    }
    if (ts.isCallExpression(value)) {
      const stored = collectionStoredValuesOf(checker, flow, value, nativeProtocolClosed)
      return stored !== null && stored.length > 0 && stored.every(arrayValued)
    }
    if (!ts.isIdentifier(value)) return false
    const target = flow.targetOf(value)
    const declaration = target?.declaration
    if (!declaration) return false
    if (ts.isParameter(declaration)) {
      const values = ts.isIdentifier(declaration.name) ? parameterValuesOf(declaration) : null
      return values !== null && values.length > 0 && values.every(arrayValued)
    }
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
    if (!ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent)) return false
    if (isModuleExportedDeclaration(checker, declaration, target.symbol ?? null)) return false
    return flow
      .writesToDeclaration(declaration)
      .filter((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
      .every(
        (write) =>
          write.value !== null &&
          (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment' || write.edge === 'logical-assignment') &&
          arrayValued(write.value)
      )
  }
  /** The intrinsic Array member -- declared only by the standard library, or on a receiver the origins prove is an Array. */
  const intrinsicArrayMember = (callee: ts.PropertyAccessExpression): boolean =>
    (checker.getSymbolAtLocation(callee.name)?.declarations ?? []).every((declaration) => declaration.getSourceFile().isDeclarationFile)
  /**
   * Whether the intrinsic Array protocol is closed for an array-valued
   * expression. The plan is one per program; an expression the checker does
   * not type as an array borrows an array literal of the same program as its
   * anchor, once its origins have proven it is one.
   */
  const arrayProtocolClosedAt = (expression: ts.Expression, established = false): boolean => {
    let plan = nativeArrayProtocolPlanOf(checker, flow, expression)
    if (plan === null && (established || arrayValued(expression))) {
      const anchor = flow.arrayLiterals.find((literal) => checker.isArrayType(checker.getTypeAtLocation(literal)))
      plan = anchor ? nativeArrayProtocolPlanOf(checker, flow, anchor) : null
    }
    return plan !== null && nativeProtocolClosed(plan)
  }
  /**
   * `array.push( value )`, `unshift`, `fill`'s value and `splice`'s inserted
   * items through the intrinsic Array protocol: the value is now one element
   * deep in every object the receiver denotes. Null when the call is not that
   * shape -- a record's own `push`, as three's render list has -- so the arms
   * after it answer.
   */
  const arrayStoreArgumentUse = (
    call: ts.CallExpression | ts.NewExpression,
    reference: ts.Expression,
    tail: MemberPath | null
  ): boolean | null => {
    if (!ts.isCallExpression(call)) return null
    const position = call.arguments.indexOf(reference)
    if (position < 0) return null
    const callee = unwrapValue(call.expression)
    if (!ts.isPropertyAccessExpression(callee)) return null
    const name = callee.name.text
    const storing = name === 'push' || name === 'unshift' || (name === 'fill' && position === 0) || (name === 'splice' && position >= 2)
    if (!storing || !intrinsicArrayMember(callee) || !arrayValued(callee.expression)) return null
    if (call.arguments.some(ts.isSpreadElement) || !arrayProtocolClosedAt(callee.expression)) return false
    return publishInto(callee.expression, extendPath(ELEMENT_HOP, tail))
  }
  type CallbackBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  /**
   * Every function a callback argument can be, and whether it can also be
   * nullish. `customOpaqueSort || painterSortStable` in three's render list is
   * `painterSortStable` exactly when `customOpaqueSort` holds nothing -- which
   * is the only value `setOpaqueSort`'s never-called setter leaves in it.
   */
  const callableValuesOf = (
    expression: ts.Expression,
    active: Set<ts.Node> = new Set()
  ): { readonly targets: readonly CallbackBody[]; readonly nullish: boolean } | null => {
    const value = unwrapValue(expression)
    if (nullishValue(value)) return { targets: [], nullish: true }
    if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) return { targets: [value], nullish: false }
    if (ts.isConditionalExpression(value)) {
      const chosen = callableValuesOf(value.whenTrue, active)
      const other = callableValuesOf(value.whenFalse, active)
      return chosen && other && { targets: [...chosen.targets, ...other.targets], nullish: chosen.nullish || other.nullish }
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const first = callableValuesOf(value.left, active)
      const fallback = callableValuesOf(value.right, active)
      return first && fallback && { targets: [...first.targets, ...fallback.targets], nullish: fallback.nullish }
    }
    if (!ts.isIdentifier(value)) return null
    const target = flow.targetOf(value)
    const declaration = target?.declaration
    if (!declaration || active.has(declaration)) return null
    if (ts.isFunctionDeclaration(declaration))
      return declaration.body && !callableBindingIsWritten(flow, declaration) ? { targets: [declaration], nullish: false } : null
    active.add(declaration)
    try {
      let values: readonly ts.Expression[] | null = null
      let nullish = false
      if (ts.isParameter(declaration)) values = ts.isIdentifier(declaration.name) ? parameterValuesOf(declaration) : null
      else if (
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        !isModuleExportedDeclaration(checker, declaration, target.symbol ?? null)
      ) {
        const writes = flow
          .writesToDeclaration(declaration)
          .filter((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
        if (writes.some((write) => !write.value || (write.edge !== 'declaration-initializer' && write.edge !== 'identifier-assignment')))
          return null
        values = writes.map((write) => write.value!)
        nullish = declaration.initializer === undefined
      }
      if (values === null) return null
      const targets: CallbackBody[] = []
      for (const held of values) {
        const found = callableValuesOf(held, active)
        if (found === null) return null
        targets.push(...found.targets)
        nullish ||= found.nullish
      }
      return { targets, nullish }
    } finally {
      active.delete(declaration)
    }
  }
  /**
   * Whether every function a callback argument can be keeps what the
   * intrinsic hands it: `obligations[ i ]` closes each mention of parameter
   * `i`, and a null entry is a slot that carries nothing followed (an index).
   * Slots are taken by position, so a rest or destructured parameter and an
   * `arguments` use are refused rather than approximated, and a nullish
   * callback -- the default comparator, which converts every element to text
   * -- is refused too.
   */
  const callbackClosed = (callback: ts.Expression, obligations: readonly (((expression: ts.Expression) => boolean) | null)[]): boolean => {
    const resolved = callableValuesOf(callback)
    if (resolved === null || resolved.nullish || resolved.targets.length === 0) return false
    return resolved.targets.every((target) => {
      if ((argumentsUsesAt(target)?.length ?? 0) > 0) return false
      const parameters = target.parameters.filter((entry) => !ts.isIdentifier(entry.name) || entry.name.text !== 'this')
      if (parameters.some((entry) => entry.dotDotDotToken || !ts.isIdentifier(entry.name))) return false
      return obligations.every((obligation, position) => {
        const parameter = parameters[position]
        return (
          obligation === null ||
          parameter === undefined ||
          flow.referencesToDeclaration(parameter).every((mention) => mention === parameter.name || obligation(mention))
        )
      })
    })
  }
  /**
   * The objects `expression` can denote hold the followed value at `path`:
   * find where each of them was ALLOCATED and walk forward from there, which
   * reaches every alias it will ever have.
   *
   * Publishing through the binding a store happened to name was not enough.
   * `const leaf = leaves[ 0 ]; leaf.owner = held` walked `leaf`'s mentions,
   * and `leaves[ 0 ].owner` -- the same object, reached through the array
   * the binding was read out of -- was never looked at.
   */
  const publishInto = (expression: ts.Expression, path: MemberPath | null): boolean => {
    let table = publishAnswers.get(path)
    if (!table) publishAnswers.set(path, (table = new Map()))
    return coinduct(table, expression, () => {
      const outer = walkFrame
      const reports = leafReports
      walkFrame = openWalkAnswers
      const closed = publishIntoBody(expression, path)
      if (!closed) onOpenUse?.(expression, path ? 'containing-object' : 'receiver')
      // The generic walk name is only worth a leaf line when no arm inside
      // named the cause; otherwise it double-counts one refusal.
      const traced = closed || leafReports === reports ? traceReceiver(expression, 'publish', closed) : closed
      if (!closed) openWalkAnswers += 1
      walkFrame = outer
      return traced
    })
  }
  /** `publishInto`'s arms; a null path means the objects ARE the followed value. */
  const publishIntoBody = (expression: ts.Expression, path: MemberPath | null): boolean => {
    const value = unwrapValue(expression)
    if (nullishValue(value)) return true
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return literalAllocationUse(value, path)
    if (ts.isNewExpression(value)) {
      const owner = sourceClassOf(value)
      if (owner !== null)
        return (
          classInstancesUse(owner, path) ||
          traceReceiver(expression, 'publish:new', false, () => `family=${owner.name?.text ?? '(anonymous)'} instances-open`)
        )
      // No construction inventory names this site, so its own uses are walked
      // beside every instance's.
      const family = ownConstructorClassOf(value)
      if (family !== null)
        return (
          (classInstancesUse(family, path) && onward(value, path)) ||
          traceReceiver(expression, 'publish:new', false, () => `own-constructor=${family.name?.text ?? '(anonymous)'} open`)
        )
      return (
        constructorFactoryReturns(value, path) ||
        traceReceiver(
          expression,
          'publish:new',
          false,
          () => `callee=${value.expression.getText().slice(0, 40)} no-source-class factory-returns-open`
        )
      )
    }
    // A primitive holds no members: storing into one stores nothing.
    if (primitive(checker.getTypeAtLocation(value))) return true
    if (value.kind === ts.SyntaxKind.ThisKeyword || value.kind === ts.SyntaxKind.SuperKeyword) return thisPublication(value, path)
    if (ts.isConditionalExpression(value)) return publishInto(value.whenTrue, path) && publishInto(value.whenFalse, path)
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return publishInto(value.left, path) && publishInto(value.right, path)
      return (operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.CommaToken) && publishInto(value.right, path)
    }
    if (ts.isCallExpression(value)) return callOrigins(value, path)
    if (ts.isElementAccessExpression(value) && numericArrayIndex(value.argumentExpression)) {
      // `arguments[ i ]` is not an Array -- the checker never types it as
      // one, so the intrinsic Array protocol question below is a category
      // error for it and always answered closed=false. What actually holds
      // it is the set of every actual argument its owner's callers pass, at
      // any position (an unindexed read cannot be pinned to one), which is
      // exactly `argumentsElementValuesOf`.
      if (isArgumentsObjectIdentifier(value.expression, checker)) {
        const owner = enclosingArgumentsFunction(value.expression)
        const values = owner ? argumentsElementValuesOf(owner) : null
        if (values === null) return traceReceiver(expression, 'publish:element', false, () => 'arguments-frame-open')
        return values.every((argument) => publishInto(argument, path))
      }
      return (
        (arrayProtocolClosedAt(value.expression) || traceReceiver(expression, 'publish:element', false, () => 'array-protocol-open')) &&
        publishInto(value.expression, extendPath(OWED_ELEMENT_HOP, path))
      )
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      if (!constructionDataMember(value))
        return traceReceiver(expression, 'publish:member-read', false, () => `key=${accessKeyOf(value)} not-a-data-member`)
      return (
        publishInto(value.expression, extendPath(propertyHop(fieldDeclaration(value), accessKeyOf(value), true), path)) ||
        traceReceiver(expression, 'publish:member-read', false, () => `key=${accessKeyOf(value)} owner-open`)
      )
    }
    if (ts.isIdentifier(value))
      return (
        identifierOrigins(value, path) ||
        traceReceiver(
          expression,
          'publish:identifier',
          false,
          () =>
            `name=${value.text} target=${flow.targetOf(value)?.declaration ? ts.SyntaxKind[flow.targetOf(value)!.declaration!.kind] : 'none'}`
        )
      )
    // Every other value kind: an unmodelled expression this walk cannot follow.
    // Named because the two largest leaves in the whole program reported only
    // `publish`, which is the walk, not the cause.
    return traceReceiver(expression, 'publish:unmodelled', false, () => `kind=${ts.SyntaxKind[value.kind]}`)
  }
  /**
   * The class whose family `new this.constructor( ... )` allocates from, or
   * null.
   *
   * In an instance member of `C`, `this.constructor` is the constructor of
   * whatever object the member runs on. That object is one of `C`'s family
   * only when every call enters with such a receiver, and its `constructor`
   * is the class's own only while no write the flow index names replaces a
   * `constructor` slot. (The source transform that types this idiom states
   * the same fact per file.)
   */
  const ownConstructorClassOf = (construction: ts.NewExpression): ts.ClassDeclaration | ts.ClassExpression | null => {
    const callee = unwrapValue(construction.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'constructor') return null
    const receiver = unwrapValue(callee.expression)
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return null
    const frame = receiverOwnerOf(receiver)
    if (
      !frame ||
      !(
        ts.isMethodDeclaration(frame) ||
        ts.isConstructorDeclaration(frame) ||
        ts.isGetAccessorDeclaration(frame) ||
        ts.isSetAccessorDeclaration(frame)
      ) ||
      (ts.getCombinedModifierFlags(frame) & ts.ModifierFlags.Static) !== 0
    )
      return null
    const owner = frame.parent
    if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null
    if (ts.isMethodDeclaration(frame)) {
      // Enumerating every caller of `frame` (`closedCallerSitesOf`, with no
      // explicit `this` among them) is the very slot-closure question this
      // proof sits inside when `frame` IS the clone idiom: three's
      // Object3D/Material/Texture/Camera/BufferGeometry/RenderTarget/Sphere
      // each declare `clone() { return new this.constructor().copy(this) }`,
      // so a full caller enumeration for one clone chases the others'.
      //
      // `memberSlotClosed` is the weaker, still SOUND fact that settles it
      // without enumerating callers at all. It proves a different thing about
      // the same slot: not "who calls it", but "is the value ever read
      // instead of called" -- no bare `x.m`, no `.call`/`.apply`/`.bind` (an
      // explicit-`this` invocation only counts as closed there when the call
      // itself was already admitted as an ordinary member call, which this
      // slot's own inventory never admits), no write of a foreign function
      // into the slot. The only way left to reach `frame`'s body is an
      // ordinary `receiver.m( ... )` the checker resolved to this exact
      // declaration -- which the checker does only when `receiver`'s static
      // type itself carries `frame`, i.e. is `C` or a subtype that does not
      // shadow it. So whichever object is `this` inside `frame`, it is one of
      // `C`'s family, with no caller enumerated by name.
      //
      // Fall back to the caller enumeration where the slot proof itself
      // refuses (an override elsewhere in the family, a reflective read this
      // proof cannot see past): a program that already satisfied the old,
      // stronger test must keep satisfying it.
      if (!memberSlotClosed(frame)) {
        const calls = closedCallerSitesOf(frame)
        if (calls === null || calls.some(({ explicitThis }) => explicitThis !== null)) return null
      }
    } else if (!ts.isConstructorDeclaration(frame)) return null
    return constructorSlotUnwritten(receiver) ? owner : null
  }
  /** No write the flow index names replaces the `constructor` slot `receiver`'s type reads. */
  const constructorSlotUnwritten = (receiver: ts.Expression): boolean => {
    return sourceClassConstructorSlotIsOriginal(checker, flow, {
      kind: 'value',
      receiver: receiverTypeAt(receiver) ?? checker.getTypeAtLocation(receiver),
      expression: receiver,
      originsOf: allocationOriginsOf
    })
  }
  /**
   * `object.constructor` read as a value and not called on `object`.
   *
   * While no write replaces the slot, what it yields is the function that
   * allocated `object` -- never `object`, and nothing `object` holds. Only a
   * CALL through the slot could hand `object` on, as that call's `this`.
   * Three's `Texture.clone` is `new this.constructor().copy( this )`.
   */
  const constructorValueRead = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'constructor') return false
    let site: ts.Node = access
    while (
      ts.isParenthesizedExpression(site.parent) ||
      ts.isAsExpression(site.parent) ||
      ts.isTypeAssertionExpression(site.parent) ||
      ts.isNonNullExpression(site.parent) ||
      ts.isSatisfiesExpression(site.parent)
    )
      site = site.parent
    const user = site.parent
    // Publishing the constructor can expose its prototype and create callers
    // outside this inventory. Only its direct construction use qualifies here.
    if (!ts.isNewExpression(user) || user.expression !== site) return false
    return constructorSlotUnwritten(access.expression)
  }
  const sourceClassOf = (construction: ts.NewExpression): ts.ClassDeclaration | ts.ClassExpression | null => {
    const callee = unwrapValue(construction.expression)
    if (!ts.isIdentifier(callee)) return null
    const declaration = resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(callee))?.valueDeclaration
    return declaration &&
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
      !declaration.getSourceFile().isDeclarationFile
      ? declaration
      : null
  }
  const classAnswers = new Map<MemberPath | null, Map<ts.Node, Answer>>()
  /**
   * Every instance of a source class holds the followed value at `path`:
   * every construction and every constructor or field-initializer `this`,
   * which are all the aliases an instance has before anyone else is handed it.
   * A slot whose stores are owed also counts the field initializers that fill
   * it.
   */
  const classInstancesUse = (owner: ts.ClassDeclaration | ts.ClassExpression, path: MemberPath | null): boolean => {
    let table = classAnswers.get(path)
    if (!table) classAnswers.set(path, (table = new Map()))
    return coinduct(table, owner, () => {
      const use = (value: ts.Expression): boolean => onward(value, path)
      // TEMPORARY diagnostic for root A's real-WebGLRenderer probe -- names
      // which of `familyReceiversClosed`'s two obligations (an initializer's
      // own `this`, or a construction site) refused, and at which site.
      // Remove once the real-file refusal is found.
      const watchedClassInstances = process.env['GEA_CLASS_INSTANCES_DEBUG']
      const debugOpen = (reason: string, at?: ts.Node): false => {
        if (watchedClassInstances !== undefined && (watchedClassInstances === '*' || (owner.name?.text ?? '') === watchedClassInstances)) {
          const site = at ?? owner
          const file = site.getSourceFile()
          const line = file.getLineAndCharacterOfPosition(site.getStart()).line + 1
          console.error(
            `[CLASS-INSTANCES] ${owner.name?.text ?? '(anonymous)'} ${reason} ${file.fileName.split('/').pop()}:${line} [${site.getText().slice(0, 60).replace(/\s+/g, ' ')}]`
          )
        }
        return false
      }
      if (!familyReceiversClosed(new Set([owner]), use, debugOpen)) return false
      if (path === null || !headsOwe(path)) return true
      const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([owner]))
      if (inventory === null) return false
      return inventory.initializers.every(({ member }) => {
        if (!ts.isPropertyDeclaration(member) || !member.initializer) return true
        const key = publicationKeyOf(member.name)
        if (key === null) return false
        const obligations = [
          ...storeObligations(path, { element: false, declaration: member, key }),
          ...(CANONICAL_INDEX.test(key) ? storeObligations(path, ELEMENT_READ) : [])
        ]
        return obligations.every((continuation) => publishInto(member.initializer!, continuation))
      })
    })
  }
  /** A literal allocation: its own forward walk, plus the initial contents of an owed slot. */
  const literalAllocationUse = (literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, path: MemberPath | null): boolean => {
    if (!onward(literal, path)) return false
    if (path === null || !headsOwe(path)) return true
    if (ts.isArrayLiteralExpression(literal)) {
      const obligations = storeObligations(path, ELEMENT_READ)
      return (
        obligations.length === 0 ||
        literal.elements.every(
          (element) =>
            ts.isOmittedExpression(element) ||
            (!ts.isSpreadElement(element) && obligations.every((continuation) => publishInto(element, continuation)))
        )
      )
    }
    return literal.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return false
      const key = publicationKeyOf(property.name)
      if (key === null) return false
      const obligations = [
        ...storeObligations(path, { element: false, declaration: property, key }),
        ...(CANONICAL_INDEX.test(key) ? storeObligations(path, ELEMENT_READ) : [])
      ]
      if (obligations.length === 0) return true
      if (ts.isPropertyAssignment(property)) return obligations.every((continuation) => publishInto(property.initializer, continuation))
      if (ts.isShorthandPropertyAssignment(property)) return obligations.every((continuation) => publishInto(property.name, continuation))
      return false
    })
  }
  /**
   * An object-returning constructor replaces its fresh receiver. This is
   * construction policy over the shared completion inventory; ordinary
   * calls must consume the complete admitted invocation fact below.
   */
  const constructorFactoryReturns = (call: ts.NewExpression, path: MemberPath | null): boolean => {
    const callee = unwrapValue(call.expression)
    if (!ts.isIdentifier(callee)) return false
    const target = flow.targetOf(callee)?.declaration
    if (!target || !ts.isFunctionDeclaration(target) || !target.body || target.asteriskToken) return false
    if (target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || callableBindingIsWritten(flow, target))
      return false
    const returned = callableCompletionValuesOf(flow, target)
    if (returned === null) return false
    if (
      !returned.every((expression) => {
        const value = unwrapValue(expression)
        return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)
      })
    )
      return false
    return returned.every((expression) => publishInto(expression, path))
  }
  const callOrigins = (call: ts.CallExpression, path: MemberPath | null): boolean => {
    const stored = collectionStoredValuesOf(checker, flow, call, nativeProtocolClosed)
    if (stored !== null) return stored.every((value) => publishInto(value, path))
    const callee = unwrapValue(call.expression)
    if (ts.isPropertyAccessExpression(callee) && intrinsicArrayMember(callee) && arrayValued(callee.expression)) {
      const receiver = callee.expression
      if (call.arguments.some(ts.isSpreadElement) || !arrayProtocolClosedAt(receiver)) return false
      switch (callee.name.text) {
        // One of the receiver's own elements, which one unknown.
        case 'pop':
        case 'shift':
        case 'at':
        case 'find':
        case 'findLast':
          return publishInto(receiver, extendPath(OWED_ELEMENT_HOP, path))
        // A new array of some of the receiver's elements: the receiver's
        // stores for what it starts with, its own forward walk for the rest.
        case 'slice':
        case 'filter':
        case 'splice':
          // A copy is a fresh array, never the followed object itself.
          return path !== null && headsOf(path).every((id) => id === '[]') && publishInto(receiver, path) && containerUse(call, path)
      }
      return false
    }
    const fact = invocationFactOf(call)
    const values = fact && invocationCompletionValuesOf(fact)
    return values !== null && values.every((value) => publishInto(value, path))
  }
  /**
   * The complete source bodies entered by one invocation.  This deliberately
   * lives inside the member proof: member slots, descendant implementations,
   * receiver families, and deferred intrinsic obligations must all come from
   * the same proof context.  A standalone callee walk would certify a method
   * while silently losing the receiver binding that selects its body.
   */
  const prototypeReceiverAnswers = new Map<ts.Node, Answer>()
  const prototypeReceiversClosed = (owner: ts.ClassDeclaration | ts.ClassExpression): boolean =>
    coinduct(prototypeReceiverAnswers, owner, () => {
      // A parked family is an enclosing receiver-closure obligation, not a
      // claim that a virtual method slot has one particular callable value.
      if (activeFamilies.has(owner)) {
        noteAssumption(owner)
        return true
      }
      const inventory = ownedClassReceiverInventoryOf(checker, flow, new Set([owner]))
      if (inventory === null) return false
      const roots = [
        ...inventory.constructionFacts.map(({ call }) => call),
        ...inventory.initializers.flatMap(({ references }) => references)
      ]
      if (roots.length === 0) return true
      return hasClosedMemberCallableUses(
        checker,
        flow,
        null,
        new Set(),
        receiverTypeAt,
        argumentsUsesAt,
        onOpenUse,
        nestedMembers,
        new Set([...nestedFamilies(), owner]),
        { roots, terminalUse: () => null }
      )
    })
  const invocationTargetsOf = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    // Ordinary source interface member calls belong to the joint value/storage/use
    // graph. A refusal is final for this domain: the former receiver-origin
    // fallback would reopen the same field in a fresh proof session.
    const sourceValues = sourceValueSessionOf(checker, flow)
    if (sourceValues.ownsInvocation(call))
      return sourceValues.invocationTargetsOf(call) ?? invocationRefusal(call, 'targets:source-value-session')
    const site = callsOf(flow).sites.get(call)
    if (!site) return invocationRefusal(call, 'targets:no-site')
    const explicit = site.explicitThis
    const callee = site.operands.callee
    if (explicit && !explicitInvocationIsIntact(call)) return invocationRefusal(call, 'targets:explicit-invocation-not-intact')
    const dispatch = site.operands.dispatch
    if (dispatch.kind === 'lexical-super') {
      const home = dispatch.home
      const key = dispatch.key
      // A lexical lookup cannot fall back to the runtime receiver's class.
      // Static and object-home receiver frames require their own constructor
      // or object origins; the instance-family proof cannot establish them.
      if (home === null || ts.isObjectLiteralExpression(home) || dispatch.static || key === null)
        return invocationRefusal(call, 'targets:lexical-super-home')
      const symbol = home.name ? checker.getSymbolAtLocation(home.name) : checker.getTypeAtLocation(home).getSymbol()
      const instance = symbol && checker.getDeclaredTypeOfSymbol(symbol)
      if (!instance?.isClassOrInterface() || !classConstructorKeepsInstanceOf(checker, flow, instance))
        return invocationRefusal(call, 'targets:lexical-super-instance-open')
      const selected = new Set<ts.SignatureDeclaration>()
      const activeBases = new Set<SourceClass>()
      const baseSlots = (owner: SourceClass): boolean => {
        if (!isClassSpelledSourceClass(owner) || activeBases.has(owner)) return false
        activeBases.add(owner)
        try {
          const own: ts.MethodDeclaration[] = []
          for (const member of owner.members) {
            if (!member.name || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0) continue
            if (ts.isPrivateIdentifier(member.name)) continue
            // Instance fields live on the receiver, not on the prototype
            // where super starts its lookup.
            if (ts.isPropertyDeclaration(member) || ts.isConstructorDeclaration(member)) continue
            const memberKey = objectLiteralEntryKeyOf(member.name)
            if (memberKey === null) return false
            if (memberKey !== key) continue
            if (!ts.isMethodDeclaration(member)) return false
            if (member.body) own.push(member)
          }
          if (own.length > 0) {
            for (const body of own) {
              // The prototype must also be inaccessible through escaped
              // instances. This is object closure, independent of an own
              // method replacement that super's prototype lookup bypasses.
              if (!prototypeReceiversClosed(owner)) return false
              const receiver = site.operands.receiver
              if (receiver === null || !receiverInFamily(receiver, body)) return false
              selected.add(body)
            }
            return true
          }
          return visitBases(owner)
        } finally {
          activeBases.delete(owner)
        }
      }
      const visitBases = (owner: ts.ClassDeclaration | ts.ClassExpression): boolean => {
        const heritage = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        if (!heritage || heritage.types.length !== 1) return false
        const expression = heritage.types[0]!.expression
        const bases = sourceConstructorSelectionsOf(checker, flow, expression)
        return bases !== null && bases.length > 0 && bases.every(baseSlots)
      }
      return visitBases(home) && selected.size > 0 ? [...selected] : null
    }
    if (dispatch.kind === 'super-constructor') {
      // `super( color, intensity )` runs the base constructor on the object
      // this constructor already owns -- the same body selection `new Base()`
      // makes (source-construction-frames.ts), reached from the heritage
      // clause instead of a spelled callee. Refusing it outright left every
      // derived constructor's arguments unforwarded: three's
      // DirectionalLight/AmbientLight/HemisphereLight `super( color,
      // intensity )` were unauthenticated callees in the host-mutation
      // census, and one opaque `intensity` there was the `*` wildcard for
      // the whole program. The receiver is lexical (`this` of the home
      // class), which the census attributes from the base body's own
      // allocation-derived receiver values, not from this call.
      const constructors = sourceConstructionFramesOf(checker, flow).targetsOf(call)
      return constructors !== null && constructors.length > 0 ? constructors : invocationRefusal(call, 'targets:super-constructor-open')
    }
    const targets = closedCallableTargetsOf(checker, flow, callee, elementCalleeAuthority)
    if (targets !== null) {
      // This invocation states its receiver explicitly. Enumerating all other
      // callers of a stored callback is unnecessary for its target identity;
      // the consumer must retain this call's actual receiver edge.
      if (explicit) return explicit.receiver ? targets : invocationRefusal(call, 'targets:explicit-without-receiver')
      return targets.some(
        (target) =>
          !ts.isArrowFunction(target) && flow.receiverReferencesToDeclaration(target).length > 0 && receiverValuesOf(target) === null
      )
        ? invocationRefusal(call, 'targets:closed-target-receiver-values-open')
        : targets
    }
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const receiver = callee.expression
      const key = accessKeyOf(callee)
      const origins = key === null ? null : allocationOriginsOf(receiver)
      traceClosedCallee(
        call,
        'invocationTargetsOf/origins',
        `key=${key ?? 'null'} origins=${origins === null ? 'null' : origins.classes.size}`
      )
      if (origins !== null) {
        const privateDeclarations =
          ts.isPropertyAccessExpression(callee) && ts.isPrivateIdentifier(callee.name)
            ? privateMemberDeclarationsOf(callee.name)
            : null
        const selected = new Set<ts.SignatureDeclaration>()
        for (const owner of origins.classes) {
          const slotDeclarations =
            privateDeclarations ??
            (() => {
              const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
              return symbol ? checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), key!)?.declarations : undefined
            })()
          if (!slotDeclarations?.length) return invocationRefusal(call, 'targets:origin-slot-undeclared')
          for (const declared of slotDeclarations) {
            const bodies = memberImplementationsOf(declared)
            if (bodies === null || bodies.length === 0) return invocationRefusal(call, 'targets:origin-no-member-implementations')
            if (!slotDeclarationsOf(declared).every(slotClosedForTargets)) return invocationRefusal(call, 'targets:origin-slot-open')
            if (explicit && (!explicit.receiver || !receiverInFamily(explicit.receiver, declared)))
              return invocationRefusal(call, 'targets:origin-explicit-receiver')
            for (const body of bodies) selected.add(body)
          }
        }
        return selected.size > 0 ? [...selected] : null
      }
      if (!explicit) {
        const records = recordMethodCallTargetsOf(flow, call, computedKeyAuthority)
        traceClosedCallee(
          call,
          'invocationTargetsOf/recordMethodCallTargetsOf',
          records === null ? 'null (see GEA_INVOCATION_REFUSALS for the record: reason)' : `${records.length} bodies`
        )
        if (records !== null && records.length > 0) return records
      }
      const declared = fieldDeclaration(callee)
      traceClosedCallee(call, 'invocationTargetsOf/fieldDeclaration', declared === null ? 'null' : describeCall(declared))
      if (declared === null) return invocationRefusal(call, 'targets:no-field-declaration')
      const bodies = memberImplementationsOf(declared)
      if (bodies === null || bodies.length === 0) return invocationRefusal(call, 'targets:no-member-implementations')
      if (!slotDeclarationsOf(declared).every(slotClosedForTargets)) return invocationRefusal(call, 'targets:member-slot-open')
      if (!receiverInFamily(receiver, declared)) return invocationRefusal(call, 'targets:receiver-not-in-family')
      if (explicit && (!explicit.receiver || !receiverInFamily(explicit.receiver, declared)))
        return invocationRefusal(call, 'targets:explicit-receiver-not-in-family')
      return bodies
    }
    return invocationRefusal(call, 'targets:callee-not-member')
  }
  /**
   * `GEA_CLOSED_CALLEE_WATCH=<substring>|'*'` traces `closedCalleeBodiesOf`'s
   * own cascade for ONE call, scoped by its text. `GEA_INVOCATION_REFUSALS`
   * already narrates every refusal in the whole program -- millions of rows
   * on the three.js app, and its rows rank RE-ASKS of the same question, not roots
   * (see the memory note on reading it) -- so isolating one call's own
   * decision path out of that firehose is impractical. This prints only for
   * the matching call, once per stage, so which of `invocationTargetsOf`'s
   * own three sub-branches, `memberAccessCalleeBodiesOf`, or
   * `parameterCalleeBodiesOf` produced the final answer -- and what each
   * intermediate step returned -- is directly legible. Read together with
   * `GEA_INVOCATION_REFUSALS=1` when a stage names `recordMethodCallTargetsOf`
   * as `null`: that instrument's `record:*` reason is the one this cannot
   * reproduce without duplicating `source-record-data.ts`'s own logic.
   */
  const watchedClosedCallee = process.env['GEA_CLOSED_CALLEE_WATCH']
  const traceClosedCallee = (node: ts.Node, stage: string, detail: string): void => {
    if (watchedClosedCallee === undefined) return
    const file = node.getSourceFile()
    const text = node.getText(file).replace(/\s+/g, ' ').slice(0, 80)
    if (watchedClosedCallee !== '*' && !text.includes(watchedClosedCallee)) return
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    console.error(`[CLOSED-CALLEE] ${file.fileName.split('/').pop()}:${line} ${text} :: ${stage} :: ${detail}`)
  }
  /**
   * `closedCalleeBodiesOf`'s own relaxation of `invocationTargetsOf`'s
   * member-access branches: the same target selection, with
   * `slotClosedForTargets`'s "nothing writes this slot" replaced by
   * `memberSlotWrittenBodiesOf`'s "every write that reaches the family is
   * itself a nameable compiled function". Kept OUT of `invocationTargetsOf`
   * itself, which also feeds `invocationFactOf`'s stronger promise -- a
   * complete argument-forwarding frame for every target -- because a caller
   * that only asks "which bodies can this call enter" does not need that
   * promise, and folding the relaxation into the shared function would hand
   * every other consumer of `invocationTargetsOf` a wider target set it never
   * asked to reason about.
   */
  const memberAccessCalleeBodiesOf = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    const site = callsOf(flow).sites.get(call)
    if (!site) return null
    const explicit = site.explicitThis
    if (explicit && !explicitInvocationIsIntact(call)) return null
    const callee = site.operands.callee
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
    const receiver = callee.expression
    const key = accessKeyOf(callee)
    const origins = key === null ? null : allocationOriginsOf(receiver)
    const closedWithOverrides = (declared: ts.Declaration, into: Set<ts.SignatureDeclaration>): boolean => {
      for (const slot of slotDeclarationsOf(declared)) {
        if (slotClosedForTargets(slot)) continue
        const written = memberSlotWrittenBodiesOf(slot)
        if (written === null) return false
        for (const body of written) into.add(body)
      }
      return true
    }
    if (origins !== null) {
      const privateDeclarations =
        ts.isPropertyAccessExpression(callee) && ts.isPrivateIdentifier(callee.name) ? privateMemberDeclarationsOf(callee.name) : null
      const selected = new Set<ts.SignatureDeclaration>()
      for (const owner of origins.classes) {
        const slotDeclarations =
          privateDeclarations ??
          (() => {
            const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
            return symbol ? checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), key!)?.declarations : undefined
          })()
        if (!slotDeclarations?.length) return null
        for (const declared of slotDeclarations) {
          const bodies = memberImplementationsOf(declared)
          if (bodies === null || bodies.length === 0) return null
          for (const body of bodies) selected.add(body)
          if (!closedWithOverrides(declared, selected)) return null
          if (explicit && (!explicit.receiver || !receiverInFamily(explicit.receiver, declared))) return null
        }
      }
      return selected.size > 0 ? [...selected] : null
    }
    const declared = fieldDeclaration(callee)
    if (declared === null) return null
    const bodies = memberImplementationsOf(declared)
    if (bodies === null || bodies.length === 0) return null
    if (!receiverInFamily(receiver, declared)) return null
    if (explicit && (!explicit.receiver || !receiverInFamily(explicit.receiver, declared))) return null
    const found = new Set<ts.SignatureDeclaration>(bodies)
    if (!closedWithOverrides(declared, found)) return null
    return [...found]
  }
  /**
   * `closedCalleeBodiesOf`'s parameter case: `onLoad( buffer )` inside
   * `loadBuffer( url, onLoad: (buffer: BufferLike) => void, nativeName )` --
   * the app's `engine.ts:111` -- names a PARAMETER, so `getResolvedSignature`
   * points at the parameter's declared function TYPE, which has no body.
   * `parameterValuesOf` is already the general "every value this parameter
   * can hold" proof: it enumerates every closed caller of the enclosing
   * function via `closedCallerSitesOf`, which refuses the moment that
   * function's own callers cannot all be named -- an export nothing tracks,
   * an `arguments` use, a spread call, any other open edge -- so a parameter
   * of a function that itself escapes already refuses here, with no separate
   * check needed. What remains is resolving each supplied value to the
   * compiled function it denotes.
   */
  const parameterCalleeBodiesOf = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    const site = callsOf(flow).sites.get(call)
    if (!site) return null
    const callee = site.operands.callee
    if (!ts.isIdentifier(callee)) return null
    const declaration = flow.targetOf(callee)?.declaration
    if (!declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return null
    const values = parameterValuesOf(declaration)
    if (values === null) return null
    const found = new Set<ts.SignatureDeclaration>()
    for (const value of values) {
      const targets = closedCallableTargetsOf(checker, flow, value, elementCalleeAuthority)
      if (targets === null) return null
      for (const target of targets) found.add(target)
    }
    return found.size > 0 ? [...found] : null
  }
  /**
   * `closedCalleeBodiesOf`'s own three-stage cascade, traced under
   * `GEA_CLOSED_CALLEE_WATCH` so a single run names which stage (if any)
   * answered a given call -- `invocationTargetsOf` first (its own
   * member-access branches are traced above, including the
   * `recordMethodCallTargetsOf` route three's factory-record idiom needs),
   * then this session's two relaxations.
   */
  const closedCalleeBodiesCascade = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    const fromTargets = invocationTargetsOf(call)
    if (fromTargets !== null) {
      traceClosedCallee(call, 'closedCalleeBodiesOf', `invocationTargetsOf -> ${fromTargets.length} bodies`)
      return fromTargets
    }
    const fromMember = memberAccessCalleeBodiesOf(call)
    if (fromMember !== null) {
      traceClosedCallee(call, 'closedCalleeBodiesOf', `memberAccessCalleeBodiesOf -> ${fromMember.length} bodies`)
      return fromMember
    }
    const fromParameter = parameterCalleeBodiesOf(call)
    traceClosedCallee(
      call,
      'closedCalleeBodiesOf',
      fromParameter === null ? 'all three stages refused' : `parameterCalleeBodiesOf -> ${fromParameter.length} bodies`
    )
    return fromParameter
  }
  const invocationFacts = new Map<ts.CallExpression, SourceInvocationFact>()
  const activeInvocationFacts = new Set<ts.CallExpression>()
  // Why a source invocation has no fact. One refusal here becomes an opaque
  // call result, and an opaque result handed to any callee the host-mutation
  // census cannot authenticate is the wildcard that strips every host global
  // of its identity -- so a single unnamed refusal here can cost a whole
  // program its certificate. `GEA_INVOCATION_REFUSALS` names them.
  const invocationRefusalDebug = process.env['GEA_INVOCATION_REFUSALS'] !== undefined
  const describeCall = (node: ts.Node): string => {
    const file = node.getSourceFile()
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    return `${file.fileName.split('/').pop()}:${line + 1} ${node.getText(file).replace(/\s+/g, ' ').slice(0, 80)}`
  }
  const invocationRefusal = (node: ts.Node, reason: string): null => {
    if (invocationRefusalDebug) console.error(`[INVOCATION-REFUSAL] ${reason} :: ${describeCall(node)}`)
    return null
  }
  const invocationFactOf = (call: ts.CallExpression): SourceInvocationFact | null => {
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const known = invocationFacts.get(call)
    if (known) return known.requirements.length === 0 || ledger?.include(known.requirements) === true ? known : null
    if (activeInvocationFacts.has(call)) {
      // A refusal on the strength of a fact still being computed is a
      // hypothesis, not a result: anything that leaned on it is reusable only
      // while this same call is still open.
      noteAssumption(call)
      return invocationRefusal(call, 'recursive-hypothesis')
    }
    const site = callsOf(flow).sites.get(call)
    if (!site?.operands) return invocationRefusal(call, 'no-operands')
    const operands = site.operands
    const compute = () => {
      const targets = invocationTargetsOf(call)
      if (targets === null) return invocationRefusal(call, 'no-targets')
      if (targets.length === 0) return invocationRefusal(call, 'empty-targets')
      const candidates = targets.map((body) => sourceInvocationFrame(flow, call, body, argumentsUsesAt))
      // An unindexed body contributes missing effects, not an empty frame.
      if (candidates.every((frame) => frame !== null)) return candidates
      for (const [index, frame] of candidates.entries())
        if (frame === null) invocationRefusal(targets[index]!, `unmodelled-frame for ${describeCall(call)}`)
      return null
    }
    activeInvocationFacts.add(call)
    enterHypothesisGuard(call)
    try {
      // Only the REFUSAL is shared across proofs. A successful fact stays in
      // this proof's own `invocationFacts` (`shareable` declines to publish
      // it) because a fact carries frames built against this proof's census
      // view; the refusal carries none, and `targets:origin-slot-open` alone
      // was re-derived 41,190 times for one site in the three.js app.
      const answer = sharedAnswerOf(`invocation-targets:${nodePathToken(call)}`, compute, (value) => value === null)
      if (answer.value === null) return null
      const fact = sourceInvocationFact(call, operands, answer.value, answer.requirements)
      if (fact.requirements.length > 0 && ledger?.include(fact.requirements) !== true)
        return invocationRefusal(call, 'uncapturable-intrinsic-requirements')
      // A successful continuation can still depend on an enclosing recursive
      // hypothesis. Publish its memo only when that hypothesis is discharged.
      computedKeyAuthority.whenSettled(() => invocationFacts.set(call, fact))
      return fact
    } finally {
      // The re-entry above hands out one thing, a refusal. A refusal here is
      // therefore the same answer, so the hypothesis it issued has become a
      // fact and every answer that leaned on it is freed of it.
      exitHypothesisGuard(call, true)
      activeInvocationFacts.delete(call)
    }
  }
  const identifierOrigins = (value: ts.Identifier, path: MemberPath | null): boolean => {
    const target = flow.targetOf(value)
    const declaration = target?.declaration
    if (!declaration || declaration.getSourceFile().isDeclarationFile) return false
    if (ts.isParameter(declaration)) {
      const values = ts.isIdentifier(declaration.name) ? parameterValuesOf(declaration) : null
      return values !== null && values.every((held) => publishInto(held, path))
    }
    if (ts.isBindingElement(declaration)) return bindingOrigins(declaration, path)
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
    if (isModuleExportedDeclaration(checker, declaration, target.symbol ?? null)) return false
    const list = declaration.parent
    const statement = ts.isVariableDeclarationList(list) ? list.parent : undefined
    if (statement && ts.isForOfStatement(statement) && statement.initializer === list)
      return arrayProtocolClosedAt(statement.expression) && publishInto(statement.expression, extendPath(OWED_ELEMENT_HOP, path))
    if (!statement || !ts.isVariableStatement(statement)) return false
    return flow
      .writesToDeclaration(declaration)
      .filter((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield')
      .every(
        (write) =>
          write.value !== null &&
          (write.edge === 'declaration-initializer' || write.edge === 'identifier-assignment' || write.edge === 'logical-assignment') &&
          publishInto(write.value, path)
      )
  }
  /** `const { object } = renderItem` / `const [ first ] = list`: the source's slot, any value it held. */
  const bindingOrigins = (element: ts.BindingElement, path: MemberPath | null): boolean => {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return false
    const pattern = element.parent
    const holder = pattern.parent
    let hop: Hop = OWED_ELEMENT_HOP
    if (ts.isObjectBindingPattern(pattern)) {
      const key = element.propertyName ? publicationKeyOf(element.propertyName) : element.name.text
      if (key === null) return false
      hop = propertyHop(null, key, true)
    }
    const sources = ts.isVariableDeclaration(holder)
      ? holder.initializer
        ? [holder.initializer]
        : null
      : ts.isParameter(holder)
        ? parameterValuesOf(holder)
        : null
    if (sources === null) return false
    const inner = extendPath(hop, path)
    return (
      sources.every(
        (source) =>
          (hop.kind === 'element' ? arrayProtocolClosedAt(source) : constructionDataMemberOf(source, hop.key)) && publishInto(source, inner)
      ) &&
      (!element.initializer || publishInto(element.initializer, path))
    )
  }
  /** The nearest frame whose `this` a `this` or `super` expression is. */
  const receiverOwnerOf = (expression: ts.Node): ts.Node | undefined => flow.receiverOwnerOf(expression) ?? undefined
  /**
   * `this` holds the followed value at `path`. In a constructor or a field
   * initializer that is every instance of the class. In a method it is the
   * RECEIVER of every call -- the call's result is some other object, and
   * treating it as the receiver let `class A { m( v ) { this.owner = v } }`
   * put `held` into `a.owner` with `a` never walked. In a plain function it
   * is the object each `new` site creates.
   */
  const thisPublication = (expression: ts.Expression, path: MemberPath | null): boolean => {
    const owner = receiverOwnerOf(expression)
    if (!owner) return false
    if (ts.isPropertyDeclaration(owner) || ts.isConstructorDeclaration(owner)) {
      const holder = owner.parent
      if (ts.isPropertyDeclaration(owner) && (ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Static) !== 0) return false
      return (ts.isClassDeclaration(holder) || ts.isClassExpression(holder)) && classInstancesUse(holder, path)
    }
    if (!ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner) && !ts.isFunctionExpression(owner)) return false
    const calls = closedCallerSitesOf(owner)
    if (calls === null) return false
    if (ts.isMethodDeclaration(owner) || memberSlotNameOf(owner) !== null)
      return calls.every(({ call, explicitThis }) => {
        const callee = unwrapValue(call.expression)
        return (
          explicitThis === null &&
          ts.isCallExpression(call) &&
          (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          publishInto(callee.expression, path)
        )
      })
    // A plain call leaves `this` undefined in a module, so only `new` makes an
    // object -- the call's own result -- and every `this` in the body is it.
    // A call through a record slot (`list.push( item )` entering the function
    // `WebGLRenderList` stored as `push`) binds `this` to the record.
    const module = ts.isExternalModule(owner.getSourceFile())
    const use = (value: ts.Expression): boolean => onward(value, path)
    return (
      calls.every(({ call, explicitThis }) => {
        if (explicitThis !== null) return false
        if (ts.isNewExpression(call)) return use(call)
        const callee = unwrapValue(call.expression)
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) return publishInto(callee.expression, path)
        return module
      }) && flow.receiverReferencesToDeclaration(owner).every(use)
    )
  }
  /**
   * Every later mention of a binding the walked object was just stored into.
   * Forward only: this arrival came from the object's own allocation, which is
   * where its other aliases are enumerated.
   */
  const forwardCell = (name: ts.Identifier, use: (expression: ts.Expression) => boolean): boolean => {
    const target = flow.targetOf(name)
    const declaration = target?.declaration
    if (!declaration) return false
    if (
      (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) &&
      isModuleExportedDeclaration(checker, declaration, target.symbol ?? null)
    )
      return false
    const references = flow.referencesToDeclaration(declaration)
    // TEMPORARY diagnostic for root A's real-WebGLRenderer probe -- names
    // which mention of a forwarded cell (e.g. every `_this.` reference) the
    // caller's `use` refuses on. Remove once the real-file refusal is found.
    const watchedForwardCell = process.env['GEA_FORWARD_CELL_DEBUG']
    if (watchedForwardCell !== undefined && (watchedForwardCell === '*' || name.text === watchedForwardCell)) {
      for (const reference of references) {
        const closed = use(reference)
        if (!closed) {
          const file = reference.getSourceFile()
          const line = file.getLineAndCharacterOfPosition(reference.getStart()).line + 1
          console.error(
            `[FORWARD-CELL] ${name.text} open-mention ${file.fileName.split('/').pop()}:${line} [${reference.parent.getText().slice(0, 70).replace(/\s+/g, ' ')}]`
          )
        }
      }
    }
    return references.length > 0 && references.every(use)
  }
  /**
   * A mention of an array whose elements carry the followed value, taken
   * through the intrinsic Array protocol -- or null when this mention is not
   * one the protocol answers (an argument, a binding, a return), so the
   * general arms do.
   *
   * Each method is admitted for what it provably does with the elements: a
   * read yields one (`pop`, `at`, `find`), a copy holds them all at the same
   * path (`slice`, `concat`, `filter`, `splice`'s removed items), a store puts
   * a new one in (whose publication is owed only where the walk arrived
   * backwards), and a callback receives them in named parameter slots. Anything
   * that hands the elements out some other way -- `map`, `reduce`, the
   * iterator methods, a text conversion, an unknown callback -- is refused.
   */
  const elementArm = (reference: ts.Expression, path: MemberPath, steps: readonly (MemberPath | null)[]): boolean | null => {
    // Every element hop is minted where its object was proven an Array -- an
    // array literal, a store through the intrinsic protocol, a numeric index
    // on an array-valued receiver, a rest frame -- and the walk follows that
    // same object. A path whose every head is an element needs no second
    // proof here, and asking the checker again refused three's `any`-typed
    // `currentRenderList.opaque` and `listArray`. A summary that may be at a
    // record as well asks the origins.
    const established = headsOf(path).every((id) => id === '[]')
    if (!arrayValued(reference)) {
      if (!established) return null
      // A summary of repeated element hops can claim one hop more than the
      // object at this position has: `grid[ 0 ][ 0 ]` in `const grid = [ [ new
      // Part() ] ]` is followed with the same `[]*` node its arrays are. A
      // value the checker types as a definite non-array holds no elements this
      // path can name, and the general container arms below answer for it --
      // `grid[ 0 ][ 0 ].owner = held` is then a store, not an array operation.
      if (definiteNonArray(reference)) return null
    }
    if (!arrayProtocolClosedAt(reference, established)) return traceReceiver(reference, 'element', false, () => 'protocol-open')
    const use = (expression: ts.Expression): boolean => containerUse(expression, path)
    const element = (expression: ts.Expression): boolean => steps.every((continuation) => onward(expression, continuation))
    const obligations = storeObligations(path, ELEMENT_READ)
    const stored = (value: ts.Expression): boolean => obligations.every((continuation) => publishInto(value, continuation))
    const parent = reference.parent
    if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
      if (!numericArrayIndex(parent.argumentExpression))
        return traceReceiver(reference, 'element', false, () => `non-numeric-index=${parent.argumentExpression.getText().slice(0, 40)}`)
      const context = parent.parent
      if (ts.isBinaryExpression(context) && context.left === parent && context.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return stored(context.right)
      return element(parent)
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      const context = parent.parent
      if (parent.name.text === 'length') {
        // Only an ASSIGNMENT to `length` changes the array. A comparison
        // spells the read on the left just as often as on the right --
        // `params.length > 0` is how the lowered spread tests emptiness --
        // and reading a length publishes nothing either way.
        const written =
          ts.isBinaryExpression(context) &&
          context.left === parent &&
          context.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          context.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        if (written && ts.isBinaryExpression(context))
          return context.operatorToken.kind === ts.SyntaxKind.EqualsToken && numericArrayIndex(context.right)
        return true
      }
      if (!ts.isCallExpression(context) || context.expression !== parent || context.arguments.some(ts.isSpreadElement))
        return traceReceiver(reference, 'element', false, () => `member-shape=${parent.name.text} in ${ts.SyntaxKind[context.kind]}`)
      if (!intrinsicArrayMember(parent)) return traceReceiver(reference, 'element', false, () => `non-intrinsic=${parent.name.text}`)
      const written = context.arguments
      const numeric = (from: number, to: number = written.length): boolean => written.slice(from, to).every(numericArrayIndex)
      const discarded = ts.isExpressionStatement(context.parent)
      switch (parent.name.text) {
        case 'push':
        case 'unshift':
          return written.every(stored)
        case 'fill':
          return written.length >= 1 && stored(written[0]!) && numeric(1) && (discarded || use(context))
        case 'splice':
          return numeric(0, 2) && written.slice(2).every(stored) && (discarded || use(context))
        case 'slice':
          return written.length <= 2 && numeric(0) && use(context)
        // The arguments' own elements join the result; whatever of them is
        // followed is followed by their own walks.
        case 'concat':
          return use(context)
        case 'pop':
        case 'shift':
          return written.length === 0 && element(context)
        case 'at':
          return written.length === 1 && numeric(0) && element(context)
        case 'reverse':
          return written.length === 0 && (discarded || use(context))
        case 'indexOf':
        case 'lastIndexOf':
        case 'includes':
          return written.length <= 2 && numeric(1)
        case 'sort':
          return written.length === 1 && callbackClosed(written[0]!, [element, element]) && (discarded || use(context))
        case 'forEach':
        case 'some':
        case 'every':
        case 'findIndex':
        case 'findLastIndex':
          return written.length === 1 && callbackClosed(written[0]!, [element, null, use])
        case 'find':
        case 'findLast':
          return written.length === 1 && callbackClosed(written[0]!, [element, null, use]) && element(context)
        case 'filter':
          return written.length === 1 && callbackClosed(written[0]!, [element, null, use]) && use(context)
        // `map` hands every element to the callback exactly as `filter` does,
        // and its result is followed the same way -- which OVER-approximates:
        // the result's elements are the callback's RETURNS, not the receiver's
        // elements, so following it can only ask for more than is owed, never
        // less. `( param ) => param` is the case that makes reading it as the
        // same container the sound reading rather than merely the cheap one.
        //
        // Leaving `map` out of this switch fell through to the blanket `return
        // false` below, and that one missing case is the terminal of the three.js app's
        // largest carrier group: three's logging shim renders its rest frame
        // with `params.map( ( param ) => String( param ) )`, so EVERY object
        // handed to `error( ... )` escaped there -- including `object` at
        // `Object3D.add`'s self-parenting guard. That refused `add`'s implicit
        // `arguments` frame `function-escapes:uncounted-member-reference`,
        // which left `Object3D.children`'s element unbound, which is 1496 of
        // the three.js app's 3718 nested dynamic carriers.
        case 'map':
          return written.length === 1 && callbackClosed(written[0]!, [element, null, use]) && use(context)
      }
      // NAME the member. A built-in this switch does not model is the one shape
      // whose fix is a single `case`, and the bare `return false` here gave the
      // walk's report nothing to name: `map` sat unmodelled behind it holding
      // 1496 of the three.js app's nested carriers open, indistinguishable from a real
      // escape.
      return traceReceiver(reference, 'element', false, () => `unmodelled-member=${parent.name.text}`)
    }
    if (ts.isForOfStatement(parent) && parent.expression === reference) {
      if (!ts.isVariableDeclarationList(parent.initializer)) return false
      return (
        parent.initializer.declarations.length === 1 &&
        parent.initializer.declarations.every(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            flow.writesToDeclaration(declaration).some((write) => write.edge === 'iteration-binding' && write.site === declaration) &&
            flow.referencesToDeclaration(declaration).every((mention) => mention === declaration.name || element(mention))
        )
      )
    }
    // `const [ first, second ] = list` reads elements through the intrinsic
    // iterator, whose closure the protocol plan already carries.
    if (ts.isVariableDeclaration(parent) && parent.initializer === reference && ts.isArrayBindingPattern(parent.name))
      return parent.name.elements.every(
        (binding) =>
          ts.isOmittedExpression(binding) ||
          (!binding.dotDotDotToken &&
            !binding.initializer &&
            ts.isIdentifier(binding.name) &&
            flow.referencesToDeclaration(binding).every((mention) => mention === binding.name || element(mention)))
      )
    if (ts.isSpreadElement(parent) && parent.expression === reference && ts.isArrayLiteralExpression(parent.parent))
      return !destructuringTarget(parent.parent) && use(parent.parent)
    if (ts.isCallExpression(parent) && parent.arguments.includes(reference)) {
      const callee = unwrapValue(parent.expression)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'isArray') {
        const owner = unwrapValue(callee.expression)
        const global = ts.isIdentifier(owner) ? checker.getSymbolAtLocation(owner) : undefined
        if (owner.getText() === 'Array' && (global?.declarations ?? []).every((entry) => entry.getSourceFile().isDeclarationFile))
          return true
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'concat' &&
        !parent.arguments.some(ts.isSpreadElement) &&
        intrinsicArrayMember(callee) &&
        arrayValued(callee.expression) &&
        arrayProtocolClosedAt(callee.expression)
      )
        return use(parent)
    }
    return null
  }
  const containerFamilies = new Map<ts.Declaration, ReadonlySet<SourceClass> | null>()
  /**
   * The closed class family an object carrying `member` belongs to, or null
   * when this program cannot enumerate it.
   */
  const containerFamilyOf = (member: ts.Declaration): ReadonlySet<SourceClass> | null => {
    const held = containerFamilies.get(member)
    if (held !== undefined) return held
    // A member published by `this.<key> = ...` inside a constructor function
    // is owned by that function exactly as a `ts.ClassElement` is owned by its
    // class. Asking only for a class-spelled ancestor is what left every
    // member of three's pre-ES6 renderer factories with no container family at
    // all, and a null family refuses every proof that consults it.
    const owner = ts.findAncestor(
      member,
      (node) => ts.isClassDeclaration(node) || ts.isClassExpression(node) || isConstructorFunction(node)
    )
    const family =
      owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner) || isConstructorFunction(owner))
        ? (ownedClassReceiverInventoryOf(checker, flow, new Set([owner]))?.classes ?? null)
        : null
    containerFamilies.set(member, family)
    return family
  }
  /**
   * Whether a named read on the object currently being followed can name
   * nothing at all -- no class in its closed family declares the key.
   *
   * A read that resolves to no declaration is usually refused because an
   * accessor could hand the receiver's other members out. A key the family does
   * not declare has no accessor to be: the read evaluates to `undefined` and
   * runs nothing. Three's logging shim probes `stackTrace.isStackTrace` on
   * whatever it was handed, and every object reaching it there is an `Object3D`
   * that declares no such member -- which made the probe the terminal of 35
   * escapes.
   */
  const absentFromContainerFamily = (path: MemberPath, key: string): boolean => {
    if (path.member === null) return false
    const family = containerFamilyOf(path.member)
    if (family === null || family.size === 0) return false
    return [...family].every((owner) => {
      const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
      return symbol !== undefined && checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), key) === undefined
    })
  }
  /**
   * Whether converting the object currently being followed into text runs no
   * source code -- so the conversion cannot reach what this walk carries
   * inside it.
   *
   * The static type at a conversion site is often `any` (three's logging shim
   * takes `...params`), which says nothing. The PATH does: it names the member
   * the value sits in, and therefore the closed family of objects that carry
   * it. Every class in that family answering only the host's own `toString`,
   * `valueOf` and `@@toPrimitive` is the whole obligation.
   */
  const familyCoercionIsHost = (path: MemberPath): boolean => {
    // An element step names no member of its own; the family that matters is
    // the one owning the first member the chain does name.
    let named: MemberPath | null = path
    while (named !== null && named.kind === 'element') named = named.tail
    // A summary can be at any of several objects; no one family owns it.
    if (named === null || named.kind === 'summary' || named.member === null) return false
    const family = containerFamilyOf(named.member!)
    if (family === null || family.size === 0) return false
    return [...family].every((owner) => {
      const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
      return symbol !== undefined && coercionHooksAreHost(checker, checker.getDeclaredTypeOfSymbol(symbol))
    })
  }
  const uncallableCallees = new Map<ts.Node, boolean>()
  /**
   * Whether a call through a mutable binding can execute anything at all.
   *
   * `_setConsoleFunction( 'warn', message, ...params )` in three's logging shim
   * hands its arguments to whatever that module-level `let` holds -- and it
   * holds `null`, because `setConsoleFunction` is the only thing that writes it
   * and this program never calls it, so reachability prunes that write with the
   * rest of the function. A call through a binding whose every settled value is
   * `null` or `undefined` throws at the call and reaches no body: it publishes
   * nothing. Refusing it instead made that one spread the terminal of 35
   * escapes.
   */
  const callThroughUncallableBinding = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const callee = unwrapNaming(call.expression)
    // The same fact for a MEMBER slot: three's `Texture` declares `this.onUpdate
    // = null` and nothing in the three.js app ever stores a function there, so `if (
    // texture.onUpdate ) texture.onUpdate( texture )` in WebGLTextures runs no
    // body -- yet `targets:no-member-implementations` refused it, and with an
    // opaque `texture` the host-mutation census read the call as an
    // unauthenticated callee handed an opaque argument: a `*` wildcard. A
    // slot whose declaration and every write hold only `null`/`undefined`
    // has nothing to enter; a computed store the index attributes to the
    // slot carries its value here too, so an unproven key set keeps the
    // slot callable and the refusal stands.
    const declaration = ts.isIdentifier(callee)
      ? flow.targetOf(callee)?.declaration
      : ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? fieldDeclaration(callee)
        : undefined
    if (!declaration) return false
    const held = uncallableCallees.get(declaration)
    if (held !== undefined) return held
    const nonCallable = (value: ts.Expression | null | undefined): boolean => {
      if (!value) return false
      const inner = unwrapNaming(value)
      if (inner.kind === ts.SyntaxKind.NullKeyword) return true
      return (
        ts.isIdentifier(inner) &&
        inner.text === 'undefined' &&
        (checker.getSymbolAtLocation(inner)?.declarations ?? []).every((entry) => entry.getSourceFile().hasNoDefaultLib)
      )
    }
    const initial = ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? declaration.right
        : ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
          ? declaration.initializer
          : undefined
    const answer =
      initial !== undefined &&
      nonCallable(initial) &&
      flow.writesToDeclaration(declaration).every((write) => write.slot === 'whole' && nonCallable(write.value))
    uncallableCallees.set(declaration, answer)
    return answer
  }
  const containerUse = (reference: ts.Expression, path: MemberPath): boolean => {
    let table = containerAnswers.get(path)
    if (!table) containerAnswers.set(path, (table = new Map()))
    return coinduct(table, reference, () => {
      const outer = walkFrame
      const reports = leafReports
      walkFrame = openWalkAnswers
      const closed = containerUseBody(reference, path)
      if (!closed) onOpenUse?.(reference, 'containing-object')
      const traced =
        closed || leafReports === reports ? traceReceiver(reference, 'container', closed, () => `heads=${headsOf(path).join(',')}`) : closed
      if (!closed) openWalkAnswers += 1
      walkFrame = outer
      return traced
    })
  }
  /** The container walk's member arm for one named slot `key` of the carried
   * object read or written at `parent`: a computed access with a finite key
   * set is asked once per name. */
  /** The key-read plan of `key` on the family `reference` belongs to when no
   * class on it runs code for the key (data or absent everywhere). */
  const codeFreeKeyPlanOf = (reference: ts.Expression, key: string): SourceClassKeyReadPlan | null => {
    const held = receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference)
    const receiver = checker.getBaseConstraintOfType(held) ?? held
    const plan = sourceClassKeyReadPlanOf(
      checker,
      flow,
      { kind: 'value', receiver, expression: reference, originsOf: allocationOriginsOf },
      key
    )
    return plan !== null && plan.codeFree ? plan : null
  }
  const containerMemberUse = (
    reference: ts.Expression,
    parent: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    key: string,
    path: MemberPath,
    use: (expression: ts.Expression) => boolean
  ): boolean => {
    const declaration = key === accessKeyOf(parent) ? fieldDeclaration(parent) : fieldDeclarationOf(reference, key)
    const read: SlotRead = { element: false, declaration, key }
    // An accessor slot runs user code with the carried object bound as its
    // receiver: `this.needsUpdate = true` in three's `Texture.copy` is a
    // CALL of the setter, and the read of a getter is a call of the getter.
    // Their bodies are right there to walk the way a method body is walked
    // (`methodReceiverUses`); refusing them as "not a data member" stopped
    // every family walk that reached `Texture.copy` through the clone.
    // The stored value goes to the setter's parameter, not into the
    // container, so only the bodies' receiver mentions matter. The flow
    // index resolves the access to the special-assignment form it indexed
    // (`declaration` is that write), which is why the accessor question is
    // asked of the receiver's stated type and its descendants directly.
    // A descendant may re-declare the key as an accessor over a base data
    // slot; then the runtime type selects, and both the bodies and the
    // data-store arms below must hold.
    const accessorBodies =
      key === null ? [] : accessorKindsAt(parent).flatMap((kind) => virtualAccessorsOf(parent.expression, key).get(kind) ?? [])
    if (accessorBodies.length > 0) {
      if (!accessorBodies.every((body) => body.body !== undefined && flow.receiverReferencesToDeclaration(body).every(use)))
        return traceReceiver(reference, 'container-accessor', false, () => `key=${key} bodies=${accessorBodies.length}`)
      if (statedAccessorAt(parent.expression, key!)) return true
    }
    const assignment = parent.parent
    if (ts.isBinaryExpression(assignment) && assignment.left === parent && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // A store into the object the walk carries changes which value sits in
      // that slot; it hands the object to nobody. A store into a slot whose
      // stores are owed may be putting in the very object that holds the
      // followed value, so that value is published there too.
      // NAME both halves. `object.parent = this` in `Object3D.add` is the
      // deepest open use in the three.js app's whole member-closure chain, and both
      // refusals here were bare `false`: the walk's report could not say
      // whether the slot failed to be a data member or whether publishing
      // the stored value failed.
      //
      // `mesh.onBeforeRender = function ( renderer, object ) { ... }`
      // installs a CALLABLE, not a data value: it changes which function
      // answers `mesh.onBeforeRender()`, never what `mesh` itself carries
      // or where it can be reached from. That question is a member-slot
      // publication, already the obligation `escapeReason`'s own
      // `inlineMemberPublication` arm and `memberImplementationsOf` place on
      // the member symbol -- not a data mutation this data-member check was
      // built to police. Refusing here for "not a data member" duplicated
      // that obligation under the wrong lens and made a sound override look
      // like an untracked write.
      if (ts.isFunctionExpression(assignment.right) || ts.isArrowFunction(assignment.right)) return true
      if (!constructionDataMemberOf(reference, key) && !codeFreeKeyPlanOf(reference, key))
        return traceReceiver(
          reference,
          'container-store',
          false,
          () => `key=${key} not-a-data-member declaration=${declaration === null ? 'none' : ts.SyntaxKind[declaration.kind]}`
        )
      return (
        storeObligations(path, read).every((continuation) => publishInto(assignment.right, continuation)) ||
        traceReceiver(reference, 'container-store', false, () => `key=${key} stored-value-open`)
      )
    }
    if (constructorValueRead(parent)) return true
    // This path follows the same object through aliases and call frames.
    // Structural formals can give its unchanged runtime key a new symbol.
    const continuations = stepPath(path, read)
    if (continuations.length > 0) return continuations.every((continuation) => onward(parent, continuation))
    if (!siblingKeyed(path, key))
      return traceReceiver(
        reference,
        'container-member',
        false,
        () => `key=${key} declaration=${declaration !== null} heads=${headsOf(path).join(',')}`
      )
    if (declaration === null && absentFromContainerFamily(path, key)) return true
    const called = ts.isCallExpression(parent.parent) && parent.parent.expression === parent
    const declarations = siblingDeclarationsOf(reference, key)
    if (declarations === null) {
      // `this[ key ]` in three's `Texture.setValues` with `wrapR` among the
      // keys: a plain texture has no such member and the read is
      // `undefined`, while a `Data3DTexture` holds data there. The
      // data-member plan refuses a key absent on any owner; the key-read
      // plan classifies each class, and a code-free family -- data or
      // absent everywhere, `Object.prototype` proven clean for the key --
      // reads only its data carriers.
      const plan = called ? null : codeFreeKeyPlanOf(reference, key)
      if (plan !== null) return plan.carriers.every(({ declaration }) => siblingReadClosed(declaration, () => true, use))
      return traceReceiver(reference, 'container-member', false, () => `key=${key} no-declaration`)
    }
    if (called) return declarations.every((entry) => methodReceiverUses(entry, use))
    return declarations.every((entry) => siblingReadClosed(entry, () => constructionDataMemberOf(reference, key), use))
  }
  const containerUseBody = (reference: ts.Expression, path: MemberPath): boolean => {
    const use = (expression: ts.Expression): boolean => containerUse(expression, path)
    // A mention the checker has narrowed to a primitive is not a mention of the
    // object being followed: a primitive holds no members, so nothing this walk
    // carries can be read out of it or stored back into it. Three's logging
    // shim inspects its first argument under `typeof message === 'string'`, and
    // treating that guarded read as a use of whatever else the slot might hold
    // made `message.startsWith` the terminal of 35 escapes.
    if (primitive(checker.getTypeAtLocation(reference))) return true
    const parent = reference.parent
    if (!parent) return false
    if (ts.isBinaryExpression(parent) && parent.left === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // A plain assignment's left side names the SLOT being written. It is not
      // evaluated as a value, so it hands nothing to anyone -- `this.geometry
      // = geometry` in three's `Mesh` was read as a use of whatever
      // `this.geometry` held and was the terminal of 35 escapes. (A compound
      // assignment does read the slot first, which is why only `=` is here.)
      if (ts.isPropertyAccessExpression(reference) || ts.isElementAccessExpression(reference)) return true
      if (!ts.isIdentifier(reference)) return false
      const declaration = flow.targetOf(reference)?.declaration
      return declaration !== undefined && declaration !== null && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return use(parent)
    if (ts.isBindingElement(parent) && parent.name === reference) return true
    // A member's own declaration name is where the member is written down,
    // not a mention of the object that carries it. `Mesh` declares `geometry;`
    // as a bare typed field, and reading that name as a receiver use left it
    // unexplained -- the terminal of 35 escapes.
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === reference
    )
      return true
    const bindingReads = objectBindingReadsOf(flow, reference)
    if (bindingReads !== null)
      return bindingReads.every(({ key, binding }) => {
        const declaration = fieldDeclarationOf(reference, key)
        const continuations = stepPath(path, { element: false, declaration, key })
        if (continuations.length > 0)
          return continuations.every((continuation) =>
            flow.referencesToDeclaration(binding).every((mention) => mention === binding.name || onward(mention, continuation))
          )
        if (!siblingKeyed(path, key)) return false
        const declarations = siblingDeclarationsOf(reference, key)
        return (
          declarations !== null &&
          declarations.every((entry) => siblingReadClosed(entry, () => constructionDataMemberOf(reference, key), use))
        )
      })
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
      if (parent.name === reference) return true
      if (parent.initializer === reference && ts.isIdentifier(parent.name)) return forwardCell(parent.name, use)
    }
    const erased = outermostErasureOf(reference)
    if (erased !== reference && ts.isExpression(erased)) return use(erased)
    const publication = publishedValue(reference, path)
    if (publication !== null) return publication
    if (ts.isReturnStatement(parent) && parent.expression === reference) {
      const owner = ts.findAncestor(parent, ts.isFunctionLike)
      return owner !== undefined && factoryResult(owner, use)
    }
    const steps = stepPath(path, ELEMENT_READ)
    if (steps.length > 0) {
      const elements = elementArm(reference, path, steps)
      if (elements !== null) return elements
    }
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference) {
      const key = accessKeyOf(parent)
      if (key !== null) return containerMemberUse(reference, parent, key, path, use)
      // `this[ key ]` in three's `Texture.setValues`: a computed key whose
      // set this program proves finite is every one of those named reads
      // or stores, exactly as the receiver walk's `computed-data-store` arm
      // reads it. A key set that stays open is the refusal below.
      if (ts.isElementAccessExpression(parent)) {
        const names = computedKeySetOf(checker, flow, parent.argumentExpression, computedKeyAuthority)
        if (names !== null) return [...names].every((name) => containerMemberUse(reference, parent, name, path, use))
      }
      return traceReceiver(reference, 'container-member', false, () => `key=null heads=${headsOf(path).join(',')}`)
    }
    if (ts.isBinaryExpression(parent) && parent.right === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return ts.isIdentifier(parent.left) && forwardCell(parent.left, use) && (ts.isExpressionStatement(parent.parent) || use(parent))
    }
    if (ts.isSpreadElement(parent) && parent.expression === reference) {
      if (ts.isCallExpression(parent.parent) && callThroughUncallableBinding(parent.parent)) return true
      const spread = hostTextSinkArgumentOf(checker, reference)
      if (spread !== null) return spread || familyCoercionIsHost(path)
    }
    // `super( ... )` is dispatch on the object this frame already owns, exactly
    // as the receiver walk reads it (its arm below): it hands the container
    // to nobody. Read as a call ARGUMENT it went to `forwardedInvocationUse`,
    // matched no parameter and refused -- three's `RenderTarget` constructor
    // opens with `super()`, and every owed `.textures` head stopped there.
    if (reference.kind === ts.SyntaxKind.SuperKeyword && ts.isCallExpression(parent) && parent.expression === reference) return true
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (callThroughUncallableBinding(parent)) return true
      const definition = ts.isCallExpression(parent) ? dataDefinitionUse(reference, use, path) : null
      if (definition !== null) return definition
      if (ts.isCallExpression(parent) && ownKeyQueryUse(parent, reference)) return true
      const rendered = ts.isCallExpression(parent) ? hostTextSinkArgumentOf(checker, reference) : null
      if (rendered !== null) return rendered || familyCoercionIsHost(path)
      const storedReads = ts.isCallExpression(parent)
        ? collectionValueContinuationsOf(checker, flow, parent, reference, nativeProtocolClosed)
        : null
      if (storedReads !== null) return storedReads.every(use)
      // `updateMap.set( object, frame )` in three's `WebGLObjects.update`: a
      // closed native map compares its key by identity and never yields it back.
      if (ts.isCallExpression(parent) && collectionKeyArgumentIsInert(checker, flow, parent, reference, nativeProtocolClosed)) return true
      const stored = arrayStoreArgumentUse(parent, reference, path)
      if (stored !== null) return stored
      return forwardedInvocationUse(reference, parent, use, path)
    }
    // `a && b`, `a || b`, `a ?? b` and `c ? a : b` select one operand and
    // return it. ToBoolean and the nullish test execute no user code, so the
    // only thing that leaves is whatever the expression evaluates to -- follow
    // that, and nothing else. Three's logging shim guards its optional stack
    // trace with `stackTrace && stackTrace.isStackTrace`, and refusing the
    // whole shape made that test the terminal of 35 escapes.
    if (
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isConditionalExpression(parent) && (parent.whenTrue === reference || parent.whenFalse === reference))
    )
      return use(parent)
    return inertReceiverUse(reference)
  }
  const ownerAnswers = new Map<string, Answer>()
  /**
   * Whether every object carrying the proved member is walked from where it
   * was allocated. A data read of an object-valued member can hand back its
   * own holder (`this.self = this`), and only a walk from the allocation sees
   * the store that made the backlink.
   *
   * A member written in a class: every construction and field initializer.
   * A record slot -- three's `WebGLRenderList` returns `{ push: push, ... }`
   * -- the literal itself. A slot written through a receiver (`leaf.onDraw =
   * fn`): that receiver's allocations. Coinductive, so an answer that leaned
   * on this one is kept only once this one holds; the tri-state it replaces
   * handed `true` to every re-entry and never took it back.
   */
  /** The carrier a member-less proof answers `ownerOriginsClosed` from: for a
   * `this`/`super` read the enclosing class element (its class IS the family
   * the receiver belongs to), else the data declaration the read selects. */
  const originsCarrierOf = (reference: ts.Expression, declaration: ts.Node | null): ts.Node | undefined => {
    if (reference.kind === ts.SyntaxKind.ThisKeyword || reference.kind === ts.SyntaxKind.SuperKeyword) {
      const owner = flow.receiverOwnerOf(reference)
      if (owner && ts.isClassElement(owner)) return owner
    }
    return declaration ?? undefined
  }
  const ownerOriginsClosed = (carrier?: ts.Node): boolean => {
    // A proof with no member slot and no field owners is a receiver-family
    // proof (`classInstancesUse`): what it follows is the family's instances
    // themselves. A data read inside it -- `this.blendColor` in `Material.copy`,
    // reached from `new this.constructor().copy( this )` -- has no slot to
    // name an owner by, so the CARRIER of the data it selects (the `this.<key>
    // = ...` write or class element) stands in: its own receiver is the family
    // whose origins the question is about. Without it this answered false for
    // every object-valued read in every family proof.
    //
    // A MEMBER proof's own class is the right scope for a read reached
    // directly inside `member`'s own body -- but the walk can cross into a
    // DIFFERENT declaration's body first: an accessor inherited from a base
    // class, its `this` still the same receiver, reached while proving
    // `member` closed. `RenderTarget`'s `get texture()` -- read through
    // `WebGLCubeRenderTarget.fromEquirectangularTexture`'s `this.texture` --
    // asked whether `this.textures` (a `RenderTarget` field the subclass never
    // itself writes) escapes through `member`'s own class alone, which has no
    // writer to walk and so answered "open" for every accessor read reached
    // this way. The carrier -- the accessor `get`/`set` itself -- names the
    // family the read is actually about whenever that differs from every
    // class `member` is declared on; when it is the same class (the ordinary
    // case, a field read straight out of `member`'s own body) `member`'s scope
    // still wins, unchanged.
    const carrierOwner = carrier !== undefined ? memberOwnerClassOf(carrier) : null
    const memberOwnsCarrier =
      carrierOwner !== null && (member?.declarations ?? []).some((declaration) => memberOwnerClassOf(declaration) === carrierOwner)
    const carried =
      (valueMode?.field?.owners.size ?? 0) === 0 && carrier !== undefined && (!member || (carrierOwner !== null && !memberOwnsCarrier))
        ? carrier
        : undefined
    return coinduct(ownerAnswers, carried ? `owner:${declarationIdOf(carried as ts.Declaration)}` : 'owner', () => {
      const roots = new Set<SourceClass>(valueMode?.field?.owners)
      for (const declaration of carried ? [carried] : (member?.declarations ?? [])) {
        // A literal entry is carried by that literal, even one written inside
        // a class method: the literal, not the class, is what gets allocated.
        if (
          (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration) || ts.isMethodDeclaration(declaration)) &&
          ts.isObjectLiteralExpression(declaration.parent)
        ) {
          if (!receiverUse(declaration.parent)) return false
          continue
        }
        const owner = memberOwnerClassOf(declaration)
        if (owner !== null) {
          roots.add(owner)
          continue
        }
        const left = ts.isBinaryExpression(declaration) ? declaration.left : undefined
        if (left && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) {
          if (!publishInto(left.expression, null)) return false
          continue
        }
        return false
      }
      // Every carrier was a literal or a receiver walked above: no class
      // allocates one, and there is no inventory left to ask. (Asking it of no
      // class answers "unknown", which refused every member only literals
      // carry -- three's `ColorManagement` methods reading `this.spaces`.)
      if (roots.size === 0) return carried !== undefined || (member?.declarations?.length ?? 0) > 0
      // An OUTER proof is already answering for this family: park it. Only the
      // inherited set counts -- parking on this proof's own entry would make
      // the question answer itself without ever walking the inventory.
      if ([...roots].every((root) => activeFamilies.has(root))) {
        for (const root of roots) noteAssumption(root)
        return true
      }
      // All owner publications in constructors/field initializers must close,
      // including allocations with no visible call to the method being typed.
      // `openMember` NAMES which of the three failed: `family-origins-open` is
      // the three.js app's largest member-closure refusal and it used to report only
      // that the whole conjunction did, when an unbuildable inventory, an
      // initializer's `this` and a construction site are three different
      // defects with three different fixes.
      return familyReceiversClosed(roots, receiverUse, openMember)
    })
  }
  const receiverCell = (expression: ts.Expression): boolean => {
    // `super` is the same OBJECT `this` is. 13.3.7 resolves `super.m` against
    // the home object's prototype rather than against the receiver, so what it
    // changes is which body runs -- never which object the call is made on.
    // Asking the enclosing method the same question `this` asks is therefore
    // the whole answer, and the C++ target already reads the pair this way:
    // `ir/lower.ts` mints a receiver operation for `this` at the frame's own
    // class and for `super` at the base's, and `emit-class-properties.ts`
    // tells them apart by exactly that.
    //
    // Without this, `super.copy( source )` -- every three.js `copy`/`clone`
    // override -- was an unresolvable receiver, and the whole containing
    // family's parameters went unbound behind it.
    if (expression.kind === ts.SyntaxKind.ThisKeyword || expression.kind === ts.SyntaxKind.SuperKeyword) {
      const owner = flow.receiverOwnerOf(expression)
      const answer = owner !== null && ts.isFunctionLike(owner) && factoryResult(owner)
      if (owner !== null && ts.isFunctionLike(owner))
        traceReceiver(
          expression,
          'receiver-cell:this',
          answer,
          () =>
            `owner=${ts.SyntaxKind[owner.kind]}:${(owner as { name?: ts.Node }).name?.getText() ?? '-'} callers=${closedCallerSitesOf(owner)?.length ?? 'null'} member=${member?.getName()}`
        )
      return answer
    }
    // A FRESH allocation has no cell to walk: nothing else holds the object,
    // so the expression IS the value and its own uses are the whole inventory.
    // Asking `flow.targetOf` for a declaration and refusing when there is none
    // treated `new this.constructor().copy( this )` -- every three.js `clone`
    // -- as an unresolvable receiver, when it is the most closed receiver
    // there is. An object literal was already read this way at the receiver
    // inventory below; this states the same fact for the constructed case,
    // where the allocation's own uses answer it.
    if (ts.isNewExpression(expression)) return receiverUse(expression)
    const target = flow.targetOf(expression)
    // A receiver that names no cell -- `list[ i ].onDraw` -- is some object
    // read out of somewhere: find where each was allocated and walk from
    // there.
    if (!target?.declaration) return publishInto(expression, null)
    const mentions = cellMentionsOf(target.declaration, target.symbol)
    return mentions !== null && mentions.length > 0 && mentions.every(receiverUse)
  }
  /**
   * Every mention of a cell, importers' included, or null when code outside
   * the program can read it.
   *
   * An export is a mention no expression spells, so it stays open unless
   * `inProgramImportReferencesOf` names every importer's use -- the same
   * obligation `closedCallerSitesOf` discharges for an exported function. An
   * import binding is the exported cell seen from the importer, and is answered
   * as that cell. The bindings themselves (`import { x }`, `export { x }`,
   * `export default x`) evaluate nothing and are not uses. Three's
   * `ColorManagement` is `export const ColorManagement =
   * createColorManagement()`, and refusing every export here was where each
   * of its methods' parameters stopped.
   */
  const cellMentionsOf = (declaration: ts.Node, symbol: ts.Symbol | null): readonly ts.Expression[] | null => {
    let cell = declaration
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
      const name = declaration.name
      const resolved = name ? resolveFlowSymbolAlias(checker, checker.getSymbolAtLocation(name))?.valueDeclaration : undefined
      if (!resolved || !ts.isVariableDeclaration(resolved) || resolved.getSourceFile().isDeclarationFile) return null
      cell = resolved
    }
    if (
      !(ts.isVariableDeclaration(cell) || ts.isBindingElement(cell)) ||
      !isModuleExportedDeclaration(checker, cell, cell === declaration ? symbol : null)
    )
      return cell === declaration ? flow.referencesToDeclaration(cell as ts.Declaration) : null
    if (!ts.isVariableDeclaration(cell) || !ts.isIdentifier(cell.name)) return null
    const imported = inProgramImportReferencesOf(checker, flow, cell)
    if (imported === null) return null
    return [...new Set([...flow.referencesToDeclaration(cell), ...imported])].filter((mention) => {
      const parent = mention.parent
      return !(
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isExportSpecifier(parent) ||
        (ts.isExportAssignment(parent) && !parent.isExportEquals)
      )
    })
  }
  const sameMember = (expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean => {
    if (!member) return false
    if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression && countedCalls.has(expression.parent))
      return true
    const target = flow.targetOf(expression)
    const key = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text
        : null
    const receiver = receiverTypeAt(expression.expression)
    const inferred = receiver && key !== null ? checker.getPropertyOfType(checker.getApparentType(receiver), key) : undefined
    if (inferred === member || inferred?.declarations?.some((declaration) => (member.declarations ?? []).includes(declaration))) return true
    const declared = fieldDeclaration(expression)
    if (declared !== null && (member.declarations ?? []).includes(declared)) return true
    // An ordinary function's untyped parameter need not have a checker
    // member symbol. Its complete incoming allocations can still identify
    // the same class slot. Keep both obligations: the receiver belongs to
    // that family and no accessor or unknown replacement occupies the slot.
    if (
      key === member.name &&
      (member.declarations ?? []).some(
        (declaration) => memberImplementationsOf(declaration) !== null && receiverInFamily(expression.expression, declaration)
      )
    )
      return true
    return (
      target !== null &&
      (target.symbol === member ||
        target.nameSymbol === member ||
        (target.declaration !== null && (member.declarations ?? []).includes(target.declaration as ts.Declaration)))
    )
  }
  const receiverUse = (reference: ts.Expression): boolean =>
    coinduct(receiverAnswers, reference, () => {
      const outer = walkFrame
      const reports = leafReports
      walkFrame = openWalkAnswers
      const closed = receiverUseBody(reference)
      if (!closed) {
        // Only when no NAMED arm already reported: an arm's own line carries
        // its reason, and a second bare `receiver` line for the same refusal
        // would double-count it in the ranking.
        if (leafReports === reports) leafRefusal(reference, 'receiver')
        openWalkAnswers += 1
        onOpenUse?.(reference, 'receiver')
      }
      walkFrame = outer
      return closed
    })
  const watchedReceiver = process.env.GEA_RECEIVER_DEBUG
  const watchedReceiverFamily = process.env.GEA_RECEIVER_FAMILY_DEBUG
  /**
   * ⛔ `detail` is a THUNK, not a string. These detail strings call
   * `closedCallerSitesOf`, `nativeProtocolClosed` and `getText()` on whole
   * class bodies -- full proofs and full source materialisations -- and an
   * eagerly evaluated argument pays for all of it on every walk step even
   * when nothing is being traced. Passing a string here is a performance bug.
   */
  const traceReceiver = (reference: ts.Expression, arm: string, result: boolean, detail?: () => string): boolean => {
    // A NAMED arm that refuses without having raised a refusal of its own is
    // the cause, not a link -- so leaf mode reports it here, with its arm and
    // its detail, rather than leaving `leafRefusal` to say only which of the
    // three walks stopped. Answering "which arm" used to cost one filtered
    // `GEA_RECEIVER_DEBUG` run per site; this answers every site in one.
    if (!result && watchedLeaf !== undefined && openWalkAnswers === walkFrame)
      leafRefusal(reference, `${arm}${detail ? ` ${detail()}` : ''}`)
    if (watchedReceiver === undefined) return result
    const file = reference.getSourceFile()
    const line = file.getLineAndCharacterOfPosition(reference.getStart()).line + 1
    const site = `${file.fileName.split('/').pop()}#${line}`
    if (watchedReceiver === '*' || site === watchedReceiver || file.fileName.split('/').pop() === watchedReceiver)
      console.error(
        `[RECEIVER] ${site} ${reference.parent.getText().slice(0, 60).replace(/\s+/g, ' ')} ${arm}=${result}${detail ? ` ${detail()}` : ''}`
      )
    return result
  }
  const watchedLeaf = watchedLeafDebug
  /**
   * A refusal that raised no refusal of its own: the bottom of a chain.
   *
   * `GEA_RECEIVER_DEBUG='*'` emits ~10M lines because it reports every LINK,
   * and the links are the same handful of causes restated once per site in a
   * strongly connected component. This reports only the ends, with the member
   * whose proof was asking, so `sort | uniq -c` ranks CAUSES rather than
   * sites. Two investigations misattributed the same terminal from the link
   * trace alone.
   */
  const leafRefusal = (reference: ts.Expression, arm: string): void => {
    if (watchedLeaf === undefined || openWalkAnswers !== walkFrame) return
    const file = reference.getSourceFile()
    const name = file.fileName.split('/').pop() ?? file.fileName
    if (watchedLeaf !== '*' && watchedLeaf !== '1' && name !== watchedLeaf) return
    leafReports += 1
    const owner = member?.declarations?.[0]?.parent
    const owning = owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) ? (owner.name?.text ?? '(anonymous)') : '-'
    const line = file.getLineAndCharacterOfPosition(reference.getStart()).line + 1
    // `arm` sometimes carries an appended detail string (from `traceReceiver`);
    // only the leading word names which of the walk's named checks this is.
    recordLeafSummary(arm.split(' ', 1)[0] ?? arm, `${owning}.${member?.getName() ?? '-'}`, `${name}#${line}`)
    console.error(
      `[LEAF] ${arm} ${owning}.${member?.getName() ?? '-'} ${name}#${file.getLineAndCharacterOfPosition(reference.getStart()).line + 1} [${reference.getText().slice(0, 70).replace(/\s+/g, ' ')}]`
    )
  }
  const receiverUseBody = (reference: ts.Expression): boolean => {
    const terminal = valueMode?.terminalUse(reference)
    if (terminal !== undefined && terminal !== null) return terminal
    // A mention the checker has narrowed to a primitive is not a mention of the
    // object being followed: a primitive holds no members, so nothing this walk
    // carries can be read out of it or stored back into it. Three's logging
    // shim inspects its first argument under `typeof message === 'string'`, and
    // treating that guarded read as a use of whatever else the slot might hold
    // made `message.startsWith` the terminal of 35 escapes.
    if (primitive(checker.getTypeAtLocation(reference))) return true
    const parent = reference.parent
    if (!parent) return false
    if (ts.isBinaryExpression(parent) && parent.left === reference && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // A plain assignment's left side names the SLOT being written. It is not
      // evaluated as a value, so it hands nothing to anyone -- `this.geometry
      // = geometry` in three's `Mesh` was read as a use of whatever
      // `this.geometry` held and was the terminal of 35 escapes. (A compound
      // assignment does read the slot first, which is why only `=` is here.)
      if (ts.isPropertyAccessExpression(reference) || ts.isElementAccessExpression(reference)) return true
      if (!ts.isIdentifier(reference)) return false
      const declaration = flow.targetOf(reference)?.declaration
      return declaration !== undefined && declaration !== null && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === reference) return receiverUse(parent)
    if (ts.isBindingElement(parent) && parent.name === reference) return true
    if (ts.isPropertyAssignment(parent) && parent.name === reference) return true
    // A member's own declaration name is where the member is written down,
    // not a mention of the object that carries it. `Mesh` declares `geometry;`
    // as a bare typed field, and reading that name as a receiver use left it
    // unexplained -- the terminal of 35 escapes.
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === reference
    )
      return true
    const bindingReads = objectBindingReadsOf(flow, reference)
    if (bindingReads !== null)
      return bindingReads.every(({ key, binding }) => {
        const declaration = fieldDeclarationOf(reference, key)
        if (!declaration || !dataDeclaration(declaration)) return false
        // As at the member-read arm: a literal entry only through the record plan.
        const selected = constructionDataMemberOf(reference, key)
        const value = checker.getTypeAtLocation(binding.name)
        return selected && (primitive(value) || ownerOriginsClosed(originsCarrierOf(reference, declaration)))
      })
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
      if (parent.name === reference) return true
      if (parent.initializer === reference && ts.isIdentifier(parent.name)) return receiverCell(parent.name)
    }
    // The declaration-initializer case above misses a cell DECLARED bare and
    // filled later by a plain assignment -- three's `WebGLRenderer` declares
    // `let properties, textures;` at its own top level, then a nested
    // `initGLContext` assigns `properties = new WebGLProperties();` before
    // publishing it onward (`_this.properties = properties`). The allocation
    // is the SAME cell an initializer would name; only the edge shape differs.
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === reference &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(parent.left)
    ) {
      // The cell is only half of it. An assignment used as an EXPRESSION hands
      // its value on a second time -- `external( alias = renderer )` gives
      // `renderer` to `external` as well as to `alias` -- and answering with
      // the cell alone dropped that edge entirely: `alias` is read nowhere, so
      // the cell is closed, so the receiver was closed, and the parameters of
      // every method on it were typed from the one call this program spells.
      // The complete arm below already stated this and never ran, because this
      // one matches first.
      return receiverCell(parent.left) && (ts.isExpressionStatement(parent.parent) || receiverUse(parent))
    }
    const erased = outermostErasureOf(reference)
    if (erased !== reference && ts.isExpression(erased)) return receiverUse(erased)
    // `Object.assign(receiver, { x: 2 })`: the intrinsic performs one [[Set]]
    // per key its sources spell, and nothing else with the receiver. Each key
    // must be a DATA member of the receiver's family (a setter would run code
    // with the receiver as `this`), and the sources must be literals whose
    // keys can be read off the text -- `JSON.parse('{}')` stays an open use.
    // The call's own value is the receiver again, so a use of that result is
    // a second publication this arm does not follow. The write inventory
    // (`memberSlotWritesClosed`) admits the same spelled-key call; refusing it
    // here as an unexplained argument made this proof stricter than it.
    if (ts.isCallExpression(parent) && parent.arguments[0] === reference) {
      const sources = objectAssignSourcesOf(checker, parent)
      if (sources !== null) {
        return traceReceiver(
          reference,
          'object-assign-spelled-keys',
          ts.isExpressionStatement(parent.parent) &&
            sources.every((source) => {
              const keys = spelledLiteralKeysOf(source)
              if (keys === null) return false
              for (const key of keys) {
                if (key === member?.getName()) return false
                const declaration = fieldDeclarationOf(reference, key)
                if (declaration === null || !dataDeclaration(declaration)) return false
              }
              return true
            })
        )
      }
    }
    const publication = publishedValue(reference, null)
    if (publication !== null) return publication
    if (ts.isReturnStatement(parent) && parent.expression === reference) {
      const owner = ts.findAncestor(parent, ts.isFunctionLike)
      return owner !== undefined && factoryResult(owner)
    }
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === reference) {
      if (constructorValueRead(parent)) return true
      const declaration = fieldDeclaration(parent)
      const invoked = ts.isCallExpression(parent.parent) && parent.parent.expression === parent
      // Receiver publication follows the same target selection as argument
      // and result flow. The normalized callee inventory also includes reads
      // inside `.call`/`.apply`, where lookup and actual receiver differ.
      const invocations = callsOf(flow).callees.get(parent)
      if (invocations?.length)
        return traceReceiver(
          reference,
          'invocation-receiver',
          invocations.every((site) => {
            if (!ts.isCallExpression(site.call)) return false
            const targets = invocationTargetsOf(site.call)
            if (targets === null) return false
            // `.call(other)` reads the member here, but binds `other` as this.
            // Its actual receiver occurrence is followed through that frame.
            return (
              site.operands.receiver !== reference || targets.every((body) => flow.receiverReferencesToDeclaration(body).every(receiverUse))
            )
          })
        )
      if (sameMember(parent)) return traceReceiver(reference, 'same-member', visit(parent))
      const accessed = declaration
      if (accessed !== null && (ts.isGetAccessorDeclaration(accessed) || ts.isSetAccessorDeclaration(accessed))) {
        const key = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : ts.isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : null
        const accessors = key === null ? null : virtualAccessorsOf(parent.expression, key)
        const bodies = accessors === null ? [] : accessorKindsAt(parent).flatMap((kind) => accessors.get(kind) ?? [])
        // An accessor with no body is an ambient declaration: there is nothing
        // to prove, and the implementation behind it is not in this program.
        return (
          bodies.length > 0 &&
          bodies.every((body) => body.body !== undefined && flow.receiverReferencesToDeclaration(body).every(receiverUse))
        )
      }
      // A named data member read does not hand out the containing receiver.
      // A method/accessor or an unknown computed key can execute arbitrary
      // receiver code and requires stronger closure evidence than this proof.
      const target = fieldDeclaration(parent)
      const dataMember = target !== null && dataDeclaration(target)
      const write = parent.parent
      if (ts.isElementAccessExpression(parent) && !invoked) {
        // A key whose every static arm is numeric names no member a source
        // class spells with an identifier: `bag[Date.now()] = 1` through
        // `const bag: any = a` creates or reads an own indexed data property
        // and runs no code -- unless the family itself declares a member
        // under a numeric name, which the checker's property list shows. A
        // store hands the receiver nowhere; a read yields whatever the
        // property holds, and only a family whose origins are closed cannot
        // have stored the receiver itself there. The write inventory admits
        // the same key (`computedKeyMayBeMember`), so refusing it here as an
        // unknown computed key made this proof stricter than the writes.
        if (numericKeyType(checker.getTypeAtLocation(parent.argumentExpression))) {
          const origins = allocationOriginsOf(reference)
          const numericallyNamed = (owner: SourceClass): boolean =>
            checker
              .getTypeAtLocation(owner)
              .getProperties()
              .some((property) => /^\d/.test(property.getName()))
          if (origins !== null && origins.classes.size > 0 && ![...origins.classes].some(numericallyNamed)) {
            if (ts.isBinaryExpression(write) && write.left === parent && write.operatorToken.kind === ts.SyntaxKind.EqualsToken)
              return traceReceiver(reference, 'computed-numeric-store', true)
            if (!callsOf(flow).writeReceivers.has(reference))
              return traceReceiver(reference, 'computed-numeric-read', ownerOriginsClosed(originsCarrierOf(reference, null)))
          }
        }
        // A computed store has the same receiver effect as its named stores
        // when every key selects data on the complete family. Reuse this
        // frame's key proof so a method's inputs and receiver uses discharge
        // their mutual dependency under the existing member-closure guard.
        // Replacing the followed callable itself still needs the slot-write
        // inventory; a finite key set alone cannot authenticate its new value.
        const names = computedKeySetOf(checker, flow, parent.argumentExpression, computedKeyAuthority)
        const heldReceiver = receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference)
        const receiver = checker.getBaseConstraintOfType(heldReceiver) ?? heldReceiver
        const plans =
          names === null
            ? null
            : [...names].map((key) => {
                if (key === member?.getName()) return null
                const plan = sourceClassKeyReadPlanOf(
                  checker,
                  flow,
                  { kind: 'value', receiver: receiver, expression: reference, originsOf: allocationOriginsOf },
                  key
                )
                if (plan !== null) {
                  // An absent declaration can still have an expando holding the
                  // receiver. Only the owner publication proof rules that out.
                  return plan.codeFree ? { primitive: plan.primitive && !plan.needsDefaultPrototype } : null
                }
                if (!constructionDataMemberOf(reference, key)) return null
                const declaration = fieldDeclarationOf(reference, key)
                return { primitive: declaration !== null && primitive(checker.getTypeAtLocation(declaration)) }
              })
        if (plans !== null && plans.every((plan) => plan !== null)) {
          if (ts.isBinaryExpression(write) && write.left === parent && write.operatorToken.kind === ts.SyntaxKind.EqualsToken)
            return traceReceiver(reference, 'computed-data-store', true)
          if (!callsOf(flow).writeReceivers.has(reference)) {
            const primitiveFields = plans.every((plan) => plan.primitive)
            return traceReceiver(reference, 'computed-data-read', primitiveFields || ownerOriginsClosed(originsCarrierOf(reference, null)))
          }
        }
      }
      if (dataMember && ts.isBinaryExpression(write) && write.left === parent && write.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // A JavaScript constructor's implicit field is a BinaryExpression,
        // not a PropertyDeclaration. The write itself does not publish its
        // receiver, provided every constructed receiver's selected member
        // is data: a derived accessor could otherwise execute arbitrary code.
        if (constructionDataMember(parent) || ownLiteralDataMember(parent)) return true
        const key = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : ts.isStringLiteralLike(parent.argumentExpression)
            ? parent.argumentExpression.text
            : null
        const receiver = receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference)
        const plan =
          key === null
            ? null
            : sourceClassKeyReadPlanOf(
                checker,
                flow,
                { kind: 'value', receiver: receiver, expression: reference, originsOf: allocationOriginsOf },
                key
              )
        // A base data declaration can dispatch to a subclass setter. Keep the
        // family classification strict and inspect that write's actual bodies.
        return traceReceiver(
          reference,
          'source-property-store',
          plan !== null &&
            plan.writeBodies !== null &&
            plan.writeBodies.every((body) => flow.receiverReferencesToDeclaration(body).every(receiverUse))
        )
      }
      // `mesh.onBeforeRender = function ( renderer, scene, camera ) { ... }`
      // in three's `WebGLBackground`: a store over a prototype METHOD. The
      // [[Set]] finds the method's data property first and creates an own one
      // on the receiver, running no code -- only a setter could hand the
      // receiver on. The descriptor authority names any setters independently
      // of the callable value stored in this data property. The
      // receiver must be provably one of that family, or its own chain decides.
      if (
        target !== null &&
        ts.isMethodDeclaration(target) &&
        ts.isBinaryExpression(write) &&
        write.left === parent &&
        write.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const key = accessKeyOf(parent)
        const receiver = receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference)
        const plan =
          key === null
            ? null
            : sourceClassKeyReadPlanOf(
                checker,
                flow,
                { kind: 'value', receiver, expression: reference, originsOf: allocationOriginsOf },
                key
              )
        return traceReceiver(
          reference,
          'method-slot-store',
          plan !== null &&
            plan.writeBodies !== null &&
            plan.writeBodies.every((body) => flow.receiverReferencesToDeclaration(body).every(receiverUse))
        )
      }
      // Object-valued data members can point back to their owner, including
      // through a constructor's `self = this`; reading one is not proof that
      // the containing receiver cannot escape through it.
      const value = receiverTypeAt(parent) ?? checker.getTypeAtLocation(parent)
      // A literal entry is taken only through the record plan: the checker
      // names one literal for a structural type that a second literal -- with
      // a getter under the same key -- satisfies just as well.
      const selectedData =
        dataMember && (declaredDataMemberAccess(target!) || constructionDataMember(parent) || ownLiteralDataMember(parent))
      // A getter under this key on SOME class the receiver's declared type
      // could be -- three's `InterleavedBufferAttribute.count`, read off a
      // `BufferAttribute | InterleavedBufferAttribute` parameter -- is not by
      // itself proof that the read escapes: only a getter BODY that leaks the
      // receiver is. `sourceClassKeyReadPlanOf` classifies every class the
      // receiver could be (construction origins first, the declared type
      // otherwise) and, when every accessor under the key has a known body
      // (`readBodies !== null`), hands those bodies back to inspect -- the
      // same authority `method-slot-store` above already trusts for a
      // SETTER's write bodies. Walking them with the identical
      // `receiverReferencesToDeclaration(...).every(receiverUse)` rule
      // answers the read the same way: closed unless the getter's own `this`
      // mentions themselves escape (three's `InterleavedBufferAttribute.count`
      // is `return this.data.count`, which recurses into this same arm for
      // `this.data`). `sourceClassKeyReadPlanOf` only sees the checker's
      // STATIC declared members, so a reflective definition that could
      // install an accessor under this key anywhere refuses this outright,
      // regardless of what the plan itself says.
      //
      // Asked LAZILY, and only after the selected-data answer has refused:
      // the plan classifies the receiver's whole class family and runs the
      // allocation-origins proof for the receiver, and every getter body it
      // hands back is walked through this proof's own `receiverUse`. Asked
      // eagerly at every member read it re-ran that work for the tens of
      // thousands of reads the selected-data arm already accepted -- the three.js app
      // went from ~3 min to over 8 min at 23 GB before this ordering.
      const key = accessKeyOf(parent)
      let readerClosedHeld: boolean | null = null
      const readerClosed = (): boolean => {
        if (readerClosedHeld !== null) return readerClosedHeld
        const plan =
          key === null
            ? null
            : sourceClassKeyReadPlanOf(
                checker,
                flow,
                {
                  kind: 'value',
                  receiver: receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference),
                  expression: reference,
                  originsOf: allocationOriginsOf
                },
                key
              )
        readerClosedHeld =
          key !== null &&
          plan !== null &&
          plan.readBodies !== null &&
          !reflectiveDefinitionMayInstallGetterOf(checker, flow, key) &&
          plan.readBodies.every((body) => flow.receiverReferencesToDeclaration(body).every(receiverUse)) &&
          (plan.primitive || ownerOriginsClosed(originsCarrierOf(reference, target)))
        return readerClosedHeld
      }
      return traceReceiver(
        reference,
        'member-read',
        (selectedData && (primitive(value) || ownerOriginsClosed(originsCarrierOf(reference, target)))) || readerClosed(),
        () => {
          // The receiver's type is the whole story of a null target: it says
          // whether the settled census had an answer for the receiver at all
          // when this proof ran, which is what decides `fieldDeclarationOf`.
          if (!target)
            return (
              `dataMember=${dataMember} target=null selectedData=${selectedData} readerClosed=${readerClosed()} primitive=${primitive(value)} ` +
              `receiver=${checker.typeToString(receiverTypeAt(reference) ?? checker.getTypeAtLocation(reference))} ` +
              `settled=${receiverTypeAt(reference) !== null}`
            )
          const text = (node: ts.Node, width: number): string => node.getText().slice(0, width).replace(/\s+/g, ' ')
          const flowTarget = flow.targetOf(parent)?.declaration
          const file = target.getSourceFile()
          const line = file.getLineAndCharacterOfPosition(target.getStart()).line + 1
          return [
            `dataMember=${dataMember} target=${ts.SyntaxKind[target.kind]}[${text(target, 50)}]`,
            `parent=${ts.SyntaxKind[target.parent.kind]}[${text(target.parent, 60)}]`,
            `flowTarget=${flowTarget ? ts.SyntaxKind[flowTarget.kind] : 'none'}@${file.fileName.split('/').pop()}:${line}`,
            `selectedData=${selectedData} readerClosed=${readerClosed()} primitive=${primitive(value)}`
          ].join(' ')
        }
      )
    }
    if (ts.isSpreadElement(parent) && parent.expression === reference) {
      if (ts.isCallExpression(parent.parent) && callThroughUncallableBinding(parent.parent)) return true
      const spread = hostTextSinkArgumentOf(checker, reference)
      if (spread !== null) return spread
    }
    // A receiver reference that IS its call's callee is DISPATCH, not a value
    // leaving the receiver. `super(...)` runs the base constructor on the very
    // object this frame already owns; it hands no receiver to anyone. Whether
    // the base constructor lets that object escape is the base constructor's
    // own receiver question, answered where its own `this` references are
    // walked. Since `super` became a receiver reference alongside `this`,
    // reading it here as a call ARGUMENT sent every derived class's `super()`
    // into `forwardedInvocationUse`, which matches no parameter and refuses --
    // so one subclass broke its base method's member closure and every
    // parameter behind it went unbound.
    if (reference.kind === ts.SyntaxKind.SuperKeyword && ts.isCallExpression(parent) && parent.expression === reference) return true
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (callThroughUncallableBinding(parent)) return true
      const definition = ts.isCallExpression(parent) ? dataDefinitionUse(reference, receiverUse) : null
      if (definition !== null) return definition
      if (ts.isCallExpression(parent) && ownKeyQueryUse(parent, reference)) return true
      const rendered = ts.isCallExpression(parent) ? hostTextSinkArgumentOf(checker, reference) : null
      if (rendered !== null) return rendered
      const storedReads = ts.isCallExpression(parent)
        ? collectionValueContinuationsOf(checker, flow, parent, reference, nativeProtocolClosed)
        : null
      if (storedReads !== null) return storedReads.every(receiverUse)
      if (ts.isCallExpression(parent) && collectionKeyArgumentIsInert(checker, flow, parent, reference, nativeProtocolClosed)) return true
      const stored = arrayStoreArgumentUse(parent, reference, null)
      if (stored !== null) return stored
      return traceReceiver(reference, 'call-argument', forwardedInvocationUse(reference, parent, receiverUse))
    }
    // `a && b`, `a || b`, `a ?? b` and `c ? a : b` select one operand and
    // return it. ToBoolean and the nullish test execute no user code, so the
    // only thing that leaves is whatever the expression evaluates to -- follow
    // that, and nothing else. Three's logging shim guards its optional stack
    // trace with `stackTrace && stackTrace.isStackTrace`, and refusing the
    // whole shape made that test the terminal of 35 escapes.
    if (
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isConditionalExpression(parent) && (parent.whenTrue === reference || parent.whenFalse === reference))
    )
      return receiverUse(parent)
    return inertReceiverUse(reference)
  }
  const receiverValuesOf = (declaration: ts.SignatureDeclaration): readonly ts.Expression[] | null => {
    const calls = closedCallerSitesOf(declaration)
    if (calls === null) return null
    const receivers = new Set<ts.Expression>()
    for (const site of calls) {
      if (ts.isNewExpression(site.call)) {
        receivers.add(site.call)
        continue
      }
      const receiver = site.operands.receiver
      // A bare call's receiver depends on the callable's strictness. Preserve
      // that uncertainty until the frame graph models the implicit receiver.
      if (!receiver) return null
      receivers.add(receiver)
    }
    return [...receivers]
  }
  valueMode?.expose?.(computedKeyAuthority)
  valueMode?.exposeOrigins?.({ classAllocationsOf: allocationOriginsOf, parameterValuesOf, fieldValuesOf, bindingValuesOf })
  if (valueMode) return valueMode.roots.length > 0 && valueMode.roots.every(receiverUse)
  if (!member) return false
  for (const reference of references) {
    if (visit(reference)) continue
    onOpenUse?.(reference, 'receiver')
    return openMember('mention-not-closed', reference)
  }
  const receivers = new Set<ts.Expression>()
  for (const reference of references) {
    const access = ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference ? reference.parent : reference
    if (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) receivers.add(access.expression)
  }
  // A receiver the member is WRITTEN through holds the function, and so does
  // every object it can denote: those are found where they were allocated and
  // walked from there, which reaches every alias. Walking only the mentions
  // of the binding the write named missed `const leaf = leaves[ 0 ];
  // leaf.onDraw = fn` read back through `leaves[ 0 ]`, and in a method it
  // walked the call's RESULT where `this` is the call's receiver. A receiver
  // that only reads the slot is a mention of an object those walks reach.
  const written = new Set<ts.Expression>()
  for (const declaration of member.declarations ?? []) {
    const left = ts.isBinaryExpression(declaration) ? declaration.left : undefined
    if (left && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) written.add(left.expression)
    for (const write of flow.writesToDeclaration(declaration)) {
      const naming = write.naming
      if (naming && (ts.isPropertyAccessExpression(naming) || ts.isElementAccessExpression(naming))) written.add(naming.expression)
    }
  }
  for (const receiver of written) receivers.add(receiver)
  const ownDeclaration = member.valueDeclaration
  // A method shorthand is an entry of its literal exactly as `key: function` is.
  if (
    ownDeclaration &&
    (ts.isPropertyAssignment(ownDeclaration) || ts.isMethodDeclaration(ownDeclaration)) &&
    ts.isObjectLiteralExpression(ownDeclaration.parent)
  )
    receivers.add(ownDeclaration.parent)
  if (receivers.size === 0 && !unnamed) {
    if (memberSite) onOpenUse?.(memberSite, 'member-receiver-inventory')
    return openMember('no-receiver-inventory', memberSite ?? undefined)
  }
  for (const receiver of receivers) {
    const closed = ts.isObjectLiteralExpression(receiver)
      ? receiverUse(receiver)
      : written.has(receiver)
        ? publishInto(receiver, null)
        : receiverCell(receiver)
    if (closed) continue
    onOpenUse?.(receiver, 'receiver')
    return openMember('receiver-open', receiver)
  }
  // A method or field initializer is carried by EVERY instance of its family,
  // and the receivers above are only the ones that name it. A sibling that
  // never mentions `.m` still reaches unknown code with its prototype -- which
  // can replace `m` for all of them, or call `m` with its own arguments -- so
  // every construction and initializer receiver of the family is walked.
  if ((member.declarations ?? []).some((declaration) => ts.isClassElement(declaration)) && !ownerOriginsClosed()) {
    if (memberSite) onOpenUse?.(memberSite, 'member-receiver-inventory')
    return openMember('family-origins-open', memberSite ?? undefined)
  }

  // Replacing the slot with an external callable removes the closed family
  // proof even if all currently visible calls have compatible arguments.
  for (const declaration of member.declarations ?? [])
    for (const reference of flow.receiverReferencesToDeclaration(declaration))
      if (!receiverUse(reference)) return openMember('slot-receiver-reference-open', reference)
  return (member.declarations ?? [])
    .flatMap((declaration) => flow.writesToDeclaration(declaration))
    .filter((write) => write.edge !== 'return' && write.edge !== 'yield')
    .every((write) => {
      if (write.value === null) return write.edge === 'delete' || openMember('slot-deleted', write.site)
      // Replacement validation must use the same complete origins as member
      // implementation lookup. A constructor parameter or alias can carry a
      // known callback just as a literal can; its receiver effects still owe
      // exactly the same closure proof once those bodies are enumerated.
      const targets = closedCallableTargetsOf(checker, flow, write.value, elementCalleeAuthority)
      return (
        (targets !== null && targets.every((target) => flow.receiverReferencesToDeclaration(target).every(receiverUse))) ||
        openMember('slot-written-with-open-callable', write.site)
      )
    })
}

/** The binary operators whose RESULT is a boolean, so an operand's value stops there. */
const COMPARISON_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword
])

/**
 * `.call`/`.apply` -- a call of the receiver, spelled through a member of it.
 *
 * The method name alone is not proof: a program is free to declare its own
 * object with a `.call( ... )`/`.apply( ... )` method that has nothing to do
 * with `Function.prototype.call`/`.apply`, and reading every mention of such
 * an object through this branch would silently invent a "call" this program
 * never made. `classifyMention` below also requires the RECEIVER's own static
 * type to have a call signature -- the same requirement
 * `derived-expression-type.ts`'s sibling `unwrapExplicitThisCall` makes of the
 * identical shape -- before this name is trusted at all.
 */
const EXPLICIT_THIS_METHODS: ReadonlySet<string> = new Set(['call', 'apply'])

/** Parentheses, `!` and type assertions evaluate to the object the expression inside them does. */
const unwrapValueExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  )
    current = current.expression
  return current
}

/**
 * The keys an object-literal argument spells, or `null` for anything that
 * is not a literal of plainly named properties (a spread, a computed name,
 * `JSON.parse(...)`): a source whose keys cannot be read off the text may
 * carry any key at all.
 */
const spelledLiteralKeysOf = (expression: ts.Expression): ReadonlySet<string> | null => {
  const value = unwrapValueExpression(expression)
  if (!ts.isObjectLiteralExpression(value)) return null
  const keys = new Set<string>()
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) return null
    const name = property.name
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) return null
    keys.add(name.text)
  }
  return keys
}

/**
 * Whether a computed property key may address the member `key`: a key whose
 * every static arm is numeric cannot, nor can a string literal spelling
 * another name; anything else may. One decision for both the write inventory
 * (`memberSlotWritesClosed`) and the receiver-alias walk (`inertReceiverUse`),
 * so an alias write `bag[Date.now()] = 1` that the write scan admits is not
 * refused again as an unexplained use of the receiver.
 */
/** Every static arm of a computed key's type is numeric: the key can name no identifier-spelled member. */
const numericKeyType = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).every((arm) => (arm.flags & ts.TypeFlags.NumberLike) !== 0)

const computedKeyMayBeMember = (checker: ts.TypeChecker, argument: ts.Expression, key: string): boolean => {
  const type = checker.getTypeAtLocation(argument)
  const arms = type.isUnion() ? type.types : [type]
  return arms.some((arm) => {
    if (arm.flags & ts.TypeFlags.NumberLike) return false
    if (arm.isStringLiteral()) return arm.value === key
    return true
  })
}

/**
 * `Object.assign(target, ...sources)` through the global `Object`: the one
 * intrinsic mutator whose effect on `target` is exactly the keys its sources
 * spell. `null` for any other call.
 */
const objectAssignSourcesOf = (checker: ts.TypeChecker, call: ts.CallExpression): readonly ts.Expression[] | null => {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'assign' || !ts.isIdentifier(callee.expression)) return null
  if (callee.expression.text !== 'Object') return null
  const symbol = checker.getSymbolAtLocation(callee.expression)
  const declared = symbol?.declarations ?? []
  if (declared.length === 0 || !declared.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)) return null
  return call.arguments.slice(1)
}

/**
 * A callable written DIRECTLY as an expression, with no name of its own --
 * the only shape whose value flow is closed by construction, because the node
 * occurs once and nothing names it.
 *
 * A named function expression (`function f() {}` used as a value) is excluded:
 * its own name is in scope inside its body, so a recursive self-reference is a
 * mention this layer would have to account for separately.
 */
const isAnonymousInlineCallable = (node: ts.Node): node is ts.FunctionExpression | ts.ArrowFunction =>
  ts.isArrowFunction(node) || (ts.isFunctionExpression(node) && node.name === undefined)

/**
 * How a single mention of a cell is classified: it either calls through the
 * cell, provably does nothing with the value, or hands it somewhere this
 * layer cannot follow.
 */
type Mention =
  | { readonly kind: 'call'; readonly call: ts.CallExpression }
  | { readonly kind: 'inert' }
  | { readonly kind: 'open'; readonly reason: string }

/**
 * What this mention of a cell does with the cell's value.
 *
 * Everything not positively recognised is `open`. That direction matters: an
 * unrecognised position could be a call this layer never counted, and a
 * consumer binding a parameter from an incomplete caller set binds it from a
 * guess. `&&`/`||`/`??` are deliberately NOT inert -- they yield the operand's
 * own value onward, so `cb || noop` reaches wherever that result goes.
 */
const classifyMention = (checker: ts.TypeChecker, reference: ts.Expression, declarationName: ts.Node): Mention => {
  if (reference === declarationName) return { kind: 'inert' } // the cell's own declared name is not a use of it
  const parent = reference.parent
  if (!parent) return { kind: 'open', reason: 'no-parent' }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === reference) {
    return ts.isCallExpression(parent) ? { kind: 'call', call: parent } : { kind: 'open', reason: 'constructed' }
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && EXPLICIT_THIS_METHODS.has(parent.name.text)) {
    // The RECEIVER -- `reference` itself, since `parent.expression === reference`
    // -- must actually be a function value: see `EXPLICIT_THIS_METHODS`'s own
    // doc. A mention that fails this is left `open` rather than reclassified
    // `inert`, because a real `.call`/`.apply` member read whose target this
    // layer cannot prove callable is exactly the kind of unexplained mention
    // this whole closure proof exists to refuse on.
    if (checker.getSignaturesOfType(checker.getTypeAtLocation(reference), ts.SignatureKind.Call).length === 0) {
      return { kind: 'open', reason: 'explicit-this-method-not-callable' }
    }
    const grandparent = parent.parent
    if (grandparent && ts.isCallExpression(grandparent) && grandparent.expression === parent) return { kind: 'call', call: grandparent }
    return { kind: 'open', reason: 'explicit-this-not-called' }
  }
  if (ts.isTypeOfExpression(parent)) return { kind: 'inert' }
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return { kind: 'inert' }
  if (ts.isBinaryExpression(parent) && COMPARISON_TOKENS.has(parent.operatorToken.kind)) return { kind: 'inert' }
  if (ts.isIfStatement(parent) && parent.expression === reference) return { kind: 'inert' }
  if (ts.isWhileStatement(parent) && parent.expression === reference) return { kind: 'inert' }
  if (ts.isDoStatement(parent) && parent.expression === reference) return { kind: 'inert' }
  if (ts.isConditionalExpression(parent) && parent.condition === reference) return { kind: 'inert' }
  return { kind: 'open', reason: ts.SyntaxKind[parent.kind] }
}

export { classifyMention as classifyCallableMention }

/**
 * Compose the index's `call-argument` edges with its mention lists into the
 * two transitive answers above.
 *
 * Reads the index and no second walk -- every EDGE this needs is one `flow`
 * already published. The one checker call it does make is
 * `classifyMention`'s receiver-is-callable test above, asked at a mention the
 * index already located rather than a fresh walk of its own, and (like
 * `flow/value-flow.ts`'s own equivalent addition) a fixed property of the
 * program: a reference's own static type does not change as any census
 * composes more evidence.
 */
export const indexCallableReach = (checker: ts.TypeChecker, flow: ValueFlowIndex): CallableReachIndex => {
  const refusals = new Map<string, number>()
  const refuse = (reason: string): void => {
    refusals.set(reason, (refusals.get(reason) ?? 0) + 1)
  }

  /** Which callables each parameter slot receives from an argument position, and the parameter's own declaration. */
  const callablesInParameter = new Map<ts.ParameterDeclaration, Set<ts.SignatureDeclaration>>()
  /** The argument-position callables this layer considers, and the one slot each reaches. */
  const slotOfCallable = new Map<ts.SignatureDeclaration, ts.ParameterDeclaration>()
  for (const write of flow.allWrites) {
    if (write.edge !== 'call-argument' && write.edge !== 'super-argument') continue
    const value = write.value
    const parameter = write.target.declaration
    if (!value || !parameter || !ts.isParameter(parameter)) continue
    if (!isAnonymousInlineCallable(value)) continue
    const existing = callablesInParameter.get(parameter)
    if (existing) existing.add(value)
    else callablesInParameter.set(parameter, new Set([value]))
    // One slot per callable, by construction: an inline expression node stands
    // in exactly one argument position. A second sighting would mean the index
    // recorded the same node twice, and taking the FIRST keeps that a
    // no-op rather than a silent overwrite.
    if (!slotOfCallable.has(value)) slotOfCallable.set(value, parameter)
  }

  /**
   * The calls made THROUGH a parameter slot, or `null` when some mention of it
   * is unexplained. Memoized: a slot with many callables is asked once per
   * callable, and the answer is a fixed property of the program.
   */
  const slotClosure = new Map<ts.ParameterDeclaration, readonly ts.CallExpression[] | null>()
  const callsThroughSlot = (parameter: ts.ParameterDeclaration): readonly ts.CallExpression[] | null => {
    const cached = slotClosure.get(parameter)
    if (cached !== undefined) return cached
    const answer = ((): readonly ts.CallExpression[] | null => {
      const calls: ts.CallExpression[] = []
      for (const reference of flow.referencesToDeclaration(parameter)) {
        const mention = classifyMention(checker, reference, parameter.name)
        if (mention.kind === 'open') {
          refuse('slot-mention-unexplained:' + mention.reason)
          return null
        }
        if (mention.kind === 'call' && !calls.includes(mention.call)) calls.push(mention.call)
      }
      // A slot nothing ever calls proves nothing about the callable's callers:
      // the value is in a cell whose reads this layer explained as inert, so
      // there is no caller to enumerate and no evidence to hand anyone.
      if (calls.length === 0) {
        refuse('slot-never-called')
        return null
      }
      return calls
    })()
    slotClosure.set(parameter, answer)
    return answer
  }

  const closedSites = new Map<ts.SignatureDeclaration, readonly ts.CallExpression[]>()
  for (const [callable, parameter] of slotOfCallable) {
    const calls = callsThroughSlot(parameter)
    if (calls) closedSites.set(callable, calls)
  }

  /** Reverse of `callablesInParameter`, asked at a call whose callee names the slot. */
  const calleesOf = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] => {
    const callee = call.expression
    if (!ts.isIdentifier(callee)) return NO_CALLABLES
    const target = flow.targetOf(callee)
    const parameter = target?.declaration
    if (!parameter || !ts.isParameter(parameter)) return NO_CALLABLES
    const callables = callablesInParameter.get(parameter)
    return callables ? [...callables] : NO_CALLABLES
  }

  return {
    enumeratedCallSitesOf: (declaration) => closedSites.get(declaration) ?? null,
    calleesOf,
    closedCount: closedSites.size,
    refusals
  }
}
