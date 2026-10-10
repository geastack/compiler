import ts from 'typescript'
import { isGlobalObjectAssign } from '../derived-expression-type.js'
import type { FlowCallSite, FlowEdgeKind, FlowInvocationOperands, SourceClass, ValueFlowIndex, ValueWrite } from './model.js'
import { isClassSpelledSourceClass } from './model.js'
import {
  dependencyFactSolver,
  type DependencyFactDefinition,
  type DependencyFactHoldersOf,
  type DependencyRootCause
} from './component-solver.js'
import {
  classConstructorKeepsInstanceOf,
  exactSourceConstructionOf,
  ordinarySourceClassInstanceTestOf,
  sourceConstructorSelectionsOf,
  type SourceConstructionFact
} from './member-call-forwarding.js'
import { sourceClassCallableMemberPlanOf, sourceClassDataMemberPlanOf, sourceClassKeyReadPlanOf } from './source-class-data.js'
import { sourceClassFamilyOf } from './owned-class-receivers.js'
import { intrinsicDataDefinitionTargetOf, type IntrinsicDataDefinitionPlan } from './intrinsic-data-definition.js'
import { callableCompletionSummaryOf, constructionYieldsCompletionOf } from './callable-completions.js'
import { sourceInvocationFrameLayoutOf } from './source-invocation-frame-layout.js'
import { bindingReadMayPrecedeFirstWrite, sourceBindingValuesOf, sourceBindingWritesAreComplete } from './value-provenance.js'
import { collectionStoredValuesOf, collectionValueContinuationsOf } from './collection-value-continuation.js'
import type { NativeCollectionProtocolPlan } from './native-collection-protocol.js'
import { isModuleExportedDeclaration, isTypePositionReference, runtimeParametersOf, unwrapNaming } from './targets.js'
import { outermostErasureOf, unwrapErasedExpression } from '../producers/erasure.js'
import { literalSourcePropertyKeyOf } from './source-property-key.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'
import { censusArgumentsObjects, type ArgumentsObjectCensus } from '../arguments-objects.js'
import { exportIsUnimported } from './targets.js'
import { inProgramImportReferencesOf } from './export-importers.js'
import { sourceConstructionFramesOf } from './source-construction-frames.js'
import { isSourceInstanceMethod } from './source-prototype-method-identity.js'
import { sourceGlobalCallableBindingIsClosed } from './source-global-binding.js'
import {
  isSourceCallableObject,
  sourceCallableObjectOf,
  sourceCallableReflectSetOf,
  sourceCallableDataWriteProtocolOf,
  sourceCallableOwnDataWriteOf,
  sourceCallableOwnDataMayBeWrittenOf,
  type SourceCallableObject
} from './source-callable-own-data.js'
import { intrinsicJsonStringifyQueryOf, intrinsicOwnKeyQueryOf } from '../intrinsic-property-call.js'
import { sourceObjectPrototypeAbsenceOf } from '../source-object-prototype-absence.js'
import { sourceFreshOrdinaryObjectOf } from '../fresh-ordinary-object.js'
import { sourceIntrinsicMemberDataWriteOf, sourceIntrinsicMemberMayBeWrittenOf } from './source-intrinsic-member-data.js'
import { sourceCommonJsExportUsesOf, sourceCommonJsExportValueOf } from './source-commonjs-exports.js'

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression
type Value = ts.Expression | ts.SignatureDeclaration
/** A site that can call a body; `call` is null for a `new F(...)` that enters F's frame unconditionally. */
interface CallerCandidate {
  readonly site: FlowCallSite
  readonly call: ts.CallExpression | null
}
type ObjectRoot = ts.CallExpression | ts.NewExpression | ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | SourceCallableObject
type Query =
  | { readonly kind: 'value'; readonly node: ts.Expression }
  | { readonly kind: 'parameter'; readonly node: ts.ParameterDeclaration }
  | { readonly kind: 'binding-element'; readonly node: ts.BindingElement }
  | { readonly kind: 'receiver'; readonly node: ts.Node }
  | { readonly kind: 'targets' | 'super-targets'; readonly node: ts.CallExpression }
  | { readonly kind: 'completion'; readonly node: ts.CallExpression | ts.NewExpression }
  | { readonly kind: 'construct-targets'; readonly node: ts.CallExpression | ts.NewExpression }
  | {
      readonly kind: 'frame-receiver' | 'frame-argument' | 'frame-parameter' | 'frame-value' | 'frame-completion'
      readonly node: ts.CallExpression | ts.NewExpression
      readonly body: ts.SignatureDeclaration
      readonly subject: ts.Expression | ts.ParameterDeclaration | null
    }
  | { readonly kind: 'closure'; readonly node: Value }
  | { readonly kind: 'slot' | 'stored-slot'; readonly node: ObjectRoot; readonly key: string }
  | { readonly kind: 'own-keys'; readonly node: ObjectRoot }
  | { readonly kind: 'use'; readonly node: ts.Expression; readonly root: Value }
  | { readonly kind: 'publication'; readonly node: ObjectRoot; readonly key: string; readonly root: Value }
  | { readonly kind: 'unknown-reads'; readonly node: ObjectRoot }
  | { readonly kind: 'callers'; readonly node: ts.SignatureDeclaration }

interface Cause {
  readonly reason: string
  readonly node: ts.Node
}

type Read = (query: Query) => ReadonlySet<Value>
/**
 * Walk two lists as one without building a third.
 *
 * Every caller is inside a transfer, and a transfer runs once per
 * re-evaluation of its node -- so a spread that reads as a convenience is an
 * allocation and a copy priced per transfer, not per program.
 */
const both = <T>(first: readonly T[] | undefined, second: readonly T[]): readonly T[] =>
  first === undefined || first.length === 0 ? second : second.length === 0 ? first : [...first, ...second]
const refusalDebug = process.env['GEA_SESSION_REFUSALS'] !== undefined

/** The query kinds whose facts are values and therefore need a grounding witness. */
const VALUE_CARRYING_KINDS: ReadonlySet<Query['kind']> = new Set<Query['kind']>([
  'value',
  'slot',
  'stored-slot',
  'parameter',
  'binding-element',
  'super-targets',
  'receiver',
  'completion',
  'frame-receiver',
  'frame-argument',
  'frame-parameter',
  'frame-value',
  'frame-completion'
])
const VALUE_ORIGIN = 'source-value-origin'
// Read once at load, not per value transfer: `process.env` is a native interceptor.
const noArrayKeys = process.env['GEA_NO_ARRAY_KEYS'] !== undefined
/**
 * The element slot of an array root: every position at once. A computed
 * index names no single key (`this.items[ i ]` in a constructor that fills
 * an array field in a loop, with the loop counter as the index), so a store or read through one is
 * filed under this key, and a literal-index slot and this one alias each
 * other -- `slot(root, '0')` includes what `[ i ]` stored, and `[ i ]` reads
 * what `[ 0 ]` stored. Before this the unbounded index published nothing and
 * read nothing, and every such array's elements were unresolvable.
 */
const ELEMENT_KEY = '[]'
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/
const isCanonicalIndex = (key: string): boolean => CANONICAL_INDEX.test(key)
/** Whether a store or read filed under `stored` can reach the slot `key` of `root`. */
const keyReaches = (root: ts.Node, stored: readonly string[], key: string): boolean =>
  stored.includes(key) ||
  (ts.isArrayLiteralExpression(root) &&
    ((key === ELEMENT_KEY && stored.some(isCanonicalIndex)) || (isCanonicalIndex(key) && stored.includes(ELEMENT_KEY))))
const isSpelledObjectRoot = (node: ts.Node): node is ObjectRoot =>
  ts.isNewExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || isSourceCallableObject(node)
const isBody = (node: ts.Node): node is ts.SignatureDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
const accessKey = (access: Access): string | null =>
  ts.isPropertyAccessExpression(access) ? access.name.text : literalKey(access.argumentExpression)
const literalKey = literalSourcePropertyKeyOf
const declarationKey = (name: ts.PropertyName): string | null =>
  ts.isComputedPropertyName(name) ? literalKey(name.expression) : ts.isPrivateIdentifier(name) ? null : name.text
/**
 * The slot a binding element reads out of the object being destructured.
 *
 * `{ app }` and `{ app: local }` both read `app` -- the PROPERTY name is the
 * slot and the bound name is only what the cell is called afterwards, which is
 * the same distinction `declarationKey` makes for a property. An array pattern
 * reads by position, and an omitted element still occupies one, so the index
 * comes from the element list rather than from a running count of the elements
 * that bind something.
 */
const bindingElementKey = (element: ts.BindingElement): string | null => {
  const pattern = element.parent
  if (ts.isArrayBindingPattern(pattern)) return String(pattern.elements.indexOf(element))
  if (element.propertyName) return declarationKey(element.propertyName)
  return ts.isIdentifier(element.name) ? element.name.text : null
}

/** Source values, their storage, invocations and escape obligations share one
 * graph. No transfer calls a recursive origin/receiver/callable proof. The
 * construction and declared-descriptor queries below are independent leaves.
 * @semanticCategory generic-primitive
 */
export interface SourceValueSession {
  /** This migration owns ordinary source interface member calls. The caller must not
   * fall back to its former resolver when this projection refuses. */
  readonly ownsInvocation: (call: ts.CallExpression) => boolean
  readonly invocationTargetsOf: (call: ts.CallExpression) => readonly ts.SignatureDeclaration[] | null
  /** Exact installation candidates supply frame positions inside the joint solver; they do not admit a call. */
  readonly candidateOrdinaryOwnCallableOperandsOf: (call: ts.CallExpression) => FlowInvocationOperands | null
  /** An admitted own-slot call replays its complete source/descriptor obligations with the same operand entry. */
  readonly ordinaryOwnCallableOperandsOf: (call: ts.CallExpression) => FlowInvocationOperands | null
  /** One fully closed installed body, including an immutable detached read. */
  readonly ordinaryOwnCallableSourceOf: (call: ts.CallExpression) => SourceCallableObject | null
  readonly valuesOf: (expression: ts.Expression) => readonly Value[] | null
  /** The same value family after every actual consumer of each root is accounted for. */
  readonly closedValuesOf: (expression: ts.Expression) => readonly Value[] | null
  /** The same complete stored-value family whether a member is named through its owner or a structural alias. */
  readonly memberValuesOf: (expression: ts.Expression, key: string) => readonly Value[] | null
  /** The same closed allocation and stored family used by bulk native copies. */
  readonly ownSlotOf: (expression: ts.Expression, key: string) => SourceOwnSlot | null
  /** Current source-owned slots, before any physical carrier is selected.
   * `describedKeysOf` names a source's own data keys where no closed family
   * describes it; the caller answers from the structural type the source's
   * representation is laid out under, so the copy and its absence proof
   * range over one key set. Absent, an undescribed copy is refused. */
  readonly ownAssignmentOf: (
    call: ts.CallExpression,
    frames?: SourceInvocationFrames,
    describedKeysOf?: (expression: ts.Expression) => readonly string[] | null
  ) => SourceOwnAssignment | null
  /** Exact closed source callers, before specialization selects their body copy. */
  readonly callerSitesOf: (body: ts.SignatureDeclaration) => readonly (ts.CallExpression | ts.NewExpression)[] | null
  /** Every value a parameter can hold -- a setter's included, whose callers are the stores that run it. */
  readonly parameterValuesOf: (parameter: ts.ParameterDeclaration) => readonly Value[] | null
  /** Complete unchanged-formal inputs retain their raw source expressions,
   * including native leaves outside this session's source-allocation domain. */
  readonly parameterSourceExpressionsOf: (parameter: ts.ParameterDeclaration) => readonly ts.Expression[] | null
  readonly explainParameter: (parameter: ts.ParameterDeclaration) => readonly DependencyRootCause<Query, Cause>[]
  readonly explainInvocation: (call: ts.CallExpression) => readonly DependencyRootCause<Query, Cause>[]
  readonly explainValue: (expression: ts.Expression) => readonly DependencyRootCause<Query, Cause>[]
}

/** A direct property use retains its allocation identity and every actual
 * writer reached through the joint source graph, including native fields
 * and closed call frames. Public field declarations do not choose storage.
 * @semanticCategory generic-primitive
 */
export interface SourceOwnSlot {
  readonly key: string
  readonly roots: readonly {
    readonly root: ts.ObjectLiteralExpression | ts.CallExpression | ts.NewExpression
    readonly values: readonly Value[]
    readonly writes: readonly Access[]
  }[]
}

/** A bulk write's finite source domains come from the same closed roots and
 * slots as member reads. Key order remains a runtime descriptor operation;
 * this fact names storage and never reconstructs the consumer's type.
 * @semanticCategory generic-primitive
 */
export interface SourceOwnAssignment {
  readonly call: ts.CallExpression
  readonly targets: readonly ts.ObjectLiteralExpression[]
  readonly targetSlots: readonly {
    readonly root: ts.ObjectLiteralExpression
    readonly slots: readonly { readonly key: string; readonly values: readonly Value[] }[]
  }[]
  readonly sources: readonly {
    readonly ordinal: number
    readonly expression: ts.Expression
    readonly nullable: boolean
    readonly roots: readonly {
      readonly root: ts.ObjectLiteralExpression
      readonly slots: readonly { readonly key: string; readonly values: readonly Value[]; readonly copyPresent: boolean }[]
    }[]
    /** A source no closed allocation family describes. Its own keys are its
     * static type's declared data members plus whatever its carrier holds at
     * run time, enumerated then; `roots` is empty. */
    readonly described?: { readonly keys: readonly string[] }
  }[]
}

/** A body copy's selected actual entries. Selection belongs to the canonical
 * specialization census; each root still owes its whole-program closure.
 * @semanticCategory generic-primitive
 */
export interface SourceInvocationFrames {
  readonly body: ts.SignatureDeclaration
  readonly callers: readonly (ts.CallExpression | ts.NewExpression)[]
}

const sessions = new WeakMap<ValueFlowIndex, { readonly session: SourceValueSession; readonly retire: () => void }>()
/**
 * The session handed out is a facade over the solver that does the work, so
 * the solver can be released without finding every holder of the facade.
 * Holders are many -- census closures capture it, and the binding fixpoint
 * keeps every round's census reachable through its `upstream` chain
 * (`parameter-bindings.ts`) -- so a finished round's ~1 GB solver used to stay
 * alive for the rest of the compile.
 */
export const sourceValueSessionOf = (checker: ts.TypeChecker, flow: ValueFlowIndex): SourceValueSession => {
  const known = sessions.get(flow)
  if (known) return known.session
  // Built now, not on first question, so solver construction keeps its place in the compile.
  let solver: SourceValueSession | null = createSession(checker, flow)
  const live = (): SourceValueSession => {
    if (solver !== null) return solver
    return (solver = createSession(checker, flow))
  }
  const session: SourceValueSession = {
    ownsInvocation: (call) => live().ownsInvocation(call),
    invocationTargetsOf: (call) => live().invocationTargetsOf(call),
    candidateOrdinaryOwnCallableOperandsOf: (call) => live().candidateOrdinaryOwnCallableOperandsOf(call),
    ordinaryOwnCallableOperandsOf: (call) => live().ordinaryOwnCallableOperandsOf(call),
    ordinaryOwnCallableSourceOf: (call) => live().ordinaryOwnCallableSourceOf(call),
    valuesOf: (expression) => live().valuesOf(expression),
    closedValuesOf: (expression) => live().closedValuesOf(expression),
    memberValuesOf: (expression, key) => live().memberValuesOf(expression, key),
    ownSlotOf: (expression, key) => live().ownSlotOf(expression, key),
    ownAssignmentOf: (call, frames, describedKeysOf) => live().ownAssignmentOf(call, frames, describedKeysOf),
    callerSitesOf: (body) => live().callerSitesOf(body),
    parameterValuesOf: (parameter) => live().parameterValuesOf(parameter),
    parameterSourceExpressionsOf: (parameter) => live().parameterSourceExpressionsOf(parameter),
    explainParameter: (parameter) => live().explainParameter(parameter),
    explainInvocation: (call) => live().explainInvocation(call),
    explainValue: (expression) => live().explainValue(expression)
  }
  sessions.set(flow, {
    session,
    retire: () => {
      solver = null
    }
  })
  return session
}
/**
 * Releases the solver behind `flow`'s session. A later question is still
 * answered: by a fresh solver over the same flow, which reaches the same
 * fixed point. The frontend retires a round's flow once the next round has
 * replaced it, and the final round's once the frontend returns. On a
 * large program no retired session is ever asked again; of the gate's programs
 * one is (a later census falling through `upstream` to an earlier round,
 * `indexed-absence-forwarded-cache`), and its rebuilt answer emits the same
 * program.
 */
export const retireSourceValueSession = (flow: ValueFlowIndex): void => {
  sessions.get(flow)?.retire()
}

const createSession = (checker: ts.TypeChecker, flow: ValueFlowIndex): SourceValueSession => {
  const isFreshOrdinaryObject = (node: ts.Node): boolean => sourceFreshOrdinaryObjectOf(checker, node)
  const isObjectRoot = (node: ts.Node): node is ObjectRoot => isSpelledObjectRoot(node) || isFreshOrdinaryObject(node)
  // A closed native Map is only closed while `Map.prototype`'s `get`/`set`
  // are the intrinsics: a finite root walk is not that proof
  // (`native-collection-protocol.ts`), so only the deferred obligation -- an
  // intrinsic-protocol requirement the final sealed census discharges -- is
  // accepted here, and a plan with no ledger to file it with is refused.
  const nativeProtocolClosed = (plan: NativeCollectionProtocolPlan): boolean =>
    plan.deferred &&
    deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys(plan.intrinsic, plan.prototypeKeys, plan.location) === true
  const unary = new Map<Query['kind'], Map<ts.Node, Query>>()
  const slots = new Map<ObjectRoot, Map<string, Query>>()
  const storedSlots = new Map<ObjectRoot, Map<string, Query>>()
  const uses = new Map<Value, Map<ts.Expression, Query>>()
  const publications = new Map<Value, Map<ObjectRoot, Map<string, Query>>>()
  const frameQueries = new Map<
    string,
    Map<ts.CallExpression | ts.NewExpression, Map<ts.SignatureDeclaration, Map<ts.Expression | ts.ParameterDeclaration | null, Query>>>
  >()
  const requirements = new Map<Query, readonly IntrinsicProtocolRequirement[]>()
  const argumentsByFile = new Map<ts.SourceFile, ArgumentsObjectCensus>()
  const argumentsUsesAt = (body: ts.SignatureDeclaration): readonly ts.Identifier[] | undefined => {
    const file = body.getSourceFile()
    let census = argumentsByFile.get(file)
    if (!census) argumentsByFile.set(file, (census = censusArgumentsObjects(checker, [file])))
    return census.usesByOwner.get(body)
  }
  const undefinedValue = ts.factory.createVoidZero()
  const arrayLengths = new Map<ts.ArrayLiteralExpression, ts.NumericLiteral>()
  const keyValues = new Map<ObjectRoot, Map<string, ts.StringLiteral>>()
  const keyValue = (root: ObjectRoot, key: string): ts.StringLiteral => {
    let keys = keyValues.get(root)
    if (!keys) keyValues.set(root, (keys = new Map()))
    let literal = keys.get(key)
    if (!literal) keys.set(key, (literal = ts.factory.createStringLiteral(key)))
    return literal
  }
  const sites = new Map(flow.calls.map((site) => [site.call, site]))
  const ownInvocationEntries = new Map<ts.CallExpression, FlowInvocationOperands>()
  const candidateOrdinaryOwnCallableOperandsOf = (call: ts.CallExpression): FlowInvocationOperands | null => {
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null
    const key = accessKey(callee)
    const owner = sourceCallableObjectOf(checker, flow, callee.expression)
    if (key === null || owner === null || !sourceCallableOwnDataMayBeWrittenOf(checker, flow, owner, key)) return null
    let entry = ownInvocationEntries.get(call)
    if (!entry) {
      entry = {
        kind: 'call',
        dispatch: { kind: 'member', lookup: callee.expression, key },
        explicitThis: false,
        callee,
        receiver: callee.expression,
        args: call.arguments
      }
      ownInvocationEntries.set(call, entry)
    }
    return entry
  }
  const ownCallableReadOf = (expression: ts.Expression, seen: ReadonlySet<ts.Node> = new Set()): Access | null => {
    const held = unwrapErasedExpression(expression)
    if (seen.has(held)) return null
    if (ts.isPropertyAccessExpression(held) || ts.isElementAccessExpression(held)) {
      const owner = sourceCallableObjectOf(checker, flow, held.expression)
      const key = accessKey(held)
      return owner !== null && key !== null && sourceCallableOwnDataMayBeWrittenOf(checker, flow, owner, key) ? held : null
    }
    if (!ts.isIdentifier(held)) return null
    const declaration = flow.targetOf(held)?.declaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || seen.has(declaration)) return null
    const incoming = sourceBindingValuesOf(checker, flow, declaration)
    if (!incoming || incoming.length !== 1 || bindingReadMayPrecedeFirstWrite(declaration, held)) return null
    return ownCallableReadOf(incoming[0]!, new Set(seen).add(held).add(declaration))
  }
  const isNullish = (held: Value): boolean =>
    held === undefinedValue || held.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(held)
  const primitiveStoredValue = (held: Value): boolean => {
    if (isNullish(held)) return true
    if (!ts.isExpression(held)) return false
    // JSON can invoke BigInt.prototype.toJSON; Object prototype absence alone cannot authenticate that hook.
    const primitive = (type: ts.Type): boolean =>
      type.isUnion()
        ? type.types.every(primitive)
        : (type.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.BooleanLike |
              ts.TypeFlags.ESSymbolLike |
              ts.TypeFlags.Null |
              ts.TypeFlags.Undefined |
              ts.TypeFlags.Void)) !==
          0
    return primitive(checker.getTypeAtLocation(unwrapErasedExpression(held)))
  }
  const constructionFrames = sourceConstructionFramesOf(checker, flow)
  // Destructuring is the other spelling of a slot read, so the enumeration of
  // "everything that can read this key" has to hold both. A key no element
  // states -- a rest element, or a computed property name -- can read any key
  // at all and joins the unknown side, exactly as an unresolved element access
  // does.
  const patternReadsByKey = new Map<string, ts.BindingElement[]>()
  const unknownPatternReads: ts.BindingElement[] = []
  for (const element of flow.bindingPatternReads) {
    const key = bindingElementKey(element)
    if (element.dotDotDotToken || key === null) unknownPatternReads.push(element)
    else {
      let reads = patternReadsByKey.get(key)
      if (!reads) patternReadsByKey.set(key, (reads = []))
      reads.push(element)
    }
  }
  const nodeQuery = <
    K extends
      | 'value'
      | 'parameter'
      | 'binding-element'
      | 'receiver'
      | 'targets'
      | 'super-targets'
      | 'construct-targets'
      | 'completion'
      | 'closure'
      | 'unknown-reads'
      | 'own-keys'
      | 'callers'
  >(
    kind: K,
    node: Extract<Query, { kind: K }>['node'] | ts.Node
  ): Query => {
    let nodes = unary.get(kind)
    if (!nodes) unary.set(kind, (nodes = new Map()))
    let query = nodes.get(node)
    if (!query) nodes.set(node, (query = { kind, node } as Query))
    return query
  }
  const value = (expression: ts.Expression): Query => nodeQuery('value', unwrapErasedExpression(expression))
  const frameQuery = (
    kind: 'frame-receiver' | 'frame-argument' | 'frame-parameter' | 'frame-value' | 'frame-completion',
    call: ts.CallExpression | ts.NewExpression,
    body: ts.SignatureDeclaration,
    subject: ts.Expression | ts.ParameterDeclaration | null = null
  ): Query => {
    let calls = frameQueries.get(kind)
    if (!calls) frameQueries.set(kind, (calls = new Map()))
    let bodies = calls.get(call)
    if (!bodies) calls.set(call, (bodies = new Map()))
    let subjects = bodies.get(body)
    if (!subjects) bodies.set(body, (subjects = new Map()))
    let query = subjects.get(subject)
    if (!query) subjects.set(subject, (query = { kind, node: call, body, subject }))
    return query
  }
  const closure = (root: Value): Query => nodeQuery('closure', root)
  /**
   * The plain source function `new F( ... )` runs when `F` is an identifier
   * naming an unwritten, non-generator, non-async function declaration
   * with ordinary formals, or null. Its completions are proven separately
   * (`constructionYieldsCompletionOf`); this only names the body.
   */
  const thisConstructorReceiverOf = (call: ts.NewExpression): ts.Expression | null => {
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'constructor') return null
    const receiver = unwrapErasedExpression(callee.expression)
    return receiver.kind === ts.SyntaxKind.ThisKeyword ? receiver : null
  }
  const constructorFunctionCalleeOf = (call: ts.NewExpression): ts.FunctionDeclaration | null => {
    if (call.arguments?.some(ts.isSpreadElement)) return null
    const callee = unwrapErasedExpression(call.expression)
    if (!ts.isIdentifier(callee)) return null
    const named = flow.targetOf(callee)
    const target = aliasedDeclarationOf(named?.symbol ?? undefined) ?? named?.declaration
    if (!target || !ts.isFunctionDeclaration(target) || !target.body || target.getSourceFile().isDeclarationFile) return null
    if (target.asteriskToken || target.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return null
    if (target.parameters.some((parameter) => parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))) return null
    if (flow.writesToDeclaration(target).some((write) => write.slot === 'whole' && write.edge !== 'return' && write.edge !== 'yield'))
      return null
    return target
  }
  /**
   * The computed-key reads that can be reading THIS container.
   *
   * A read whose key the program does not spell -- `o[ k ]` -- can publish
   * any key of any container its receiver reaches, so every publication had
   * to test every unknown read in the program against its own container.
   * That test does not depend on the key, and a container publishes many
   * keys, so the same whole-program scan was subscribed once PER KEY: this one
   * loop was the largest single source of the millions of observe edges the
   * solver carries on a large program. It is one node's fact, asked once per container.
   */
  const unknownReadsOf = (container: ObjectRoot): Query => nodeQuery('unknown-reads', container)
  const targets = (call: ts.CallExpression): Query => nodeQuery('targets', call)
  const superTargets = (call: ts.CallExpression): Query => nodeQuery('super-targets', call)
  /**
   * The method a lexical `super.<key>` selects, walking `extends` from the
   * home class the way the prototype chain does.
   *
   * `super` is a LOOKUP ORIGIN, not a receiver: the object used as `this` is
   * the instance, but the search for the callable starts one link up the
   * chain, so an override on the instance's own class is exactly what it skips.
   * Without this the graph's use walk read a `super` mention of the instance as
   * an ordinary member call on it, asked for the targets of a dispatch it
   * declines, and refused -- taking the enclosing ORDINARY call down with it,
   * because a method whose body contains `super.copy(v)` is a method whose
   * receiver closure could not be proven.
   *
   * Integrity is not re-derived here. Every class the walk visits must satisfy
   * `classConstructorKeepsInstanceOf`, the same authority the receiver family
   * already rests on, which is what refuses a program that writes
   * `Base.prototype.copy`.
   */
  const superLookup = (home: SourceClass, key: string, seen: Set<SourceClass>): readonly ts.MethodDeclaration[] | null => {
    if (!isClassSpelledSourceClass(home) || seen.has(home)) return null
    seen.add(home)
    const heritage = home.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    if (!heritage || heritage.types.length !== 1) return null
    const bases = sourceConstructorSelectionsOf(checker, flow, heritage.types[0]!.expression)
    if (!bases || bases.length === 0) return null
    const found: ts.MethodDeclaration[] = []
    for (const base of bases) {
      const own = ownSuperSlot(base, key, seen)
      if (own === null) return null
      found.push(...own)
    }
    return found
  }
  const ownSuperSlot = (owner: SourceClass, key: string, seen: Set<SourceClass>): readonly ts.MethodDeclaration[] | null => {
    if (!isClassSpelledSourceClass(owner)) return null
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    const instance = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (!instance?.isClassOrInterface() || !classConstructorKeepsInstanceOf(checker, flow, instance)) return null
    const own: ts.MethodDeclaration[] = []
    for (const member of owner.members) {
      if (!member.name || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0) continue
      if (ts.isPrivateIdentifier(member.name)) continue
      // An instance field lives on the RECEIVER, and a constructor is not on
      // the prototype at all: neither is where this lookup starts.
      if (ts.isPropertyDeclaration(member) || ts.isConstructorDeclaration(member)) continue
      const memberKey = declarationKey(member.name)
      // One computed member name makes the whole prototype's key set unknown,
      // so the absence of this key on this class is no longer a fact.
      if (memberKey === null) return null
      if (memberKey !== key) continue
      if (!ts.isMethodDeclaration(member) || member.body === undefined) return null
      own.push(member)
    }
    return own.length > 0 ? own : superLookup(owner, key, seen)
  }
  /**
   * The key is absent from this class's whole prototype chain.
   *
   * Absence is a chain-wide fact, so every step must be spelled: a computed
   * member name anywhere makes the key set unknown, a constructor the graph
   * cannot keep hold of its instance can add the key at run time, and a chain
   * that does not end at a class with no `extends` never reaches the point
   * where `Object.prototype` is the only thing left to ask about. Any of
   * those, and the key is not PROVEN absent -- which is a different answer
   * from proven present, and the caller must treat it as neither.
   */
  const chainAbsences = new Map<SourceClass, Map<string, boolean>>()
  const absentThroughChain = (owner: SourceClass, key: string, seen: Set<SourceClass>): boolean => {
    // The chain is syntax and a constructor proof, neither of which changes as
    // the graph settles -- but it is asked once per (root, key) reaching an
    // unspelled name, which on a deep class chain is a class-keeps-its-
    // instance proof per access. Memoized on the pair it actually depends on.
    let byKey = chainAbsences.get(owner)
    if (!byKey) chainAbsences.set(owner, (byKey = new Map()))
    const known = byKey.get(key)
    if (known !== undefined) return known
    // Only a walk that starts here is memoized: one entered mid-chain carries
    // the classes already visited, and its answer is about that path.
    const top = seen.size === 0
    const answer = absentThroughChainUncached(owner, key, seen)
    if (top) byKey.set(key, answer)
    return answer
  }
  const absentThroughChainUncached = (owner: SourceClass, key: string, seen: Set<SourceClass>): boolean => {
    if (!isClassSpelledSourceClass(owner) || seen.has(owner)) return false
    seen.add(owner)
    const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
    const instance = symbol && checker.getDeclaredTypeOfSymbol(symbol)
    if (!instance?.isClassOrInterface() || !classConstructorKeepsInstanceOf(checker, flow, instance)) return false
    for (const member of owner.members) {
      if (!member.name || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0) continue
      if (ts.isPrivateIdentifier(member.name)) continue
      const memberKey = declarationKey(member.name)
      if (memberKey === null || memberKey === key) return false
    }
    const heritage = owner.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    if (!heritage) return true
    if (heritage.types.length !== 1) return false
    const bases = sourceConstructorSelectionsOf(checker, flow, heritage.types[0]!.expression)
    if (!bases || bases.length === 0) return false
    return bases.every((base) => absentThroughChain(base, key, new Set(seen)))
  }

  /**
   * A key an object provably does not have -- for an instance, anywhere on
   * its chain; for a literal, among the keys it spells.
   *
   * `for ( const key in values ) this[ key ] = values[ key ]` -- an
   * options-applying `setValues` method -- stores to keys the class never declares. That is not an
   * unmodelled descriptor: with the key absent from the chain the store
   * creates a FRESH own data property, runs no accessor, and disturbs no slot
   * the graph tracks. What it is NOT is a readable cell: `slot` keeps refusing
   * the key, so a program that reads it back is opaque, and the value stored
   * into it can only be reached through the instance itself.
   *
   * The last link in the chain is `Object.prototype`, which is an obligation
   * rather than an observation -- registered here under exactly the key asked
   * about, and discharged later by the sealed host-mutation census. With no
   * ledger to carry it there is nothing that will ever discharge it, so the
   * absence does not hold.
   */
  const absentOwnKey = (
    root: ObjectRoot,
    key: string,
    at: ts.Node,
    descriptorOf: (root: ObjectRoot, key: string) => boolean,
    hasUnnamedWrite: (root: ObjectRoot) => boolean
  ): boolean => {
    if (ts.isObjectLiteralExpression(root) || isFreshOrdinaryObject(root)) {
      // A literal that spells every key it has proves the absence of every
      // key it does not. This is asked while walking the literal's OWN uses,
      // so a store that added an unspelled key is a refusal in the same walk.
      if (literalSpelledKeys(root) === null || descriptorOf(root, key) || hasUnnamedWrite(root)) return false
    } else if (ts.isNewExpression(root)) {
      const fact = construction(root)
      if (!fact || fact.alternatives.length === 0) return false
      if (!fact.alternatives.every((owner) => absentThroughChain(owner, key, new Set()))) return false
    } else return false
    return deferredIntrinsicProtocolLedgerOf(flow)?.requirePrototypeKeys('Object', { names: [key] }, at) === true
  }

  const readsByKey = new Map<string, { readonly access: Access; readonly receiver: Query }[]>()
  const unknownReads: { readonly access: Access; readonly receiver: Query }[] = []
  for (const access of flow.propertyAccesses) {
    const key = accessKey(access)
    const entry = { access, receiver: value(access.expression) }
    if (key === null) unknownReads.push(entry)
    else {
      let reads = readsByKey.get(key)
      if (!reads) readsByKey.set(key, (reads = []))
      reads.push(entry)
    }
  }
  /**
   * `unknownReads`, indexed by the query that answers what its RECEIVER
   * holds -- the one hop `case 'unknown-reads'` needs from a holder key (a
   * `Query`, handed back by `holdersOf`) to the access it belongs to.
   *
   * Built once, beside the list it indexes, for the same reason `readsByKey`,
   * `writeEdgeByAccess` and `constructionSitesByTarget` are: the mapping is
   * syntax and never changes as the graph solves, so computing it inside the
   * transfer would be paying a whole-list rebuild on every re-evaluation of
   * every container -- exactly the cost this inversion exists to remove.
   */
  const unknownReadsByReceiver = new Map<Query, { readonly access: Access; readonly receiver: Query }[]>()
  for (const entry of unknownReads) {
    let entries = unknownReadsByReceiver.get(entry.receiver)
    if (!entries) unknownReadsByReceiver.set(entry.receiver, (entries = []))
    entries.push(entry)
  }
  /**
   * Writes that go THROUGH some object, grouped by the name they write.
   *
   * Which root a write reaches is a solved question and changes as the graph
   * settles; which NAME it writes is syntax and never changes. Splitting the
   * two lets a descriptor ask about one key without walking every write in
   * the program -- the difference between a scan per key and a scan per
   * (key, root) pair, which is what made a large class family unfinishable.
   */
  const namedWrites = new Map<string, ValueFlowIndex['allWrites'][number][]>()
  const computedWrites: ValueFlowIndex['allWrites'][number][] = []
  /**
   * The same writes, already resolved to the query that answers what their
   * receiver holds.
   *
   * `value(access.expression)` is `unwrapErasedExpression` plus an interning
   * lookup, and the answer is a property of the syntax: it cannot change. Asked
   * per edge read it was a third of a large program's compile -- split
   * between `nodeQuery` and `unwrapErased` -- for a value computed once and then recomputed
   * millions of times. Resolving it with the index costs one pass over the
   * writes and leaves the observation itself as the only per-edge work.
   */
  interface WriteEdge {
    readonly access: Access
    readonly receiver: Query
    readonly key: string | null
    readonly write: ValueFlowIndex['allWrites'][number]
  }
  const namedWriteReceivers = new Map<string, WriteEdge[]>()
  /** The receiver queries of every computed write, for `hasUnnamedWrite`'s reverse lookup. */
  const computedWriteReceiverQueries = new Set<Query>()
  const computedWriteEdgesByReceiver = new Map<Query, WriteEdge[]>()
  const writeEdgeByAccess = new Map<Access, WriteEdge>()
  for (const write of flow.allWrites) {
    const access = write.propertyAccess
    if (!access) continue
    const key = accessKey(access)
    const edge: WriteEdge = { access, receiver: value(access.expression), key, write }
    writeEdgeByAccess.set(access, edge)
    if (key === null) {
      computedWrites.push(write)
      computedWriteReceiverQueries.add(edge.receiver)
      const edges = computedWriteEdgesByReceiver.get(edge.receiver) ?? []
      edges.push(edge)
      computedWriteEdgesByReceiver.set(edge.receiver, edges)
    } else {
      let entries = namedWrites.get(key)
      if (!entries) namedWrites.set(key, (entries = []))
      entries.push(write)
      let edges = namedWriteReceivers.get(key)
      if (!edges) namedWriteReceivers.set(key, (edges = []))
      edges.push(edge)
    }
  }

  /**
   * The declaration an import actually names.
   *
   * `import { inspect } from './m'` declares an ALIAS, whose own declaration
   * is the import specifier -- a name for a name. Every consumer here wants
   * the thing named: the function, the class, the binding in the other file.
   * A barrel re-export is that same question asked twice, so the checker's own
   * alias resolution does the walking rather than one hop of it.
   *
   * A namespace import is deliberately NOT resolved: `import * as api` names
   * an object carrying every export as a slot, which is a different value
   * from any one of them, and collapsing it would let a namespace that
   * escaped look like a callable that did not.
   */
  const aliasedDeclarationOf = (symbol: ts.Symbol | undefined): ts.Declaration | null => {
    if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return null
    const named = symbol.declarations ?? []
    if (named.length === 0) return null
    if (
      !named.every(
        (declaration) => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isExportSpecifier(declaration)
      )
    )
      return null
    const aliased = checker.getAliasedSymbol(symbol).declarations ?? []
    return aliased.length === 1 ? aliased[0]! : null
  }

  const slot = (root: ObjectRoot, key: string): Query => {
    let keys = slots.get(root)
    if (!keys) slots.set(root, (keys = new Map()))
    let query = keys.get(key)
    if (!query) keys.set(key, (query = { kind: 'slot', node: root, key }))
    return query
  }
  const storedSlot = (root: ObjectRoot, key: string): Query => {
    let keys = storedSlots.get(root)
    if (!keys) storedSlots.set(root, (keys = new Map()))
    let query = keys.get(key)
    if (!query) keys.set(key, (query = { kind: 'stored-slot', node: root, key }))
    return query
  }
  const use = (root: Value, reference: ts.Expression): Query => {
    let refs = uses.get(root)
    if (!refs) uses.set(root, (refs = new Map()))
    let query = refs.get(reference)
    if (!query) refs.set(reference, (query = { kind: 'use', root, node: reference }))
    return query
  }
  const publication = (root: Value, container: ObjectRoot, key: string): Query => {
    let containers = publications.get(root)
    if (!containers) publications.set(root, (containers = new Map()))
    let keys = containers.get(container)
    if (!keys) containers.set(container, (keys = new Map()))
    let query = keys.get(key)
    if (!query) keys.set(key, (query = { kind: 'publication', root, node: container, key }))
    return query
  }
  /** The cell holding the object a binding element takes apart, as a query. */
  const bindingContainer = (element: ts.BindingElement): Query | null => {
    const holder = element.parent.parent
    if (ts.isParameter(holder)) return holder.dotDotDotToken ? null : nodeQuery('parameter', holder)
    if (ts.isBindingElement(holder)) return nodeQuery('binding-element', holder)
    return ts.isVariableDeclaration(holder) && holder.initializer ? value(holder.initializer) : null
  }
  const construction = (root: ts.NewExpression): SourceConstructionFact | null => exactSourceConstructionOf(checker, flow, root)
  /**
   * What a key names on this construction: its data member, or the method the
   * call through it dispatches to.
   *
   * Both, because a slot is a slot. Asking only for data meant
   * `descriptor(new App(), 'go')` was false, so the simplest class call in the
   * language -- `const a = new App(); a.go()` -- resolved its receiver and then
   * had no slot to read the callee out of.
   */
  const classMembers = (root: ts.NewExpression, key: string): readonly ts.Declaration[] | null => {
    const fact = construction(root)
    if (!fact) return null
    const found = new Set<ts.Declaration>()
    for (const owner of fact.alternatives) {
      const symbol = owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
      if (!symbol) return null
      const query = { kind: 'declared', receiver: checker.getDeclaredTypeOfSymbol(symbol) } as const
      const plan = sourceClassDataMemberPlanOf(checker, flow, query, key) ?? sourceClassCallableMemberPlanOf(checker, flow, query, key)
      if (!plan) return null
      for (const declaration of plan.declarations) found.add(declaration)
    }
    return [...found]
  }
  const classSymbolOf = (owner: SourceClass): ts.Symbol | undefined =>
    owner.name ? checker.getSymbolAtLocation(owner.name) : checker.getTypeAtLocation(owner).getSymbol()
  /**
   * A read of `key` on this construction by the key-read plan of every class
   * it can be: the source getter bodies it can enter, the data declarations
   * the key selects, and whether some class lacks the key (the read is then
   * `undefined` there). Null when some class's read is opaque -- a method,
   * a bodiless getter, an unseen member kind. `classMembers` answers first
   * for the all-data and all-method keys; this covers the mixed and the
   * accessor families it refuses.
   *
   * `source.attachment` in a `copy( source )` method: the key is a getter
   * over `this._attachment`, and the read was an unmodelled descriptor --
   * which made every value reaching that attachment opaque,
   * `current.owner = this` in its setter included.
   */
  const familyReadOf = (
    root: ts.NewExpression,
    key: string
  ): {
    readonly getters: readonly ts.GetAccessorDeclaration[]
    readonly carriers: readonly ts.Declaration[]
    readonly absent: boolean
  } | null => {
    const fact = construction(root)
    if (!fact || fact.alternatives.length === 0) return null
    const getters = new Set<ts.GetAccessorDeclaration>()
    const carriers = new Set<ts.Declaration>()
    let absent = false
    for (const owner of fact.alternatives) {
      const symbol = classSymbolOf(owner)
      if (!symbol) return null
      const plan = sourceClassKeyReadPlanOf(checker, flow, { kind: 'declared', receiver: checker.getDeclaredTypeOfSymbol(symbol) }, key)
      if (!plan || plan.readBodies === null) return null
      for (const body of plan.readBodies) getters.add(body)
      for (const carrier of plan.carriers) carriers.add(carrier.declaration)
      if (plan.needsDefaultPrototype) absent = true
    }
    return { getters: [...getters], carriers: [...carriers], absent }
  }
  /**
   * Whether a plain store to `key` on this construction writes DATA on every
   * class it can be -- an own data member, or a key the class lacks and so
   * creates (with `Object.prototype` proven to hold no setter for it, which
   * the key-read plan registers). `this.isSpecialTarget = true` in a
   * subclass constructor, reached through a
   * `new this.constructor()` whose alternatives include the base class that
   * has no such member: the data-member plan refuses a key absent on any
   * owner, and the store was an unmodelled descriptor.
   */
  const dataStoreOf = (root: ts.NewExpression, key: string): boolean => {
    const fact = construction(root)
    if (!fact || fact.alternatives.length === 0) return false
    for (const owner of fact.alternatives) {
      const symbol = classSymbolOf(owner)
      if (!symbol) return false
      const plan = sourceClassKeyReadPlanOf(checker, flow, { kind: 'declared', receiver: checker.getDeclaredTypeOfSymbol(symbol) }, key)
      if (!plan || !plan.codeFree) return false
    }
    return true
  }
  /** The complete set of source setters a plain store to `key` on this construction runs, or null when that is opaque. */
  const settersOf = (root: ts.NewExpression, key: string): readonly ts.SetAccessorDeclaration[] | null => {
    const fact = construction(root)
    if (!fact || fact.alternatives.length === 0) return null
    const bodies = new Set<ts.SetAccessorDeclaration>()
    for (const owner of fact.alternatives) {
      const symbol = classSymbolOf(owner)
      if (!symbol) return null
      const plan = sourceClassKeyReadPlanOf(checker, flow, { kind: 'declared', receiver: checker.getDeclaredTypeOfSymbol(symbol) }, key)
      if (!plan?.writeBodies || plan.writeBodies.length === 0) return null
      for (const setter of plan.writeBodies) bodies.add(setter)
    }
    return [...bodies]
  }
  /**
   * `Object.assign( target, ...sources )` on the intact intrinsic: the one
   * bulk write this graph models. The call evaluates to its target, and each
   * source's own slot values are copied into the target's slots -- a
   * constructor that builds its `options` from defaults does exactly this.
   */
  /** The rebinding `parameter = <right>` whose right side holds `read`, when
   * that read cannot run again after it within the same cell: the read is in
   * the parameter's own body (not a nested function) and no loop of that body
   * encloses it. */
  const rebindingAfterRead = (parameter: ts.ParameterDeclaration, read: ts.Identifier): ts.Node | null => {
    const owner = parameter.parent
    if (ts.findAncestor(read.parent, ts.isFunctionLike) !== owner) return null
    for (const write of flow.writesToDeclaration(parameter)) {
      if (write.slot !== 'whole' || write.edge !== 'identifier-assignment' || !write.value) continue
      if (write.value.getSourceFile() !== read.getSourceFile() || read.pos < write.value.pos || read.end > write.value.end) continue
      return ts.findAncestor(read, (node) => node === owner || ts.isIterationStatement(node, false)) === owner ? write.site : null
    }
    return null
  }
  /** Whether `reference` runs only after a statement of its parameter's own
   * body that every path executes first rebinds the parameter whole
   * (`options = Object.assign( { ... }, options )` opening a
   * constructor): the cell then holds what some write after entry stored,
   * never the incoming argument as such. A reference in a nested callable is
   * not ordered by statements -- a hoisted declaration can run before the
   * rebinding. */
  const readsAfterRebinding = (parameter: ts.ParameterDeclaration, reference: ts.Node): boolean => {
    const owner = parameter.parent
    const body = 'body' in owner ? owner.body : undefined
    if (!body || !ts.isBlock(body) || ts.findAncestor(reference.parent, ts.isFunctionLike) !== owner) return false
    const at = body.statements.findIndex((one) => one.pos <= reference.pos && reference.end <= one.end)
    return (
      at >= 0 &&
      flow
        .writesToDeclaration(parameter)
        .some(
          (write) =>
            write.slot === 'whole' &&
            write.edge === 'identifier-assignment' &&
            ts.isExpressionStatement(write.site.parent) &&
            write.site.parent.parent === body &&
            body.statements.indexOf(write.site.parent) < at
        )
    )
  }
  const PARAMETER_ENTRY_EDGES: ReadonlySet<FlowEdgeKind> = new Set([
    'call-argument',
    'super-argument',
    'rest-argument',
    'default-parameter'
  ])
  /** The writes that can replace a parameter's value after entry: everything
   * but the arguments and the default it is bound from. */
  const parameterRebindingsOf = (parameter: ts.ParameterDeclaration): readonly ValueWrite[] =>
    flow.writesToDeclaration(parameter).filter((write) => !PARAMETER_ENTRY_EDGES.has(write.edge))
  const bulkAssignOf = (call: ts.CallExpression): { readonly target: ts.Expression; readonly sources: readonly ts.Expression[] } | null => {
    if (!isGlobalObjectAssign(checker, call)) return null
    const [target, ...sources] = call.arguments
    if (!target || call.arguments.some(ts.isSpreadElement)) return null
    if (deferredIntrinsicProtocolLedgerOf(flow)?.requireMember('Object', 'assign', call) !== true) return null
    return { target, sources }
  }
  /**
   * `Object.defineProperty( target, key, { value } )` on the intact intrinsic:
   * a store of the descriptor's `value` into `key` of the target, running no
   * code of the target's. JS classes that define a read-only `id` this
   * way in their constructors had the target's use as the call's argument
   * read as a call with no source target -- so every instance was opaque.
   * `defineProperties` is lowered to this form by the source transform and is
   * not modelled here.
   */
  const definitionPlans = new Map<ts.CallExpression, IntrinsicDataDefinitionPlan>()
  const definitionReceivers = new Map<string, { readonly receiver: Query }[]>()
  for (const site of flow.calls) {
    const call = site.call
    if (!ts.isCallExpression(call) || call.arguments.length < 2) continue
    const plan = intrinsicDataDefinitionTargetOf(checker, call.arguments[0]!, (declaration, argument) =>
      flow.referencesToDeclaration(declaration).every((mention) => mention === declaration.name || mention === argument)
    )
    if (plan === null || plan.member !== 'defineProperty') continue
    definitionPlans.set(call, plan)
    for (const key of plan.keys) {
      let entries = definitionReceivers.get(key)
      if (!entries) definitionReceivers.set(key, (entries = []))
      entries.push({ receiver: value(call.arguments[0]!) })
    }
  }
  const definitionOf = (call: ts.CallExpression): IntrinsicDataDefinitionPlan | null => {
    const plan = definitionPlans.get(call)
    if (!plan) return null
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    if (ledger?.requireMember(plan.owner, plan.member, call) !== true) return null
    if (plan.descriptorPrototypeKeys.length > 0 && !ledger.requirePrototypeKeys('Object', { names: plan.descriptorPrototypeKeys }, call))
      return null
    return plan
  }
  const ownEntries = (root: ts.ObjectLiteralExpression, key: string): readonly ts.ObjectLiteralElementLike[] | null => {
    const entries: ts.ObjectLiteralElementLike[] = []
    for (const entry of root.properties) {
      if (ts.isSpreadAssignment(entry)) return null
      const name = declarationKey(entry.name)
      if (name === null || name === '__proto__') return null
      if (name !== key) continue
      if (ts.isGetAccessorDeclaration(entry) || ts.isSetAccessorDeclaration(entry)) return null
      entries.push(entry)
    }
    return entries.length > 0 ? entries : null
  }
  const descriptor = (root: ObjectRoot, key: string): boolean => {
    if (isFreshOrdinaryObject(root)) return false
    if (ts.isNewExpression(root)) return classMembers(root, key) !== null
    if (ts.isObjectLiteralExpression(root)) return ownEntries(root, key) !== null
    if (isSourceCallableObject(root)) return key === 'name' || key === 'length'
    if (!ts.isArrayLiteralExpression(root)) return false
    if (key === 'length') return true
    // An index the literal does not spell is still the array's own: it reads
    // `undefined` until an index store fills it, and `case 'slot'` reads the
    // stores through `keyReaches`. A class that starts with
    // `this.items = []`, fills it by index in the constructor, and has an
    // `item` getter reading `this.items[ 0 ]` is the shape.
    return (key === ELEMENT_KEY || isCanonicalIndex(key)) && !root.elements.some(ts.isSpreadElement)
  }
  const ownersOf = (root: ts.NewExpression): readonly SourceClass[] => constructionFrames.receiverOwnersOf(root) ?? []
  /**
   * Every construction of each owning class, built once.
   *
   * `belongsTo` is decided by `receiverOwnersOf`, which reads the index and
   * nothing a solve revises, so the whole relation is known before the first
   * query. Two transfers were rediscovering it by walking every call in the
   * program per query.
   */
  /**
   * The calls that can dispatch to a body, decided by NAME before any solving.
   *
   * A call's targets are its callee's VALUES, and a body enters a value set
   * only as the name it is declared or stored under: `value` of a property
   * access reads `slot(root, key)`, and a store into that slot is spelled with
   * the same key, so a callee spelling some OTHER name cannot produce this body
   * however the graph solves. Three transfers -- a parameter's frame, a
   * receiver's frame and a completion's use -- asked anyway, by observing
   * `targets` of EVERY call in the program, per query. That forced the entire
   * program's dispatch graph from each of them and was a large program's compile time:
   * the fan-out, not any one answer. `callersOf` below is the fix for the
   * fan-out; this function is unchanged and still returns the same
   * whole-program list for an unnamed body -- only how many times that list
   * gets walked has changed.
   *
   * `unspelledCallees` is every call this layer cannot name -- a computed
   * element access, a call result, anything but an identifier or a static key
   * -- and is a candidate for every body, so the restriction only ever removes
   * calls that were already impossible. A body whose own names cannot be
   * enumerated falls back to the whole list rather than to a guess.
   *
   * That fallback fires for every anonymous body handed straight to
   * a host/intrinsic callee -- `[].map(x => ...)`, `setTimeout(() => ...)` --
   * because `ValueWrite.naming` only spells "the parameter's name for a call
   * argument" when the callee is a SOURCE function; a host callee's parameter
   * is never spelled, so `namesOf` meets an unnamed write and returns null.
   * It is tempting to narrow this to just the receiving call site, since the
   * body is never stored under a name and so cannot be READ back and called
   * from anywhere this layer's write census would see. That is not the same
   * as proving no OTHER call reaches it: a host function is free to retain the
   * callback it was handed and invoke it again later through a binding this
   * layer never inventories (a memoized comparator, a registered listener), so
   * "receiving call site only" is not provably a superset. Left as the whole
   * list rather than landing an unsound narrowing.
   */
  let calleeNames: Map<string, FlowCallSite[]> | null = null
  let unspelledCallees: FlowCallSite[] = []
  const buildCalleeIndex = (): Map<string, FlowCallSite[]> => {
    if (calleeNames !== null) return calleeNames
    const index = new Map<string, FlowCallSite[]>()
    const unspelled: FlowCallSite[] = []
    for (const site of flow.calls) {
      // `new F( ... )` is indexed under F's spelling too: on a plain function it
      // is a caller frame (`case 'callers'`), which the construction domain
      // never names.
      if (!ts.isCallExpression(site.call) && !ts.isNewExpression(site.call)) continue
      const own = ts.isCallExpression(site.call) ? candidateOrdinaryOwnCallableOperandsOf(site.call) : null
      const callee = site.operands ? unwrapErasedExpression(own?.callee ?? site.operands.callee) : null
      const name = callee
        ? ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? accessKey(callee)
            : null
        : null
      if (name === null) unspelled.push(site)
      else {
        let held = index.get(name)
        if (!held) index.set(name, (held = []))
        held.push(site)
      }
    }
    unspelledCallees = unspelled
    calleeNames = index
    return index
  }
  /** Every name a body can be reached by: its own, and every cell it is stored in. */
  const bodyNames = new Map<ts.SignatureDeclaration, readonly string[] | null>()
  const namesOf = (body: ts.SignatureDeclaration): readonly string[] | null => {
    const known = bodyNames.get(body)
    if (known !== undefined) return known
    const names = new Set<string>()
    const declared = ts.getNameOfDeclaration(body)
    // A value installed on a Function can be read through any immutable alias
    // of that own member. Its declaration's spelling does not enumerate those
    // callers, so keep the complete indexed call set for this bounded family.
    if (
      flow.calls.some((site) => {
        const installed = ts.isCallExpression(site.call) ? sourceCallableReflectSetOf(checker, site.call) : null
        return installed !== null && sourceCallableObjectOf(checker, flow, installed.value) === body
      }) ||
      flow.allWrites.some(
        (write) => write.propertyAccess !== null && write.value !== null && sourceCallableObjectOf(checker, flow, write.value) === body
      )
    ) {
      bodyNames.set(body, null)
      return null
    }
    if (declared) {
      const key =
        ts.isIdentifier(declared) || ts.isStringLiteralLike(declared) ? declared.text : declarationKey(declared as ts.PropertyName)
      if (key === null) {
        bodyNames.set(body, null)
        return null
      }
      names.add(key)
    }
    // A function expression or arrow is reached by whatever holds it. Every
    // write whose VALUE is this body names one such cell; a write this layer
    // cannot name means the body can be reached by a name it cannot enumerate.
    if (!declared || ts.isFunctionExpression(body) || ts.isArrowFunction(body))
      for (const write of flow.allWrites) {
        if (write.value === undefined || write.value === null || unwrapErasedExpression(write.value) !== body) continue
        const named = write.member ?? (write.naming && ts.isIdentifier(write.naming) ? write.naming.text : null)
        if (named === null) {
          bodyNames.set(body, null)
          return null
        }
        names.add(named)
      }
    const answer = names.size > 0 ? [...names] : null
    bodyNames.set(body, answer)
    return answer
  }
  /** The declared instance type of a class member's holder; null for anything a stated type cannot exclude callers of. */
  const ownerInstanceTypeOf = (owner: ts.SignatureDeclaration): ts.Type | null => {
    if (!ts.isClassElement(owner) || !ts.isClassLike(owner.parent)) return null
    if ((ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Static) !== 0) return null
    const symbol = classSymbolOf(owner.parent)
    if (!symbol) return null
    const declared = checker.getDeclaredTypeOfSymbol(symbol)
    return declared.isClassOrInterface() ? declared : null
  }
  const statedTypeAdmits = (stated: ts.Type, instance: ts.Type): boolean => {
    if ((stated.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true
    if (stated.isUnion()) return stated.types.some((member) => statedTypeAdmits(member, instance))
    if ((stated.flags & ts.TypeFlags.Object) === 0) return false
    return checker.isTypeAssignableTo(instance, stated)
  }
  const candidateCallersOf = (body: ts.SignatureDeclaration): readonly FlowCallSite[] => {
    const index = buildCalleeIndex()
    const names = namesOf(body)
    if (names === null) return flow.calls
    // `unspelledCallees` is a whole-program list and this runs once per
    // TRANSFER, not once per program -- `[...unspelledCallees]` copied it on
    // every call just to push a handful of named matches on top. `both`
    // hands it back by reference when there is nothing to add.
    const named: FlowCallSite[] = []
    for (const name of names) for (const site of index.get(name) ?? []) named.push(site)
    return both(unspelledCallees, named)
  }
  /**
   * The calls that actually target this body -- the same question
   * `candidateCallersOf(owner)` plus a `targets` filter answers, asked ONCE
   * per body instead of once per consumer.
   *
   * A parameter's frame, a receiver's frame and a return statement's
   * completion each used to run that filter themselves, inside their own
   * transfer: `for (const site of candidateCallersOf(owner)) if (...
   * observe(targets(site.call)).has(owner)) ...`. For a NAMED body
   * `candidateCallersOf` is already small and the repetition was cheap. For
   * an anonymous body handed to a host callee it is `flow.calls` -- every
   * call site in the program -- and every parameter of such a body, plus
   * its receiver, plus every one of its return statements, walked and
   * `observe`d that entire list separately. On a large program the
   * `parameter` states alone carried hundreds of thousands of observe edges
   * this way, almost all of it the same whole-program filter re-run for the
   * same owner.
   *
   * This is `unknownReadsOf`'s shape exactly: a whole-program list, tested
   * against one thing, wanted by many consumers of that one thing. Giving the
   * filter its own node means the solver runs it once per owner and caches
   * the (small) result; every consumer then pays one `observe` edge to reach
   * it, discovery-only exactly as the inline `observe(targets(...))` was, so
   * none of them is required to wait for `callers` to settle before they
   * report what they already know.
   */
  //
  // Consumers `read` it, not `observe` it: the node carries the closure
  // requirements that make its caller set complete, and a frame built from
  // the discovered calls alone would be complete over an open caller set.
  const callersOf = (owner: ts.SignatureDeclaration): Query => nodeQuery('callers', owner)
  /** The writes a `for...of` binding receives from, out of every write the program makes; asked by each array literal's element publication on every re-evaluation. */
  let valueIterationWrites: readonly (typeof flow.allWrites)[number][] | null = null
  /**
   * The part of `case 'callers'` that no fact can move: which candidate sites
   * are syntax-and-checker matches for `owner`. The transfer re-ran it on
   * every re-evaluation, asking the checker for each member receiver's type and
   * its assignability to the owner's class each time; on a large program that
   * was the session's heaviest transfer. Kept in site order, so the facts the
   * transfer adds keep their order.
   */
  const callerCandidates = new Map<ts.SignatureDeclaration, readonly CallerCandidate[]>()
  const callerCandidatesOf = (owner: ts.SignatureDeclaration): readonly CallerCandidate[] => {
    const known = callerCandidates.get(owner)
    if (known !== undefined) return known
    const ownerType = ownerInstanceTypeOf(owner)
    const answer: CallerCandidate[] = []
    for (const site of candidateCallersOf(owner)) {
      // `new Factory( state )` on a plain function enters the
      // function's own argument frame exactly as a call would; the
      // construction domain names no class for it, so it is a caller.
      if (ts.isNewExpression(site.call)) {
        if (ts.isFunctionDeclaration(owner) && constructorFunctionCalleeOf(site.call) === owner) answer.push({ site, call: null })
        continue
      }
      if (!ts.isCallExpression(site.call)) continue
      if (ownerType !== null && !site.explicitThis && site.operands.dispatch.kind === 'member' && site.operands.receiver !== null) {
        if (!statedTypeAdmits(checker.getTypeAtLocation(site.operands.receiver), ownerType)) continue
      }
      answer.push({ site, call: site.call })
    }
    callerCandidates.set(owner, answer)
    return answer
  }
  let constructionsByOwner: Map<ts.Node, ts.NewExpression[]> | null = null
  /**
   * Every site that constructs: a `new`, or a `super(...)` standing in for one.
   *
   * The predicate is syntax and never moves, but it was asked inside the
   * `parameter` transfer, so proving one parameter's frame walked every call in
   * the program -- and did it again on every re-evaluation.
   *
   * Worse than the walk was what the walk SUBSCRIBED to. `construct-targets`
   * neither reads nor observes: it is `constructionFrames.targetsOf` and
   * nothing else, fixed before the first transfer runs. So the 854 edges a
   * parameter registered were edges to constants -- they could never carry a
   * wake-up, and they existed only to force the leaf's state into being. Asked
   * the other way round, as an index from target to the sites that construct
   * it, the answer is the same set and the edges are none.
   */
  const NO_READS: readonly { readonly access: Access; readonly receiver: Query }[] = []
  const NO_SITES: readonly FlowCallSite[] = []
  let constructionSitesByTarget: Map<ts.Node, FlowCallSite[]> | null = null
  const constructionSitesTargeting = (owner: ts.Node): readonly FlowCallSite[] => {
    if (constructionSitesByTarget === null) {
      constructionSitesByTarget = new Map()
      for (const site of flow.calls) {
        if (!ts.isNewExpression(site.call) && site.operands.dispatch.kind !== 'super-constructor') continue
        for (const target of constructionFrames.targetsOf(site.call) ?? []) {
          let held = constructionSitesByTarget.get(target)
          if (!held) constructionSitesByTarget.set(target, (held = []))
          held.push(site)
        }
      }
    }
    return constructionSitesByTarget.get(owner) ?? NO_SITES
  }
  /**
   * The `new` sites the construction domain cannot place, found once. A
   * class member's instances are `constructionsOf` its family, and that list
   * is complete only while none of these names a family class: `new Owner()`
   * after `Owner.prototype.take = replacement` is an Owner the domain refused,
   * not a non-Owner. Only the stated instance type can say which class such a
   * site names; a site typed `any` names none, and the class value's own
   * closure (the family inventory) already says it flows into no table.
   */
  let opaqueConstructions: readonly ts.NewExpression[] | null = null
  const opaqueConstructionsOf = (): readonly ts.NewExpression[] => {
    if (opaqueConstructions === null) {
      const found: ts.NewExpression[] = []
      for (const site of flow.calls)
        if (ts.isNewExpression(site.call) && constructionFrames.receiverOwnersOf(site.call) === null) found.push(site.call)
      opaqueConstructions = found
    }
    return opaqueConstructions
  }
  const constructionsOf = (owner: ts.Node): readonly ts.NewExpression[] => {
    if (constructionsByOwner === null) {
      constructionsByOwner = new Map()
      for (const site of flow.calls) {
        if (!ts.isNewExpression(site.call)) continue
        for (const candidate of ownersOf(site.call)) {
          let held = constructionsByOwner.get(candidate)
          if (!held) constructionsByOwner.set(candidate, (held = []))
          held.push(site.call)
        }
      }
    }
    const own = constructionsByOwner.get(owner) ?? []
    const inherited = owner.parent ? (constructionsByOwner.get(owner.parent) ?? []) : []
    return inherited.length === 0 ? own : own.length === 0 ? inherited : [...new Set([...own, ...inherited])]
  }
  const isCallableValue = (node: Value): node is ts.SignatureDeclaration => isBody(node)

  /**
   * The enumerated expression, when this key expression is a `for-in` head.
   *
   * `for ( const key in values ) this[ key ] = values[ key ]` -- an
   * options-applying `setValues` method, typically a JS program's single
   * largest computed-store family. `key`
   * names no VALUE the graph can carry, so `value(key)` correctly answers
   * nothing and the access refuses on an unresolved key. What the graph CAN
   * answer is what `values` holds, and an object literal spells its own keys.
   *
   * The head is a fresh binding each round. A body that assigns to it is
   * naming something other than the enumerated key, so any write disqualifies
   * the whole head rather than being folded into the set.
   */
  const enumerationHeads = new Map<ts.Expression, ts.Expression | null>()
  const enumerationHeadOf = (expression: ts.Expression): ts.Expression | null => {
    const known = enumerationHeads.get(expression)
    if (known !== undefined) return known
    const answer = enumerationHeadUncached(expression)
    enumerationHeads.set(expression, answer)
    return answer
  }
  const enumerationHeadUncached = (expression: ts.Expression): ts.Expression | null => {
    const reference = unwrapErasedExpression(expression)
    if (!ts.isIdentifier(reference)) return null
    const declaration = flow.targetOf(reference)?.declaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return null
    const statement = list.parent
    if (!ts.isForInStatement(statement) || statement.initializer !== list) return null
    if (flow.writesToDeclaration(declaration).some((write) => write.edge !== 'iteration-binding')) return null
    return statement.expression
  }

  /** The own keys an object literal spells, or nothing when a spread or a
   * computed name means the literal does not spell them all. Under-reporting a
   * key set is not a smaller answer, it is a wrong one: it would leave a slot
   * the program actually stores into looking untouched. */
  const literalSpelledKeys = (root: Value): readonly string[] | null => {
    if (isFreshOrdinaryObject(root)) return []
    if (!ts.isObjectLiteralExpression(root)) return null
    const keys: string[] = []
    for (const property of root.properties) {
      if (ts.isSpreadAssignment(property)) return null
      const key = declarationKey(property.name)
      if (key === null || key === '__proto__') return null
      keys.push(key)
    }
    return keys
  }

  /**
   * The keys a `for-in` head binds: the own keys of every root the enumerated
   * expression can hold. The dependency goes into the graph -- `value(...)` on
   * the enumerated expression -- rather than to a second key-set authority
   * asking the same question a different way.
   *
   * `Object.prototype` must carry no enumerable string key of its own, or the
   * head walks keys no root spells. That obligation is deferred to the ledger,
   * exactly as the legacy key-set authority defers it; with no ledger to carry
   * it there is nothing to discharge it later, so the enumeration refuses.
   */
  const enumeratedKeysOf = (
    access: ts.ElementAccessExpression,
    enumerated: ts.Expression,
    read: Read,
    fail: (reason: string, node?: ts.Node) => void,
    sealing: boolean,
    ownKeysOf: (root: Value) => readonly string[] | null
  ): readonly string[] => {
    if (!deferredIntrinsicProtocolLedgerOf(flow)?.require('Object', access)) {
      fail('undeferrable-enumeration-protocol', access)
      return []
    }
    const keys = new Set<string>()
    const roots = read(value(enumerated))
    for (const root of roots) {
      // `for ( key in undefined )` binds nothing: a base constructor runs
      // `setValues( parameters )` even for a bare `new Subclass()`.
      if (isNullish(root)) continue
      const own = ownKeysOf(root)
      if (own === null) {
        fail('unspelled-enumeration-root', isObjectRoot(root) ? root : enumerated)
        continue
      }
      // A literal spells its keys only while nothing else adds one, and the
      // graph already refuses a store to a key an object literal does not
      // declare -- so the root's own closure IS that proof. It is required
      // here rather than assumed: an under-reported key set leaves a slot the
      // program actually writes looking untouched, which is a wrong answer
      // wearing a smaller one's clothes.
      read(closure(root))
      for (const key of own) keys.add(key)
    }
    if (sealing && roots.size === 0) fail('unresolved-enumeration', enumerated)
    return [...keys]
  }

  // One object per (node, reason) for the whole session. The solver compares
  // a re-seal's causes by identity, and a fresh literal per evaluation made
  // every unchanged refusal look like a changed seal -- each one threw away
  // the component solve and re-expanded the whole sealed graph.
  const internedCauses = new Map<ts.Node, Map<string, Cause>>()
  const causeOf = (reason: string, node: ts.Node): Cause => {
    let byReason = internedCauses.get(node)
    if (byReason === undefined) internedCauses.set(node, (byReason = new Map()))
    let cause = byReason.get(reason)
    if (cause === undefined) byReason.set(reason, (cause = { reason, node }))
    return cause
  }
  const define = (query: Query): DependencyFactDefinition<Query, Value, Cause> => {
    let finalCauses: readonly Cause[] = []
    let finalGrounding: readonly { readonly domain: string; readonly dependency: Query }[] = []
    let seeded = false
    /**
     * Own-key answers, kept across this node's re-evaluations. A for-in head
     * over an options-applying `setValues( values )` asks the own keys of every
     * parameter literal the program passes to any constructor in the family, and
     * the transfer re-runs each time any of those roots' closures gains a
     * value -- rescanning every root, on a large program the second-largest self-time
     * entry of the compile. Facts only grow, so a fact set of the same SIZE as
     * when the answer was computed is the same set: each answer stamps every
     * set it read, and a re-evaluation replays it while the stamps hold. The
     * edges those reads registered persist on this node's state, so a replay
     * still wakes this node when any of them moves.
     */
    interface OwnKeysAnswer {
      readonly keys: readonly string[] | null
      readonly stamps: readonly (readonly [ReadonlySet<Value>, number])[]
      readonly holderStamps: readonly (readonly [Value, number])[]
    }
    const ownKeysAnswers = new Map<Value, OwnKeysAnswer>()
    const evaluate = (
      required: Read,
      observe: Read,
      holdersOf: DependencyFactHoldersOf<Query, Value>,
      sealing: boolean
    ): ReadonlySet<Value> => {
      const facts = new Set<Value>()
      const causes: Cause[] = []
      const grounding = new Set<Query>()
      const fail = (reason: string, node: ts.Node = query.node): void => {
        causes.push(causeOf(reason, node))
        if (refusalDebug) {
          const file = node.getSourceFile()
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
          const text = node.getText(file).replace(/\s+/g, ' ')
          console.error(`[SESSION-REFUSAL] ${reason} ${query.kind} ${file.fileName.split('/').pop()}:${line + 1} ${text.slice(0, 90)}`)
        }
      }
      // No edge ledger of our own: the solver records every required edge, and
      // `obligations` walks its copy. Keeping a second one cost a map lookup
      // and a set insert on every edge read in the program -- the largest
      // single self-time entry in a large program's profile once the state lookup
      // beside it was gone -- and a duplicate of the whole proof graph in a
      // solve that was already running out of heap.
      const read: Read = required
      const carry = (dependency: Query): ReadonlySet<Value> => {
        grounding.add(dependency)
        return read(dependency)
      }
      const add = (values: Iterable<Value>): void => {
        for (const held of values) facts.add(held)
      }
      /**
       * A member call whose receiver holds nothing but `null`/`undefined`
       * throws at the lookup: no target, no frame, no completion -- and no
       * refusal, since the throw is the program's own answer. A `copy( source )`
       * method running `source.attachment.clone()` under a guard this graph
       * does not read, where every value `attachment` holds is `null`, is the
       * shape.
       */
      const lookupThrows = (call: ts.CallExpression): boolean => {
        const site = sites.get(call)
        const operands = candidateOrdinaryOwnCallableOperandsOf(call) ?? site?.operands
        if (!operands || operands.explicitThis || operands.dispatch.kind !== 'member' || operands.receiver === null) return false
        const held = read(value(operands.receiver))
        return held.size > 0 && [...held].every(isNullish)
      }
      /**
       * The keys a named write through a root adds to it.
       *
       * `const values = { mode: 1, flip: false }; values.wrap = w` --
       * an options literal extended after creation. The literal SPELLS two keys and the program
       * gives it a third, so the spelling is not the key set. `case 'slot'`
       * already reads those writes; without them in the descriptor the very
       * slot they write was refused before it could be read -- the descriptor
       * answering about the LITERAL when it was asked about the OBJECT.
       *
       * Only literals are asked. A class instance's absent keys are a chain
       * proof rather than a spelling, and `this[ key ] = v` inside a method
       * would otherwise leave every instance's key set unknown.
       */
      /**
       * The keys a named write through a root adds to it.
       *
       * `const values = { mode: 1, flip: false }; values.wrap = w` --
       * an options literal extended after creation. The literal SPELLS two keys and the program
       * gives it a third, so the spelling is not the key set. `case 'slot'`
       * already reads those writes; without them in the descriptor the very
       * slot they write was refused before it could be read -- the descriptor
       * answering about the LITERAL when it was asked about the OBJECT.
       *
       * Only literals are asked. A class instance's absent keys are a chain
       * proof rather than a spelling, and `this[ key ] = v` inside a method
       * would otherwise leave every instance's key set unknown.
       *
       * This scan is asked about ONE key's writes, or about the computed ones,
       * and stays here for that reason. Routing it through `written-keys` was
       * measured and reverted: that query depends on every named write in the
       * program, so a per-key descriptor question -- asked about most roots in
       * the program, not just the enumerated ones -- pulled a whole-program
       * dependency set into each of them and put a large program into GC death
       * after minutes. A whole-program walk becomes a query only where the consumer
       * genuinely wants the whole program, which here is enumeration alone.
       */
      const writesTo = (root: ObjectRoot, edges: readonly { readonly receiver: Query }[]): boolean =>
        edges.some((edge) => observe(edge.receiver).has(root))
      /**
       * A write under a key this graph cannot name leaves the key set unknown
       * -- reported as unknown, never as a smaller set. Asked in reverse:
       * which states hold this root, and is any of them a computed write's
       * receiver -- one lookup per root instead of observing all of the program's
       * computed-write receivers per root per re-evaluation. `holdersOf`
       * subscribes this node to the root's future holders exactly as the
       * observe edges did, and the receivers are seeded below so each exists.
       */
      const unknownKeys = new Map<ObjectRoot, boolean>()
      const holderStampLists: (readonly [Value, number])[][] = []
      const hasUnnamedWrite = (root: ObjectRoot): boolean => {
        const known = unknownKeys.get(root)
        if (known !== undefined) return known
        let found = false
        let count = 0
        for (const holder of holdersOf(root)) {
          count++
          for (const write of computedWriteEdgesByReceiver.get(holder) ?? []) if (keysOf(write.access).length === 0) found = true
        }
        for (const stamps of holderStampLists) stamps.push([root, count])
        unknownKeys.set(root, found)
        return found
      }
      /** Every cell a root has: what it spells, plus what was written into it. */
      const ownKeys = new Map<Value, readonly string[] | null>()
      const activeOwnKeys = new Set<Value>()
      const stampLists: (readonly [ReadonlySet<Value>, number])[][] = []
      const watched = (dependency: Query): ReadonlySet<Value> => {
        const held = observe(dependency)
        for (const stamps of stampLists) stamps.push([held, held.size])
        return held
      }
      const holdersUnchanged = (stamps: readonly (readonly [Value, number])[]): boolean => {
        for (const [root, count] of stamps) {
          let now = 0
          for (const _holder of holdersOf(root)) now++
          if (now !== count) return false
        }
        return true
      }
      const ownKeysOf = (root: Value): readonly string[] | null => {
        const known = ownKeys.get(root)
        if (known !== undefined) return known
        // A bulk assign whose source's keys come back to this root -- two
        // records merged into each other -- names no finite set on the way
        // round; the re-entry is unknown, and only the outer answer is kept.
        if (activeOwnKeys.has(root)) return null
        const kept = ownKeysAnswers.get(root)
        if (kept !== undefined && kept.stamps.every(([held, size]) => held.size === size) && holdersUnchanged(kept.holderStamps)) {
          for (const stamps of stampLists) stamps.push(...kept.stamps)
          for (const stamps of holderStampLists) stamps.push(...kept.holderStamps)
          ownKeys.set(root, kept.keys)
          return kept.keys
        }
        activeOwnKeys.add(root)
        const stamps: (readonly [ReadonlySet<Value>, number])[] = []
        const holderStamps: (readonly [Value, number])[] = []
        stampLists.push(stamps)
        holderStampLists.push(holderStamps)
        try {
          const answer = ownKeysUncached(root)
          ownKeys.set(root, answer)
          ownKeysAnswers.set(root, { keys: answer, stamps, holderStamps })
          return answer
        } finally {
          stampLists.pop()
          holderStampLists.pop()
          activeOwnKeys.delete(root)
        }
      }
      const ownKeysUncached = (root: Value): readonly string[] | null => {
        const spelled = literalSpelledKeys(root)
        if (spelled === null || !isObjectRoot(root)) return spelled
        if (hasUnnamedWrite(root)) return null
        const keys = new Set(spelled)
        for (const stored of watched(closure(root))) {
          if (ts.isCallExpression(stored) && definitionPlans.has(stored)) {
            if (watched(value(stored.arguments[0]!)).has(root)) for (const key of definitionPlans.get(stored)!.keys) keys.add(key)
            continue
          }
          if (ts.isCallExpression(stored)) {
            // A bulk assign onto this root gives it every key its sources have.
            const bulk = bulkAssignOf(stored)
            if (bulk === null || !watched(value(bulk.target)).has(root)) continue
            for (const source of bulk.sources)
              for (const held of watched(value(source))) {
                if (held === undefinedValue || held.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(held)) continue
                const sourceKeys = ownKeysOf(held)
                if (sourceKeys === null) return null
                for (const written of sourceKeys) keys.add(written)
              }
            continue
          }
          if (!ts.isPropertyAccessExpression(stored) && !ts.isElementAccessExpression(stored)) continue
          for (const written of keysOf(stored)) keys.add(written)
        }
        return [...keys]
      }
      const descriptorOf = (root: ObjectRoot, key: string): boolean =>
        descriptor(root, key) ||
        (isSourceCallableObject(root) && sourceCallableOwnDataWriteOf(checker, flow, root, key) !== null) ||
        ((ts.isObjectLiteralExpression(root) || isFreshOrdinaryObject(root)) && writesTo(root, namedWriteReceivers.get(key) ?? [])) ||
        ((ts.isObjectLiteralExpression(root) || isFreshOrdinaryObject(root)) &&
          [...holdersOf(root)].some((holder) =>
            (computedWriteEdgesByReceiver.get(holder) ?? []).some((edge) => keysOf(edge.access).includes(key))
          )) ||
        writesTo(root, definitionReceivers.get(key) ?? [])

      /**
       * Every element key of the arrays an access could be reaching.
       *
       * `this.items[ i ]` -- every loop over a field array. The index is a counter no value bounds, so asking what
       * `i` HOLDS correctly answers nothing; but the access still names some
       * element, and an array literal spells all of them. Their union is a
       * true superset where a single key is not available. `length` is not an
       * element and is not in it, and nothing is inferred from list order --
       * the keys are the positions the literal actually has.
       *
       * The container is read WITHOUT requiring it: the caller requires it
       * anyway, and a bounded index must stay exact rather than widening to
       * the whole array, so this answers only where no key is available.
       */
      const numericIndex = (index: ts.Expression): boolean => {
        const numeric = (type: ts.Type): boolean =>
          type.isUnion() ? type.types.every(numeric) : (type.flags & ts.TypeFlags.NumberLike) !== 0 && !type.isNumberLiteral()
        return numeric(checker.getTypeAtLocation(index))
      }
      const arrayElementKeys = (access: ts.ElementAccessExpression): readonly string[] | null => {
        const roots = observe(value(access.expression))
        if (roots.size === 0) return null
        for (const root of roots) if (!ts.isArrayLiteralExpression(root) || root.elements.some(ts.isSpreadElement)) return null
        const bounded = observe(value(access.argumentExpression))
        if (bounded.size > 0 && [...bounded].every((candidate) => ts.isStringLiteralLike(candidate) || ts.isNumericLiteral(candidate)))
          return null
        // `bounded` empty is ambiguous: on the FIRST transfer of any node it
        // means the index's own state was only just created and has not been
        // transferred yet, not that no bound exists -- `enumeratedKeysOf` and
        // `keysOf`'s own `unresolved-property-key` meet the identical shape
        // and both defer the empty-vs-opaque call to `sealing` for that
        // reason. Widening here before the fixpoint published a PERMANENT
        // fact per element (`case 'value'` -> `carry(slot(root, key))`) that
        // the index's later, exact resolution to a single literal could never
        // retract: `arr[k]` read every element forever because pass one saw
        // `k` before its own value had transferred. Defer instead of guessing
        // -- returning null falls through to `keysOf`'s own index read, which
        // already requires the argument and applies the same `sealing` gate.
        if (!sealing && bounded.size === 0) return null
        return [ELEMENT_KEY]
      }
      const keysOf = (access: Access): readonly string[] => {
        const direct = accessKey(access)
        if (direct !== null) return [direct]
        if (!ts.isElementAccessExpression(access)) return []
        const enumerated = enumerationHeadOf(access.argumentExpression)
        if (enumerated !== null) return enumeratedKeysOf(access, enumerated, read, fail, sealing, ownKeysOf)
        const keyReference = unwrapErasedExpression(access.argumentExpression)
        const keyDeclaration = ts.isIdentifier(keyReference) ? flow.targetOf(keyReference)?.declaration : undefined
        if (keyDeclaration && ts.isVariableDeclaration(keyDeclaration)) {
          const writes = flow.writesToDeclaration(keyDeclaration).filter((write) => write.slot === 'whole')
          if (
            writes.length > 0 &&
            writes.every((write) => write.edge === 'iteration-binding' && write.iterationOrigin?.mode === 'values')
          ) {
            const keys = new Set<string>()
            let complete = true
            for (const write of writes) {
              const source = write.iterationOrigin?.source
              const call = source && unwrapErasedExpression(source)
              const query = call && ts.isCallExpression(call) ? intrinsicOwnKeyQueryOf(checker, call.expression) : null
              if (
                !call ||
                !ts.isCallExpression(call) ||
                write.iterationOrigin?.asynchronous ||
                call.arguments.length !== 1 ||
                query?.owner !== 'Object' ||
                !['keys', 'getOwnPropertyNames'].includes(query.member) ||
                deferredIntrinsicProtocolLedgerOf(flow)?.requireMember(query.owner, query.member, call) !== true
              ) {
                complete = false
                break
              }
              const roots = read(value(call.arguments[0]!))
              if (sealing && roots.size === 0) fail('unresolved-key-enumeration-owner', call)
              for (const root of roots) {
                if (!isObjectRoot(root)) {
                  fail('unmodelled-key-enumeration-owner', call)
                  continue
                }
                for (const key of read(nodeQuery('own-keys', root))) {
                  if (ts.isStringLiteral(key)) keys.add(key.text)
                  else fail('unmodelled-own-key-value', call)
                }
              }
            }
            if (complete) return [...keys]
          }
        }
        // A counter names a POSITION, never a key: `this.items[ i ]` with
        // a `let i` loop counter. The checker calls it `number`, and
        // asking what the counter holds only ever refused (`i++` is no value
        // this graph states) and made the access opaque; the element slot is
        // the answer, and it is a superset whatever the counter holds.
        if (numericIndex(access.argumentExpression)) return [ELEMENT_KEY]
        const elements = noArrayKeys ? null : arrayElementKeys(access)
        if (elements !== null) return elements
        const keys = new Set<string>()
        const keyQuery = value(access.argumentExpression)
        watched(keyQuery)
        const candidates = read(keyQuery)
        for (const candidate of candidates) {
          if (ts.isStringLiteralLike(candidate) || ts.isNumericLiteral(candidate)) keys.add(candidate.text)
          else fail('coercing-or-unbounded-property-key', access)
        }
        if (sealing && candidates.size === 0) fail('unresolved-property-key', access)
        return [...keys]
      }
      const iterationValuesAt = (source: ts.Expression): readonly ts.Expression[] | null => {
        const elements: ts.Expression[] = []
        for (const root of read(value(source))) {
          if (
            !ts.isArrayLiteralExpression(root) ||
            root.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)) ||
            deferredIntrinsicProtocolLedgerOf(flow)?.require('Array', source) !== true
          )
            return null
          // This bounded lane transports the original literal's entries.
          // Mutating its contents/length needs the full indexed storage plan.
          for (const use of read(closure(root)))
            if ((ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) && writeEdgeByAccess.has(use)) return null
          for (const element of root.elements) if (!ts.isSpreadElement(element) && !ts.isOmittedExpression(element)) elements.push(element)
        }
        return elements
      }
      /**
       * Mentions of an exported cell in the modules that import it, or null
       * when the set of modules that can read it is not enumerable.
       *
       * `export const taurus = new TaurusStore()` -- taurus-display's entire
       * store, and the receiver of every `this.<method>()` in it. An export
       * was refused outright unless NOTHING imported it, which reads "someone
       * imports this" as "this escaped". It is not an escape while every
       * module that can read the name is enumerated: the importers' mentions
       * are then simply more uses of the same cell. They are also mentions
       * `referencesToDeclaration` does not carry -- an importing file's
       * identifier resolves to the import specifier, not to the declaration --
       * so a caller that widens the predicate must walk these too, or it has
       * called a cell closed on the strength of uses it never looked at.
       */
      const importerMentions = (declaration: ts.Declaration): readonly ts.Expression[] | null =>
        !isModuleExportedDeclaration(checker, declaration, null) ? [] : inProgramImportReferencesOf(checker, flow, declaration)
      /** The refusal a cell earns, or null when it is closed -- named, because
       * "exposed" covered three different facts and each has its own fix. */
      const bindingClosed = (declaration: ts.VariableDeclaration): string | null => {
        if (!sourceBindingWritesAreComplete(checker, flow, declaration)) return 'binding-writes-incomplete'
        if (!isModuleExportedDeclaration(checker, declaration, null)) return null
        if (exportIsUnimported(checker, flow, declaration)) return null
        return importerMentions(declaration) !== null ? null : 'export-importers-unenumerable'
      }
      const refs = (root: Value, declaration: ts.Declaration): void => {
        for (const reference of flow.referencesToDeclaration(declaration)) {
          if (reference === ts.getNameOfDeclaration(declaration) || isTypePositionReference(reference)) continue
          // Past an unconditional rebinding the cell holds only what a write
          // after entry stored; a root none of those writes stores is no
          // longer reachable through it.
          if (
            ts.isParameter(declaration) &&
            readsAfterRebinding(declaration, reference) &&
            parameterRebindingsOf(declaration).every((write) => write.value !== null && !read(value(write.value)).has(root))
          )
            continue
          add(read(use(root, reference)))
        }
        for (const reference of importerMentions(declaration) ?? []) add(read(use(root, reference)))
      }
      /**
       * A binding pattern taken apart over this value: every element reads one
       * slot and nothing reads the object itself.
       *
       * Destructuring is a property READ, and `visitUse` already states that a
       * property read of a tracked object is not a publication of it. Refusing
       * the pattern spelling made the two disagree -- `p.app.go()` proved its
       * receiver and `const { app } = p; app.go()` did not, though the object
       * never left the program either way. A rest element stays refused: it
       * builds a FRESH object out of whatever keys nothing else took, and that
       * object is not modelled here.
       */
      const patternReadsSlots = (root: Value, pattern: ts.BindingPattern): void => {
        if (!isObjectRoot(root)) {
          fail('non-object-destructured-container', pattern)
          return
        }
        for (const element of pattern.elements) {
          if (ts.isOmittedExpression(element)) continue
          const key = bindingElementKey(element)
          if (element.dotDotDotToken) fail('rest-binding-element', element)
          else if (key === null) fail('computed-binding-element', element)
          else if (
            isSourceCallableObject(root) &&
            key !== 'name' &&
            key !== 'length' &&
            sourceCallableOwnDataWriteOf(checker, flow, root, key, element) === null
          )
            fail('unproven-callable-data-read', element)
          else if (!descriptorOf(root, key)) fail('unmodelled-descriptor', element)
        }
      }
      /**
       * The complete set of source setters a plain store to `key` executes.
       *
       * `class Base { constructor() { this.type = 'Base' } }` with a subclass
       * declaring `get type` / `set type`: the base constructor's plain store
       * runs the SUBCLASS's setter. The plan already names every setter such
       * a store can reach, or says the effects are opaque -- this only has to
       * put the receiver into each of those bodies, which is what a member
       * call does with its own frame.
       */
      const storeRunsSetters = (root: ObjectRoot, key: string): boolean => {
        if (!ts.isNewExpression(root)) return false
        const bodies = settersOf(root, key)
        if (bodies === null) return false
        for (const setter of bodies) for (const reference of flow.receiverReferencesToDeclaration(setter)) add(read(use(root, reference)))
        return true
      }
      /**
       * Every value a setter's parameter receives: the right-hand side of each
       * store that runs the setter -- a store to its key on a construction of
       * its class's family. A setter has no call sites, so `callersOf` names
       * nothing for it and the parameter was an unindexed frame: a class's
       * `set attachment( current )`. The family is by
       * heritage; a descendant's own override is over-counted, which only
       * widens the answer. A bulk `Object.assign` onto one of ours names no
       * key to compare and refuses.
       */
      /**
       * Every instance a class member can run on: the constructions of its
       * heritage family, refused when the family is open or when a `new`
       * naming a family class could not be placed.
       */
      // The instances and the opaque constructions naming a family are fixed
      // facts of the program, but this runs inside every re-evaluation of every
      // query on a class member: recomputing them was a walk of the construction
      // index and of every opaque `new` each time. Only `fail` is per-evaluation.
      const familyInstances = new Map<
        SourceClass,
        { readonly instances: readonly ts.NewExpression[]; readonly opaque: readonly ts.NewExpression[] } | null
      >()
      const familyInstancesOf = (holder: SourceClass, reason: string): readonly ts.NewExpression[] | null => {
        let known = familyInstances.get(holder)
        if (known === undefined) {
          const family = sourceClassFamilyOf(checker, flow, new Set([holder]))
          if (family === null) known = null
          else {
            const instances = new Set<ts.NewExpression>()
            for (const owner of family.keys()) for (const instance of constructionsOf(owner)) instances.add(instance)
            const opaque: ts.NewExpression[] = []
            for (const call of opaqueConstructionsOf()) {
              const declarations = checker.getTypeAtLocation(call).getSymbol()?.declarations ?? []
              if (declarations.some((declaration) => family.has(declaration as SourceClass))) opaque.push(call)
            }
            known = { instances: [...instances], opaque }
          }
          familyInstances.set(holder, known)
        }
        if (known === null) {
          fail(reason, holder)
          return null
        }
        for (const call of known.opaque) fail('opaque-construction', call)
        return known.instances
      }
      /**
       * A value a getter returns is used wherever the getter is READ: every
       * access spelling its key on one of its class family's constructions,
       * from the instances outward like `setterStores`. A getter has no call
       * sites, so `callersOf` names nothing for it; a class whose
       * `get item()` returns `this.items[ 0 ]` has the element used
       * at every `target.item` in the program. A descendant's override is
       * over-counted, which only widens.
       */
      const getterReturns = (root: Value, getter: ts.GetAccessorDeclaration): void => {
        const holder = getter.parent
        if (
          (!ts.isClassDeclaration(holder) && !ts.isClassExpression(holder)) ||
          (ts.getCombinedModifierFlags(getter) & ts.ModifierFlags.Static) !== 0
        ) {
          fail('unmodelled-getter-owner', getter)
          return
        }
        const key = declarationKey(getter.name)
        if (key === null) {
          fail('computed-getter-key', getter)
          return
        }
        const instances = familyInstancesOf(holder, 'getter-family-open')
        if (instances === null) return
        for (const instance of instances)
          for (const fact of read(closure(instance))) {
            if (!ts.isPropertyAccessExpression(fact) && !ts.isElementAccessExpression(fact)) continue
            if (writeEdgeByAccess.has(fact) || !keysOf(fact).includes(key)) continue
            add(read(use(root, fact)))
          }
      }
      const setterStores = (setter: ts.SetAccessorDeclaration): void => {
        const holder = setter.parent
        if (
          (!ts.isClassDeclaration(holder) && !ts.isClassExpression(holder)) ||
          (ts.getCombinedModifierFlags(setter) & ts.ModifierFlags.Static) !== 0
        ) {
          fail('unmodelled-setter-owner', setter)
          return
        }
        const key = declarationKey(setter.name)
        if (key === null) {
          fail('computed-setter-key', setter)
          return
        }
        const instances = familyInstancesOf(holder, 'setter-family-open')
        if (instances === null) return
        // From the instances outward, never from every write inward. The
        // stores that can run this setter go through one of the family's
        // constructions, and a construction's closure already lists every
        // store through it (`case 'slot'` reads the same facts). Placing the
        // receiver of every write naming the key instead read cells that
        // had nothing to do with this family -- an event-dispatcher base's
        // `listeners[ type ] = []` resolves `this._listeners` on every
        // dispatcher in the program, this family's included, and this family's
        // computed stores hang on the very `setValues` parameter this
        // question is part of establishing. Their opacity became this
        // parameter's.
        for (const root of instances)
          for (const stored of read(closure(root))) {
            if (ts.isCallExpression(stored)) {
              if (bulkAssignOf(stored) !== null && read(value(stored.arguments[0]!)).has(root)) fail('bulk-assign-runs-setter', stored)
              continue
            }
            if (!ts.isPropertyAccessExpression(stored) && !ts.isElementAccessExpression(stored)) continue
            const edge = writeEdgeByAccess.get(stored)
            if (edge === undefined || !keysOf(stored).includes(key)) continue
            const write = edge.write
            if (write.value === null || !['property-assignment', 'index-assignment', 'logical-assignment'].includes(write.edge))
              fail('unmodelled-setter-store', write.site)
            else add(carry(value(write.value)))
          }
      }
      /**
       * Every read of an argument through the `arguments` object.
       *
       * A scene-graph style `Node.add( object )` that walks its own `arguments`
       * to add several children at once receives a value at a
       * PARAMETER and, on some index, at `arguments[ i ]` as well. Refusing
       * the whole frame for that gave up on the entire node family --
       * every callback parameter reached through those nodes hung on this one
       * refusal.
       *
       * The index is not resolved and does not need to be: one that names any
       * position means every argument reaches every read, which is the
       * superset. `arguments.length` is a number and carries nothing. Any
       * other mention -- a spread, the object handed on whole -- is a use this
       * graph cannot follow, and stays a refusal.
       */
      const argumentsReads = (body: ts.SignatureDeclaration): readonly ts.Expression[] | null => {
        const reads: ts.Expression[] = []
        for (const mention of argumentsUsesAt(body) ?? []) {
          const parent = mention.parent
          if (ts.isPropertyAccessExpression(parent) && parent.expression === mention && parent.name.text === 'length') continue
          if (ts.isElementAccessExpression(parent) && parent.expression === mention) reads.push(parent)
          else return null
        }
        return reads
      }
      const forward = (root: Value, site: FlowCallSite, receiver: boolean, position: number): void => {
        if (ts.isNewExpression(site.call) || site.operands.dispatch.kind === 'super-constructor') {
          for (const body of read(nodeQuery('construct-targets', site.call))) {
            if (!ts.isConstructorDeclaration(body) && !isBody(body)) {
              fail('non-constructor-target', body)
              continue
            }
            const spread = argumentsReads(body)
            if (spread === null) {
              fail('arguments-object-frame', body)
              continue
            }
            for (const mention of spread) add(read(use(root, mention)))
            const parameter = runtimeParametersOf(body)[position]
            if (parameter?.dotDotDotToken) fail('rest-frame', parameter)
            else if (parameter && ts.isIdentifier(parameter.name)) refs(root, parameter)
            else if (parameter) patternReadsSlots(root, parameter.name as ts.BindingPattern)
          }
          return
        }
        const selected = read(targets(site.call))
        if (sealing && selected.size === 0) fail('no-source-call-target', site.call)
        for (const body of selected) {
          if (!isCallableValue(body)) {
            fail('non-callable-target', body)
            continue
          }
          if (receiver) {
            // `arguments` never holds the receiver, so an arguments-using body
            // says nothing about where `this` goes.
            if (!ts.isArrowFunction(body))
              for (const reference of flow.receiverReferencesToDeclaration(body)) add(read(use(root, reference)))
          } else {
            const mentions = argumentsReads(body)
            if (mentions === null) {
              fail('arguments-object-frame', body)
              continue
            }
            for (const mention of mentions) add(read(use(root, mention)))
            const parameter = runtimeParametersOf(body)[position]
            if (parameter?.dotDotDotToken) fail('rest-frame', parameter)
            else if (parameter && ts.isIdentifier(parameter.name)) refs(root, parameter)
            else if (parameter) patternReadsSlots(root, parameter.name as ts.BindingPattern)
          }
        }
      }
      const visitUse = (root: Value, reference: ts.Expression): void => {
        if (isTypePositionReference(reference)) return
        const parent = reference.parent
        if (!parent) {
          fail('unindexed-use', reference)
          return
        }
        const positioned = outermostErasureOf(reference)
        if (positioned !== reference) {
          if (ts.isExpression(positioned)) add(read(use(root, positioned)))
          else fail('unindexed-use', positioned)
          return
        }
        if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
          if (parent.name === reference) return
          if (parent.initializer !== reference) {
            fail('binding-pattern', parent)
            return
          }
          if (!ts.isIdentifier(parent.name)) {
            patternReadsSlots(root, parent.name)
            return
          }
          const exposure = ts.isVariableDeclaration(parent) ? bindingClosed(parent) : null
          if (exposure !== null) {
            fail(`exposed-binding:${exposure}`, parent)
            return
          }
          refs(root, parent)
          return
        }
        if (ts.isBinaryExpression(parent)) {
          if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            if (parent.left === reference) return
            const moduleUses = sourceCommonJsExportUsesOf(flow, parent)
            if (moduleUses !== null) {
              if (parent.right !== reference) fail('unmatched-commonjs-export', reference)
              else for (const alias of moduleUses) add(read(use(root, alias)))
              return
            }
            const left = unwrapNaming(parent.left)
            if (ts.isIdentifier(left)) {
              const declaration = flow.targetOf(left)?.declaration
              if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration))) {
                fail('external-binding-store', left)
                return
              }
              // `bindingClosed` names the REFUSAL, null when the cell is closed
              // (its other reader above spells the same test). Read as a boolean
              // it refused every store into a closed local and admitted every
              // store into an exposed one -- `entry = makeRecord()` inside a
              // closed factory was the 'exposed-binding' that kept the cache
              // `.get()` receiver from ever being proven.
              const exposure = ts.isVariableDeclaration(declaration) ? bindingClosed(declaration) : null
              if (exposure !== null) {
                fail(`exposed-binding:${exposure}`, declaration)
                return
              }
              refs(root, declaration)
            } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
              if (sourceIntrinsicMemberMayBeWrittenOf(checker, flow, left)) {
                const installed = sourceIntrinsicMemberDataWriteOf(checker, flow, left)
                if (installed === null || installed.site !== parent || sourceCallableObjectOf(checker, flow, reference) !== installed.body)
                  fail('unproven-intrinsic-member-installation', left)
                else for (const access of installed.reads) add(read(use(root, access)))
                add(read(use(root, parent)))
                return
              }
              const keys = keysOf(left)
              const containers = read(value(left.expression))
              if (sealing && containers.size === 0) fail('unresolved-container', left)
              for (const container of containers) {
                // A store on `null`/`undefined` throws before it lands: an
                // element slot read through a counter carries `undefined` for
                // the positions never written (`this.items[ i ]` filled in a
                // loop), and that is no container.
                if (container === undefinedValue || container.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(container)) continue
                if (!isObjectRoot(container)) {
                  fail('opaque-container-store', left)
                  continue
                }
                for (const key of keys) {
                  if (descriptorOf(container, key)) {
                    add(read(publication(root, container, key)))
                    continue
                  }
                  // A store to an accessor key hands the value to the
                  // SETTER's parameter, never to a slot of the container.
                  if (ts.isNewExpression(container) && dataStoreOf(container, key)) {
                    add(read(publication(root, container, key)))
                    continue
                  }
                  const setters = ts.isNewExpression(container) ? settersOf(container, key) : null
                  if (setters === null) fail('opaque-container-store', left)
                  else
                    for (const setter of setters) {
                      const parameter = setter.parameters[0]
                      if (!parameter || !ts.isIdentifier(parameter.name)) fail('unmodelled-setter-parameter', setter)
                      else refs(root, parameter)
                    }
                }
              }
            } else fail('unmodelled-store', left)
            add(read(use(root, parent)))
            return
          }
          if (
            parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            parent.operatorToken.kind === ts.SyntaxKind.CommaToken
          ) {
            add(read(use(root, parent)))
            return
          }
          if (
            parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
          )
            return
          if (parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === reference) return
          // OrdinaryHasInstance only walks the left operand's prototype chain:
          // it reads no own key and runs no hook on it. A custom @@hasInstance
          // would receive it, which the ordinary-instance proof rules out.
          if (
            parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            parent.left === reference &&
            ordinarySourceClassInstanceTestOf(checker, flow, parent)
          )
            return
          fail('coercing-value-use', parent)
          return
        }
        if (ts.isConditionalExpression(parent)) {
          if (parent.condition !== reference) add(read(use(root, parent)))
          return
        }
        if (ts.isPropertyAssignment(parent) && parent.initializer === reference) {
          const key = declarationKey(parent.name)
          if (key === null || key === '__proto__') fail('computed-publication', parent)
          else add(read(publication(root, parent.parent, key)))
          return
        }
        if (ts.isSpreadAssignment(parent) && parent.expression === reference && ts.isObjectLiteralExpression(root)) {
          // CopyDataProperties observes own data slots without retaining the
          // source owner. Copied identities continue through publication below;
          // the same complete key/storage queries still reject opaque readers.
          for (const key of read(nodeQuery('own-keys', root))) {
            if (!ts.isStringLiteral(key)) fail('unmodelled-own-key-value', root)
            else read(storedSlot(root, key.text))
          }
          facts.add(reference)
          return
        }
        if (ts.isShorthandPropertyAssignment(parent)) {
          add(read(publication(root, parent.parent, parent.name.text)))
          return
        }
        if (ts.isPropertyDeclaration(parent) && parent.initializer === reference) {
          const key = declarationKey(parent.name)
          if (key === null || (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Static) !== 0) {
            fail('static-or-computed-publication', parent)
            return
          }
          for (const construction of constructionsOf(parent)) add(read(publication(root, construction, key)))
          return
        }
        if (ts.isArrayLiteralExpression(parent)) {
          if (parent.elements.some(ts.isSpreadElement)) fail('spread-publication', parent)
          else add(read(publication(root, parent, String(parent.elements.indexOf(reference)))))
          return
        }
        if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
          if (parent.expression !== reference) {
            // The reference is the access's NAME, not its object: `a.go`
            // MENTIONS the method `go`, and `flow.referencesToDeclaration`
            // hands that mention back when the tracked value is the method's
            // own declaration. What is used is the access's result. Without
            // this branch every class method's closure proof read its own call
            // sites as a key coercion, so `this.run()` had no callable slot at
            // all -- the one place a member name is not a key being coerced.
            if (ts.isPropertyAccessExpression(parent) && parent.name === reference) {
              add(read(use(root, parent)))
              return
            }
            fail('coercing-property-key', reference)
            return
          }
          const keys = keysOf(parent)
          // `new ( /** @type {new (...args: any[]) => this} */ ( this.constructor ) )()`
          // -- a common JS spelling of the clone idiom wherever a library
          // JSDoc-casts the read --
          // sits a ParenthesizedExpression between the access and the `new` that
          // actually invokes it, purely to anchor the cast comment. Plain
          // `parent.parent` lands on that paren, not the `new`, so the
          // `constructor-slot-read` exception below never matched and every
          // family member's `copy` override the census could not otherwise index
          // came back an unmodelled frame. `outermostErasureOf` is the same
          // erasure-aware "which node occupies the syntactic position" walk this
          // graph already uses for `use`/`visitUse`; for the unparenthesized
          // spelling it is a no-op (`parent.parent` unchanged).
          const positioned = outermostErasureOf(parent)
          const invocation = positioned.parent
          const callee = ts.isCallExpression(invocation) && invocation.expression === positioned
          const stored =
            ts.isBinaryExpression(invocation) &&
            invocation.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            invocation.left === positioned
          // `delete holder.field`, `holder.n += 1`, `holder.n++`, `holder.f ??=
          // g`: the slot is rewritten without a plain `=`. Reading these as
          // mere mentions of the slot left every one of them invisible to the
          // slot's own value set -- a deleted field still "held" its
          // initializer. They are stores; the slot decides what each edge
          // means, and refuses the ones it cannot model.
          const mutated =
            (ts.isDeleteExpression(invocation) && invocation.expression === positioned) ||
            (ts.isBinaryExpression(invocation) &&
              invocation.left === positioned &&
              invocation.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
              invocation.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              invocation.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(invocation) || ts.isPostfixUnaryExpression(invocation)) &&
              (invocation.operator === ts.SyntaxKind.PlusPlusToken || invocation.operator === ts.SyntaxKind.MinusMinusToken))
          if (mutated && !writeEdgeByAccess.has(parent)) {
            fail('unmodelled-property-write', parent)
            return
          }
          // A store through this root is a key the root gains, and THIS walk is
          // where the program says so. Asking the write index instead -- "of
          // every write in the program, which ones reach this root" -- is the
          // same fact derived a second way, at O(all writes) per re-evaluation
          // instead of O(uses of the root); on a large program that was the compile.
          // `enumeratedKeysOf` already requires this closure, so the key set
          // costs it no dependency it was not already holding.
          if (stored || mutated) facts.add(parent)
          /**
           * Whether this graph can say what reaching `key` through this root
           * does. A declared cell it can. A key proven absent from the chain
           * it can -- except in a CALLEE position, where absence names no
           * callable. And a plain store to a key the family declares as an
           * accessor it can, because the store runs that accessor's SETTER:
           * a frame, not an unmodelled descriptor. The getter is never
           * evaluated -- a store does not read -- so a getter that hands its
           * receiver out says nothing about this store.
           */
          const modelled = (held: ObjectRoot, key: string): boolean => {
            if (isSourceCallableObject(held)) {
              if ((key === 'name' || key === 'length') && !stored && !mutated) return true
              if (stored) return !mutated && sourceCallableDataWriteProtocolOf(checker, flow, key, parent)
              return !mutated && sourceCallableOwnDataWriteOf(checker, flow, held, key, parent) !== null
            }
            if (descriptorOf(held, key)) return true
            if (callee) return false
            if (stored && storeRunsSetters(held, key)) return true
            if (ts.isNewExpression(held)) {
              if (!stored && !mutated && familyReadOf(held, key) !== null) return true
              if (stored && dataStoreOf(held, key)) return true
            }
            return absentOwnKey(held, key, parent, descriptorOf, hasUnnamedWrite)
          }
          // `instance.constructor` READS the class object off the prototype
          // -- a value this graph does not carry, and one whose escape opens
          // the family: `unknown( value.constructor )` can construct and
          // retarget Base from anywhere. Only `new this.constructor()` is a
          // modelled use of it (`case 'value'` places the construction).
          if (
            ts.isNewExpression(root) &&
            keys.includes('constructor') &&
            !stored &&
            !mutated &&
            !(ts.isNewExpression(invocation) && invocation.expression === positioned)
          ) {
            fail('constructor-slot-read', parent)
            return
          }
          if (!isObjectRoot(root) || keys.some((key) => !modelled(root, key))) {
            fail('unmodelled-descriptor', parent)
            return
          }
          if (callee) {
            const site = sites.get(invocation)
            if (!site) fail('unindexed-call', invocation)
            else forward(root, site, true, -1)
          }
          return
        }
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
          if (parent.expression === reference) {
            if (reference.kind === ts.SyntaxKind.SuperKeyword && ts.isCallExpression(parent) && ts.isNewExpression(root)) {
              read(nodeQuery('construct-targets', parent))
              return
            }
            if (!isBody(root)) fail('non-callable-use', reference)
            return
          }
          if (ts.isCallExpression(parent)) {
            const query = intrinsicOwnKeyQueryOf(checker, parent.expression)
            if (
              query !== null &&
              parent.arguments.length === 1 &&
              parent.arguments[0] === reference &&
              ['keys', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'ownKeys'].includes(query.member)
            ) {
              if (deferredIntrinsicProtocolLedgerOf(flow)?.requireMember(query.owner, query.member, parent) !== true)
                fail('unproven-own-key-query', parent)
              return
            }
            if (
              parent.arguments.length === 1 &&
              parent.arguments[0] === reference &&
              intrinsicJsonStringifyQueryOf(checker, unwrapErasedExpression(parent.expression))
            ) {
              // This bounded observation has no replacer or coercing space
              // argument, and enters no toJSON/getter/recursive object frame.
              // Actual stored values and all future keys remain solver inputs.
              const ledger = deferredIntrinsicProtocolLedgerOf(flow)
              const absence = sourceObjectPrototypeAbsenceOf(checker, ['toJSON'], parent)
              if (
                !isObjectRoot(root) ||
                (!ts.isObjectLiteralExpression(root) && !isFreshOrdinaryObject(root)) ||
                (ts.isObjectLiteralExpression(root) &&
                  root.properties.some((one) => !ts.isPropertyAssignment(one) && !ts.isShorthandPropertyAssignment(one))) ||
                !ledger ||
                absence === null ||
                !ledger.requireMember('JSON', 'stringify', parent) ||
                !ledger.include([absence])
              ) {
                fail('unproven-json-observation', parent)
                return
              }
              for (const key of read(nodeQuery('own-keys', root))) {
                if (!ts.isStringLiteral(key) || key.text === 'toJSON') {
                  fail('json-hook-observation', parent)
                  continue
                }
                const entries = read(storedSlot(root, key.text))
                if (sealing && entries.size === 0) fail('unresolved-json-slot', parent)
                if ([...entries].some((entry) => !primitiveStoredValue(entry))) fail('json-object-observation', parent)
              }
              return
            }
            const installation = sourceCallableReflectSetOf(checker, parent)
            if (installation && (installation.target === reference || installation.value === reference)) {
              const owner = read(value(installation.target))
              if (sealing && owner.size === 0) fail('unresolved-callable-data-owner', parent)
              for (const held of owner) {
                if (
                  !isSourceCallableObject(held) ||
                  !sourceCallableDataWriteProtocolOf(checker, flow, installation.key, parent) ||
                  deferredIntrinsicProtocolLedgerOf(flow)?.requireMember('Reflect', 'set', parent) !== true
                ) {
                  fail('unproven-callable-data-write', parent)
                  continue
                }
                if (installation.target === reference) facts.add(parent)
                else add(read(publication(root, held, installation.key)))
              }
              return
            }
          }
          if (ts.isCallExpression(parent) && definitionPlans.has(parent)) {
            const plan = definitionOf(parent)
            if (plan === null) fail('intrinsic-definition-unproven', parent)
            else if (parent.arguments[0] === reference) {
              // The target gains the key (`case 'slot'` reads the value
              // through this fact) and is handed to nobody but, when the
              // intrinsic returns it, whoever reads the call.
              facts.add(parent)
              if (plan.returnsTarget && !ts.isExpressionStatement(parent.parent)) add(read(use(root, parent)))
            } else if (parent.arguments[2] === reference) {
              // The descriptor literal: its `value` is copied into the target
              // (`case 'publication'` forwards it); the literal goes nowhere.
              facts.add(parent)
            } else if (parent.arguments[1] === reference) fail('coercing-property-key', reference)
            else fail('unmodelled-invocation-frame', parent)
            return
          }
          if (ts.isCallExpression(parent)) {
            const bulk = bulkAssignOf(parent)
            if (bulk !== null && parent.arguments.includes(reference)) {
              // The call evaluates to its target, so a target root is used
              // wherever the call's result is; a source's own slot values are
              // copied into it (`case 'slot'` reads them through this fact),
              // and a source literal itself goes nowhere. A source that is
              // not a literal could run getters, which this does not enter.
              facts.add(parent)
              if (bulk.target === reference) add(read(use(root, parent)))
              else if (!ts.isObjectLiteralExpression(root)) fail('bulk-assign-source-unmodelled', reference)
              return
            }
          }
          const site = sites.get(parent)
          const operands = ts.isCallExpression(parent) ? (candidateOrdinaryOwnCallableOperandsOf(parent) ?? site?.operands) : site?.operands
          // `f.call( receiver, ... )` writes the receiver in an ARGUMENT
          // position of the syntax and reads it in the RECEIVER position of
          // the frame. The operands already say which is which -- reading the
          // syntax instead made every value handed to `.call` an argument no
          // parameter had a slot for.
          if (site && operands?.explicitThis && operands.receiver === reference) {
            forward(root, site, true, -1)
            return
          }
          // A value stored into a closed native Map (`store.set( key, value )`)
          // is not handed to unknown code: the map's only way out is its
          // `.get()` reads, and the value continues at each of them exactly
          // as it would at a parameter. `case 'completion'` above reads the
          // same stores back from the `.get()` side.
          if (ts.isCallExpression(parent)) {
            const continuations = collectionValueContinuationsOf(checker, flow, parent, reference, nativeProtocolClosed)
            if (continuations !== null) {
              for (const continued of continuations) add(read(use(root, continued)))
              return
            }
          }
          const position = operands?.args.indexOf(reference) ?? -1
          if (!site || position < 0 || operands?.args.some(ts.isSpreadElement)) fail('unmodelled-invocation-frame', parent)
          else forward(root, site, false, position)
          return
        }
        if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === reference)) {
          // An expression-bodied arrow returns its body through the same
          // synchronous completion and complete caller inventory as `return`.
          const body = ts.isArrowFunction(parent) ? parent : ts.findAncestor(parent, ts.isFunctionLike)
          if (body && ts.isGetAccessorDeclaration(body)) {
            getterReturns(root, body)
            return
          }
          if (!body || !isBody(body) || callableCompletionSummaryOf(flow, body)?.execution !== 'sync') {
            fail('deferred-completion', parent)
            return
          }
          read(closure(body))
          for (const call of read(callersOf(body))) if (ts.isCallExpression(call)) add(read(use(root, call)))
          return
        }
        // Enumerating an object reads its KEY SET and nothing else: no slot is
        // read, nothing escapes, and the object is not even coerced. What the
        // bound key then does is a question asked where the head is USED, not
        // here -- and without this branch the enumerated object was opaque, so
        // the key set could never be proven closed.
        if (ts.isForInStatement(parent) && parent.expression === reference) return
        if (ts.isForOfStatement(parent) && parent.expression === reference && ts.isArrayLiteralExpression(root)) {
          if (parent.awaitModifier || deferredIntrinsicProtocolLedgerOf(flow)?.require('Array', parent) !== true)
            fail('unproven-array-iteration', parent)
          return
        }
        if (
          ts.isExpressionStatement(parent) ||
          ts.isTypeOfExpression(parent) ||
          ts.isVoidExpression(parent) ||
          (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
          (ts.isIfStatement(parent) && parent.expression === reference)
        )
          return
        fail('opaque-value-use', reference)
      }
      /** A parameter's values: every frame's argument and every rebinding of
       * the cell, less `excluded` -- a rebinding the read asking cannot see. */
      const parameterValues = (parameter: ts.ParameterDeclaration, excluded: ts.Node | null): void => {
        const owner = parameter.parent
        if (ts.isSetAccessorDeclaration(owner)) {
          setterStores(owner)
          // The enumeration is exhaustive -- every store through every
          // instance -- so a setter nothing stores through has an EMPTY
          // parameter, witnessed here, not one pending some origin.
          seeded = true
          return
        }
        if (!isBody(owner) && !ts.isConstructorDeclaration(owner)) {
          fail('unindexed-parameter-frame')
          return
        }
        // A binding pattern names no cell of its own, but the parameter DOES
        // hold the whole argument -- that value is what each binding element
        // then reads a slot of. Refusing here made the pattern's container
        // unknowable, so every receiver destructured out of a parameter was
        // opaque however completely the program built the object.
        if (parameter.dotDotDotToken) {
          fail('unmodelled-parameter-frame')
          return
        }
        if (isBody(owner)) read(closure(owner))
        for (const site of constructionSitesTargeting(owner)) add(carry(frameQuery('frame-argument', site.call, owner, parameter)))
        for (const call of read(callersOf(owner)))
          if (ts.isCallExpression(call) || ts.isNewExpression(call)) add(carry(frameQuery('frame-argument', call, owner, parameter)))
        for (const write of flow.writesToDeclaration(parameter)) {
          if (write.site === excluded) continue
          if (write.edge === 'call-argument' || write.edge === 'super-argument' || write.edge === 'default-parameter') continue
          // A member or element write goes THROUGH the cell into the object
          // it holds; it never rebinds the cell, so it is no evidence about
          // what this parameter's value set is. Whether the object can still
          // be described afterwards is that object's own closure to answer,
          // and refusing here answered it in the wrong place -- turning
          // `values[ k ] = 1` into "this parameter holds nothing".
          if (write.slot !== 'whole') continue
          if (!['identifier-assignment', 'logical-assignment'].includes(write.edge) || !write.value) {
            fail('unmodelled-parameter-write', write.site)
            continue
          }
          add(carry(value(write.value)))
        }
      }
      seeded = false
      switch (query.kind) {
        case 'value': {
          const expression = query.node
          const moduleExport = sourceCommonJsExportValueOf(flow, expression)
          if (moduleExport !== null) {
            add(carry(value(moduleExport)))
            break
          }
          if (isObjectRoot(expression)) {
            if (isFreshOrdinaryObject(expression)) {
              if (deferredIntrinsicProtocolLedgerOf(flow)?.requireMember('Object', 'prototype', expression) !== true)
                fail('unproven-ordinary-object-allocation', expression)
              facts.add(expression)
              seeded = true
            } else if (ts.isNewExpression(expression) && construction(expression) === null) {
              // `new State()` on a plain function that returns an object
              // from every completion and never mentions `this` yields THAT
              // completion, never the fresh allocation (`new` discards it):
              // the value is the call's completion, solved through the same
              // frame a call would be. Anything else under `new` that is not
              // a source construction stays opaque.
              if (constructorFunctionCalleeOf(expression) !== null) add(carry(nodeQuery('completion', expression)))
              else fail('opaque-construction')
            } else {
              facts.add(expression)
              seeded = true
              // `new this.constructor()` is a construction of one of the owned
              // family `thisConstructorFamilyOf` named (its construction fact's
              // alternatives) only while `this` itself holds nothing but such
              // constructions. A method invoked with an explicit foreign
              // receiver would make the fresh object a foreign instance, and
              // that is decided here, by what `this` holds, not by the
              // static fact.
              if (ts.isNewExpression(expression)) {
                const receiver = thisConstructorReceiverOf(expression)
                if (receiver !== null) {
                  const alternatives = construction(expression)?.alternatives ?? []
                  for (const root of read(value(receiver))) {
                    if (!ts.isNewExpression(root) || !construction(root)?.alternatives.every((owner) => alternatives.includes(owner))) {
                      fail('opaque-construction', root)
                      continue
                    }
                    // The read is of the INSTANCE's `constructor`, which an
                    // own store or definition on that instance replaces:
                    // `value.constructor = function () {}` makes the fresh
                    // object whatever that function builds.
                    for (const stored of read(closure(root))) {
                      if (ts.isCallExpression(stored) && definitionPlans.has(stored)) {
                        const plan = definitionOf(stored)
                        if (plan === null || (plan.keys.includes('constructor') && read(value(stored.arguments[0]!)).has(root)))
                          fail('constructor-slot-written', stored)
                        continue
                      }
                      if (!ts.isPropertyAccessExpression(stored) && !ts.isElementAccessExpression(stored)) continue
                      if (writeEdgeByAccess.has(stored) && keysOf(stored).includes('constructor')) fail('constructor-slot-written', stored)
                    }
                  }
                }
              }
            }
          } else if (isBody(expression)) {
            facts.add(expression)
            seeded = true
          } else if (ts.isIdentifier(expression)) {
            const target = flow.targetOf(expression)
            const declaration = aliasedDeclarationOf(target?.symbol ?? undefined) ?? target?.declaration
            if (declaration && isBody(declaration) && flow.callableBodyIsIndexed(declaration)) {
              facts.add(declaration)
              seeded = true
              if (!sourceGlobalCallableBindingIsClosed(checker, flow, declaration)) fail('global-object-callable', declaration)
              for (const write of flow.writesToDeclaration(declaration)) {
                if (write.slot !== 'whole' || write.edge === 'return' || write.edge === 'yield') continue
                if (write.value && ['identifier-assignment', 'logical-assignment'].includes(write.edge)) add(carry(value(write.value)))
                else fail('unmodelled-callable-binding-write', write.site)
              }
            } else if (declaration && ts.isVariableDeclaration(declaration)) {
              const incoming = sourceBindingValuesOf(checker, flow, declaration, iterationValuesAt)
              if (incoming === null) fail('unaccounted-binding-write', declaration)
              else for (const entry of incoming) add(carry(value(entry)))
              if (incoming !== null && bindingReadMayPrecedeFirstWrite(declaration, expression)) {
                facts.add(undefinedValue)
                seeded = true
              }
            } else if (declaration && ts.isParameter(declaration)) {
              // `options = Object.assign({ ... }, options)`: the read in the
              // rebinding's own right side runs before the rebinding, and once
              // per cell -- outside a loop of the parameter's own body, and
              // not deferred into a nested function -- so it never sees the
              // value it is about to store. Joining it anyway made the copy's
              // source include its own target.
              const rebinding = rebindingAfterRead(declaration, expression)
              if (rebinding === null) add(carry(nodeQuery('parameter', declaration)))
              else parameterValues(declaration, rebinding)
            } else if (declaration && ts.isBindingElement(declaration)) add(carry(nodeQuery('binding-element', declaration)))
            else if (expression.text === 'undefined' && (!declaration || declaration.getSourceFile().hasNoDefaultLib)) {
              facts.add(undefinedValue)
              seeded = true
            } else fail('opaque-binding')
          } else if (expression.kind === ts.SyntaxKind.ThisKeyword || expression.kind === ts.SyntaxKind.SuperKeyword) {
            const owner = flow.receiverOwnerOf(expression)
            if (!owner) fail('unindexed-receiver')
            else add(carry(nodeQuery('receiver', owner)))
          } else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
            if (sourceIntrinsicMemberMayBeWrittenOf(checker, flow, expression)) {
              const installed = sourceIntrinsicMemberDataWriteOf(checker, flow, expression)
              if (installed === null) fail('unproven-intrinsic-member-read', expression)
              else {
                add(carry(value(installed.value)))
                read(closure(installed.body))
              }
              break
            }
            const keys = keysOf(expression)
            const roots = read(value(expression.expression))
            for (const root of roots) {
              // An element read off an array literal is answered by the
              // literal only while `Array.prototype` is the original: the
              // obligation goes to the ledger, as the legacy element authority
              // (`nativeArrayProtocolPlanOf`) registered it, and refuses with
              // nothing to carry it.
              if (ts.isArrayLiteralExpression(root) && deferredIntrinsicProtocolLedgerOf(flow)?.require('Array', expression) !== true) {
                fail('undeferrable-array-protocol', expression)
                continue
              }
              if (isObjectRoot(root))
                for (const key of keys) {
                  if (
                    isSourceCallableObject(root) &&
                    key !== 'name' &&
                    key !== 'length' &&
                    sourceCallableOwnDataWriteOf(checker, flow, root, key, expression) === null
                  )
                    fail('unproven-callable-data-read', expression)
                  else add(carry(slot(root, key)))
                }
              else if (!isNullish(root)) fail('non-object-receiver')
            }
            // Every receiver nullish: the read throws, so the cell provably
            // holds nothing. Empty is the answer, witnessed here, not a
            // value still waiting on some origin.
            if (roots.size > 0 && [...roots].every(isNullish)) seeded = true
          } else if (ts.isCallExpression(expression)) add(carry(nodeQuery('completion', expression)))
          else if (ts.isConditionalExpression(expression)) {
            add(carry(value(expression.whenTrue)))
            add(carry(value(expression.whenFalse)))
          } else if (
            ts.isBinaryExpression(expression) &&
            [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(expression.operatorToken.kind)
          )
            add(carry(value(expression.right)))
          else if (
            ts.isBinaryExpression(expression) &&
            [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(
              expression.operatorToken.kind
            )
          ) {
            add(carry(value(expression.left)))
            add(carry(value(expression.right)))
          } else if (
            ts.isLiteralExpression(expression) ||
            expression.kind === ts.SyntaxKind.NullKeyword ||
            expression.kind === ts.SyntaxKind.TrueKeyword ||
            expression.kind === ts.SyntaxKind.FalseKeyword ||
            ts.isTypeOfExpression(expression) ||
            ts.isVoidExpression(expression) ||
            ts.isBinaryExpression(expression)
          ) {
            facts.add(expression)
            seeded = true
          } else fail('unmodelled-value-origin')
          break
        }
        case 'slot':
        case 'stored-slot': {
          const root = query.node
          const key = query.key
          const getterRead =
            ts.isNewExpression(root) && !isFreshOrdinaryObject(root) && !descriptorOf(root, key) ? familyReadOf(root, key) : null
          if (!descriptorOf(root, key) && getterRead === null) {
            // A literal that spells every key it has and holds no key this
            // graph cannot name reads `undefined` for the ones it lacks:
            // `options.attachment` on the `{}` a parameter defaults to.
            if (
              (ts.isObjectLiteralExpression(root) || isFreshOrdinaryObject(root)) &&
              absentOwnKey(root, key, root, descriptorOf, hasUnnamedWrite)
            ) {
              read(closure(root))
              if (query.kind === 'slot') {
                facts.add(undefinedValue)
                seeded = true
              }
            } else {
              fail('unmodelled-descriptor')
              break
            }
          }
          read(closure(root))
          if (isSourceCallableObject(root)) {
            if (key === 'name' || key === 'length') {
              const parameters = runtimeParametersOf(root)
              const firstDefault = parameters.findIndex(
                (parameter) => parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined
              )
              const named =
                (ts.isArrowFunction(root) ? undefined : root.name) ?? (ts.isVariableDeclaration(root.parent) ? root.parent.name : undefined)
              facts.add(
                key === 'name'
                  ? ts.factory.createStringLiteral(named && ts.isIdentifier(named) ? named.text : '')
                  : ts.factory.createNumericLiteral(firstDefault < 0 ? parameters.length : firstDefault)
              )
              seeded = true
            } else {
              const installed = sourceCallableOwnDataWriteOf(checker, flow, root, key)
              if (installed === null) fail('unproven-callable-data-slot', root)
              else add(carry(value(installed.value)))
            }
          } else if (ts.isObjectLiteralExpression(root)) {
            for (const entry of ownEntries(root, key) ?? []) {
              if (ts.isPropertyAssignment(entry)) add(carry(value(entry.initializer)))
              else if (ts.isShorthandPropertyAssignment(entry)) add(carry(value(entry.name)))
              else if (ts.isMethodDeclaration(entry)) {
                facts.add(entry)
                seeded = true
              }
            }
          } else if (ts.isArrayLiteralExpression(root)) {
            if (key === ELEMENT_KEY) {
              // Every position at once; an index never written reads undefined.
              for (const element of root.elements) if (!ts.isOmittedExpression(element)) add(carry(value(element)))
              facts.add(undefinedValue)
              seeded = true
            } else if (key === 'length') {
              let length = arrayLengths.get(root)
              if (!length) arrayLengths.set(root, (length = ts.factory.createNumericLiteral(root.elements.length)))
              facts.add(length)
              seeded = true
            } else {
              const element = root.elements[Number(key)]
              if (element !== undefined && !ts.isOmittedExpression(element)) add(carry(value(element)))
              else {
                facts.add(undefinedValue)
                seeded = true
              }
            }
          } else if (ts.isNewExpression(root) && !isFreshOrdinaryObject(root)) {
            for (const declaration of [...(classMembers(root, key) ?? []), ...(getterRead?.carriers ?? [])]) {
              if (ts.isMethodDeclaration(declaration)) {
                facts.add(declaration)
                seeded = true
              }
              if (ts.isPropertyDeclaration(declaration)) {
                if (declaration.initializer) add(carry(value(declaration.initializer)))
                else {
                  facts.add(undefinedValue)
                  seeded = true
                }
              }
              if (ts.isParameter(declaration)) add(carry(nodeQuery('parameter', declaration)))
            }
            if (getterRead !== null) {
              // The getter runs with this construction as its receiver, and
              // the read yields what the getter's completions yield.
              for (const getter of getterRead.getters) {
                for (const reference of flow.receiverReferencesToDeclaration(getter)) add(read(use(root, reference)))
                const summary = callableCompletionSummaryOf(flow, getter)
                if (summary === null || summary.execution !== 'sync') fail('unmodelled-getter-completion', getter)
                else {
                  for (const completion of summary.values) add(carry(value(completion)))
                  if (summary.mayCompleteUndefined) {
                    facts.add(undefinedValue)
                    seeded = true
                  }
                }
              }
              if (getterRead.absent) {
                facts.add(undefinedValue)
                seeded = true
              }
            }
          }
          // Only the writes that could name THIS key: the ones that spell it,
          // and the ones that spell no key at all. Walking every write in the
          // program here cost O(all writes) per (root, key) -- fine while
          // computed slots were rare, and quadratic the moment a `for-in` head
          // started naming a key set, which is what stopped a large class
          // from finishing.
          // The stores that go through this root are the root's own closure's
          // facts -- `visitUse` publishes each one as it walks -- and this
          // transfer already requires that closure above. Asking the write
          // index instead meant subscribing to every write naming this key
          // PLUS every computed write in the program, per slot, permanently:
          // hundreds of edges on each of a large program's tens of thousands of
          // slot states, and by far the largest contributor to its
          // multi-million-edge graph. Same answer, no
          // dependency this node was not already holding.
          for (const stored of read(closure(root))) {
            if (isSourceCallableObject(root) && ts.isCallExpression(stored)) {
              const installation = sourceCallableReflectSetOf(checker, stored)
              if (installation && installation.key === key && read(value(installation.target)).has(root))
                add(carry(value(installation.value)))
              continue
            }
            if (ts.isCallExpression(stored) && definitionPlans.has(stored)) {
              const plan = definitionOf(stored)
              if (plan === null || !plan.keys.includes(key) || !read(value(stored.arguments[0]!)).has(root)) continue
              if (plan.values.length === 0) {
                facts.add(undefinedValue)
                seeded = true
              }
              for (const defined of plan.values) add(carry(value(defined)))
              continue
            }
            if (ts.isCallExpression(stored)) {
              // `Object.assign( root, ...sources )`: each source's own value
              // under this key lands in the root. Only a literal whose keys
              // are all spelled says what it holds; `null`/`undefined`
              // sources are skipped by the intrinsic itself.
              const bulk = bulkAssignOf(stored)
              if (bulk === null || !read(value(bulk.target)).has(root)) continue
              for (const source of bulk.sources)
                for (const held of read(value(source))) {
                  if (held === undefinedValue || held.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(held)) continue
                  if (!ts.isObjectLiteralExpression(held)) fail('bulk-assign-source-unmodelled', source)
                  else if (literalSpelledKeys(held) === null || hasUnnamedWrite(held)) fail('bulk-assign-source-keys-open', source)
                  else if (ownKeysOf(held)?.includes(key)) add(carry(storedSlot(held, key)))
                }
              continue
            }
            if (!ts.isPropertyAccessExpression(stored) && !ts.isElementAccessExpression(stored)) continue
            const edge = writeEdgeByAccess.get(stored)
            if (edge === undefined) continue
            if (!keyReaches(root, keysOf(stored), key)) continue
            const write = edge.write
            if (write.edge === 'delete' && (ts.isObjectLiteralExpression(root) || isFreshOrdinaryObject(root))) {
              // Removing an own data descriptor contributes no stored payload.
              // A value read can also reach the prototype after that removal.
              if (query.kind === 'slot') {
                const ledger = deferredIntrinsicProtocolLedgerOf(flow)
                const absence = sourceObjectPrototypeAbsenceOf(checker, [key], stored)
                if (!ledger || absence === null || !ledger.include([absence])) fail('unproven-deleted-slot-absence', stored)
                else {
                  facts.add(undefinedValue)
                  seeded = true
                }
              }
              continue
            }
            if (write.value === null || !['property-assignment', 'index-assignment', 'class-field-initializer'].includes(write.edge)) {
              fail('unmodelled-property-write', stored)
              continue
            }
            add(carry(value(write.value)))
          }
          break
        }
        case 'construct-targets': {
          const selected = constructionFrames.targetsOf(query.node)
          if (selected === null) fail('opaque-construction-frame')
          else {
            add(selected)
            seeded = selected.length > 0
          }
          break
        }
        case 'super-targets': {
          const dispatch = sites.get(query.node)?.operands.dispatch
          // An object-literal home has no `extends` chain to walk, and a
          // static home starts its lookup on the constructor object, not the
          // prototype: both are other domains, named rather than mishandled.
          const home =
            dispatch?.kind === 'lexical-super' && dispatch.home !== null && !ts.isObjectLiteralExpression(dispatch.home)
              ? dispatch.home
              : null
          if (dispatch?.kind !== 'lexical-super' || dispatch.static || dispatch.key === null || home === null) {
            fail('unmodelled-super-lookup')
            break
          }
          const selected = superLookup(home, dispatch.key, new Set())
          if (selected === null) fail('unresolved-super-lookup', home)
          else {
            add(selected)
            seeded = selected.length > 0
          }
          break
        }
        case 'targets': {
          const site = sites.get(query.node)
          if (site?.operands && !site.explicitThis && site.operands.dispatch.kind === 'lexical-super') {
            add(carry(superTargets(query.node)))
            break
          }
          // `super()` selects a BASE CONSTRUCTOR, which is the construction
          // domain's question and already answered there -- the same selection
          // `new Base()` makes, reached from the subclass's heritage instead of
          // from a spelled callee.
          if (site?.operands && !site.explicitThis && site.operands.dispatch.kind === 'super-constructor') {
            add(carry(nodeQuery('construct-targets', query.node)))
            break
          }
          // `.call`/`.apply` needs no separate resolver here: `operands.callee`
          // is already the executable callee with the wrapper removed, and the
          // thisArg is already out of `args`. What made this dispatch special
          // was carrying the receiver, which is a FRAME question answered where
          // frames are projected.
          if (!site?.operands) {
            fail('unmodelled-dispatch')
            break
          }
          const operands = candidateOrdinaryOwnCallableOperandsOf(query.node) ?? site.operands
          for (const candidate of read(value(operands.callee))) {
            if (isBody(candidate) && flow.callableBodyIsIndexed(candidate)) {
              facts.add(candidate)
              seeded = true
            } else if (candidate.kind !== ts.SyntaxKind.NullKeyword && !ts.isVoidExpression(candidate))
              fail('opaque-call-target', candidate)
          }
          if (sealing && facts.size === 0 && !lookupThrows(query.node)) fail('no-source-call-target')
          break
        }
        case 'completion': {
          if (ts.isCallExpression(query.node)) {
            const bulk = bulkAssignOf(query.node)
            if (bulk !== null) {
              add(carry(value(bulk.target)))
              break
            }
            // `store.get( key )` on a native Map this program alone fills:
            // the completion is one of the values `store.set( _, value )`
            // stored, whichever key -- the same closed-map proof
            // (`collectionValueFlowOf`) that refuses the moment the map or
            // its values leave through anything but these reads. Asked before
            // `targets`, because a native method has no source body to
            // select, and the receiver walk would otherwise end at `new Map()`
            // as an opaque construction. The stores themselves continue at
            // these reads (`visitUse` below), so the two are one graph.
            const stored = collectionStoredValuesOf(checker, flow, query.node, nativeProtocolClosed)
            if (stored !== null) {
              for (const candidate of stored) add(carry(value(candidate)))
              break
            }
          }
          if (ts.isNewExpression(query.node)) {
            for (const candidate of read(value(query.node.expression))) {
              if (
                ts.isFunctionDeclaration(candidate) &&
                flow.callableBodyIsIndexed(candidate) &&
                candidate === constructorFunctionCalleeOf(query.node) &&
                constructionYieldsCompletionOf(flow, candidate)
              )
                add(carry(frameQuery('frame-completion', query.node, candidate)))
              else fail('opaque-construction', candidate)
            }
            break
          }
          for (const body of read(targets(query.node))) {
            if (!isBody(body)) fail('unindexed-body', body)
            else add(carry(frameQuery('frame-completion', query.node, body)))
          }
          if (ts.isCallExpression(query.node) && lookupThrows(query.node)) seeded = true
          break
        }
        case 'frame-receiver':
        case 'frame-argument':
        case 'frame-parameter':
        case 'frame-value':
        case 'frame-completion': {
          const own = ts.isCallExpression(query.node) ? candidateOrdinaryOwnCallableOperandsOf(query.node) : null
          const layout = sourceInvocationFrameLayoutOf(flow, query.node, query.body, own ?? undefined)
          if (!layout) {
            fail('unindexed-source-frame')
            break
          }
          const contextual = (expression: ts.Expression): Query =>
            frameQuery('frame-value', query.node, query.body, unwrapErasedExpression(expression))
          if (query.kind === 'frame-receiver') {
            const receiver = layout.receiver
            if (receiver.kind === 'undefined') {
              facts.add(undefinedValue)
              seeded = true
            } else if (receiver.kind === 'expression') {
              const memberCall = !layout.operands.explicitThis
              for (const candidate of carry(value(receiver.expression))) {
                // `source.attachment.clone()` with no attachment set:
                // the member lookup on `null` throws and the frame never runs
                // with that receiver. Only an explicit `f.call( null )` binds
                // a nullish receiver.
                if (memberCall && isNullish(candidate)) continue
                if (receiver.conversion === 'identity' || isObjectRoot(candidate) || isBody(candidate)) facts.add(candidate)
                else
                  fail(
                    ts.isVoidExpression(candidate) || candidate.kind === ts.SyntaxKind.NullKeyword
                      ? 'global-object-receiver-origin'
                      : 'primitive-receiver-conversion',
                    receiver.expression
                  )
              }
            } else if (receiver.kind === 'constructed') add(carry(value(receiver.call)))
            else if (receiver.kind === 'lexical' && receiver.source !== 'arrow') {
              // `super.m()` and `super()` run with the calling frame's own
              // `this`; the class the layout names is only where the lookup
              // starts, and no receiver is owned by a class.
              const callee = ts.isCallExpression(query.node) ? unwrapErasedExpression(query.node.expression) : null
              const keyword =
                callee === null
                  ? null
                  : callee.kind === ts.SyntaxKind.SuperKeyword
                    ? callee
                    : (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
                        callee.expression.kind === ts.SyntaxKind.SuperKeyword
                      ? callee.expression
                      : null
              if (keyword === null) fail('unresolved-super-home', query.node)
              else add(carry(value(keyword)))
            } else if (receiver.kind === 'lexical' && receiver.owner) {
              if (ts.isSourceFile(receiver.owner)) {
                if (ts.isExternalModule(receiver.owner)) {
                  facts.add(undefinedValue)
                  seeded = true
                } else fail('global-object-receiver-origin', receiver.owner)
              } else add(carry(nodeQuery('receiver', receiver.owner)))
            } else fail(receiver.kind === 'unsupported' ? receiver.reason : 'global-object-receiver-origin')
          } else if (query.kind === 'frame-argument' || query.kind === 'frame-parameter') {
            const parameter = query.subject
            if (!parameter || !ts.isParameter(parameter) || parameter.parent !== query.body) {
              fail('unindexed-parameter-frame')
              break
            }
            if (query.kind === 'frame-parameter') {
              add(carry(frameQuery('frame-argument', query.node, query.body, parameter)))
              for (const write of flow.writesToDeclaration(parameter)) {
                if (write.edge === 'call-argument' || write.edge === 'super-argument' || write.edge === 'default-parameter') continue
                if (write.slot !== 'whole') continue
                if (!['identifier-assignment', 'logical-assignment'].includes(write.edge) || !write.value)
                  fail('unmodelled-parameter-write', write.site)
                else add(carry(contextual(write.value)))
              }
              break
            }
            if (layout.arguments.kind === 'spread') {
              fail('spread-arguments')
              break
            }
            const slot = layout.arguments.slots.find((candidate) => candidate.parameter === parameter)
            if (!slot || slot.kind === 'rest') {
              fail('unmodelled-parameter-frame', parameter)
              break
            }
            if (slot.actual) {
              for (const candidate of carry(value(slot.actual))) {
                if (ts.isVoidExpression(candidate) && slot.defaultValue) add(carry(contextual(slot.defaultValue)))
                else facts.add(candidate)
              }
            } else if (slot.defaultValue) add(carry(contextual(slot.defaultValue)))
            else {
              facts.add(undefinedValue)
              seeded = true
            }
          } else if (query.kind === 'frame-completion') {
            const summary = callableCompletionSummaryOf(flow, query.body)
            if (!summary || summary.execution !== 'sync') fail('deferred-completion', query.body)
            else {
              for (const expression of summary.values) add(carry(contextual(expression)))
              if (summary.mayCompleteUndefined || (ts.isCallExpression(query.node) && ts.isCallChain(query.node))) {
                facts.add(undefinedValue)
                seeded = true
              }
            }
          } else {
            const expression = query.subject
            if (!expression || ts.isParameter(expression)) {
              fail('unindexed-frame-value')
              break
            }
            const declaration = ts.isIdentifier(expression) ? flow.targetOf(expression)?.declaration : null
            if (declaration && ts.isParameter(declaration) && declaration.parent === query.body)
              add(carry(frameQuery('frame-parameter', query.node, query.body, declaration)))
            else if (
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              ts.findAncestor(declaration, ts.isFunctionLike) === query.body
            ) {
              const incoming = sourceBindingValuesOf(checker, flow, declaration, iterationValuesAt)
              if (incoming === null) fail('unaccounted-binding-write', declaration)
              else for (const entry of incoming) add(carry(contextual(entry)))
              if (incoming !== null && bindingReadMayPrecedeFirstWrite(declaration, expression)) {
                facts.add(undefinedValue)
                seeded = true
              }
            } else if (
              (expression.kind === ts.SyntaxKind.ThisKeyword || expression.kind === ts.SyntaxKind.SuperKeyword) &&
              (ts.isArrowFunction(query.body) || flow.receiverOwnerOf(expression) === query.body)
            )
              add(carry(frameQuery('frame-receiver', query.node, query.body)))
            else if (ts.isConditionalExpression(expression)) {
              add(carry(contextual(expression.whenTrue)))
              add(carry(contextual(expression.whenFalse)))
            } else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
              const keys = keysOf(expression)
              for (const root of read(contextual(expression.expression))) {
                if (isObjectRoot(root))
                  for (const key of keys) {
                    if (
                      isSourceCallableObject(root) &&
                      key !== 'name' &&
                      key !== 'length' &&
                      sourceCallableOwnDataWriteOf(checker, flow, root, key, expression) === null
                    )
                      fail('unproven-callable-data-read', expression)
                    else add(carry(slot(root, key)))
                  }
                else if (root.kind !== ts.SyntaxKind.NullKeyword && !ts.isVoidExpression(root)) fail('non-object-receiver')
              }
            } else if (
              ts.isBinaryExpression(expression) &&
              [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.CommaToken].includes(expression.operatorToken.kind)
            )
              add(carry(contextual(expression.right)))
            else if (
              ts.isBinaryExpression(expression) &&
              [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(
                expression.operatorToken.kind
              )
            ) {
              add(carry(contextual(expression.left)))
              add(carry(contextual(expression.right)))
            } else add(carry(value(expression)))
          }
          break
        }
        case 'parameter': {
          parameterValues(query.node, null)
          break
        }
        case 'binding-element': {
          const element = query.node
          const pattern = element.parent
          const holder = pattern.parent
          const key = bindingElementKey(element)
          // A rest element holds a FRESH object built from the keys nothing
          // else took -- unmodelled regardless of presence.
          if (element.dotDotDotToken) fail('rest-binding-element', element)
          else if (key === null) fail('computed-binding-element', element)
          else {
            // The container is whatever cell holds the object being taken
            // apart, and every form of it is already a query: a parameter, an
            // outer binding element of a nested pattern, or the initializer of
            // a destructuring declaration.
            const container = bindingContainer(element)
            if (container === null) fail('unmodelled-binding-container', holder)
            else {
              const roots = read(container)
              // A default makes the cell's value depend on whether the slot
              // was present -- a presence fact this graph does not otherwise
              // carry, EXCEPT for the one shape `ownEntries` already answers:
              // an object-literal root that OWNS this key outright (a plain
              // property, no spread, no accessor). JS only consults a
              // destructuring default when the read is exactly `undefined`,
              // and a literal's own stated property is never that by
              // omission -- so when every root the container resolves to is
              // such a literal, the default is dead code and the slot reads
              // below are the whole, sound answer. A host-options literal
              // like `new Renderer({ canvas, context, depth: true, ... })`
              // states every field its constructor destructures
              // with a default, so refusing EVERY defaulted binding element
              // unconditionally made the host context -- and everything
              // downstream of it, the whole host surface -- permanently unenumerable no
              // matter what the program actually wrote at the call site.
              const defaultIsLive =
                element.initializer !== undefined &&
                (roots.size === 0 || [...roots].some((root) => !ts.isObjectLiteralExpression(root) || ownEntries(root, key) === null))
              if (defaultIsLive) fail('defaulted-binding-element', element)
              else
                for (const root of roots) {
                  if (
                    isSourceCallableObject(root) &&
                    key !== 'name' &&
                    key !== 'length' &&
                    sourceCallableOwnDataWriteOf(checker, flow, root, key, element) === null
                  )
                    fail('unproven-callable-data-read', element)
                  else if (isObjectRoot(root)) add(carry(slot(root, key)))
                  else fail('non-object-destructured-container', element)
                }
            }
          }
          break
        }
        case 'receiver': {
          const owner = query.node
          if (ts.isSourceFile(owner) && ts.isExternalModule(owner)) {
            facts.add(undefinedValue)
            seeded = true
          } else if (
            ts.isConstructorDeclaration(owner) ||
            ts.isPropertyDeclaration(owner) ||
            ts.isGetAccessorDeclaration(owner) ||
            ts.isSetAccessorDeclaration(owner)
          ) {
            for (const construction of constructionsOf(owner)) add(carry(value(construction)))
          } else if (isBody(owner)) {
            read(closure(owner))
            for (const construction of constructionsOf(owner)) add(carry(value(construction)))
            for (const call of read(callersOf(owner))) if (ts.isCallExpression(call)) add(carry(frameQuery('frame-receiver', call, owner)))
          } else fail('unmodelled-receiver-owner')
          break
        }
        case 'callers': {
          // The exact filter every inline caller used to run for itself --
          // moved here so the whole-program walk it does for an unnamed body
          // is paid once per OWNER, not once per (owner, consumer) pair. See
          // `callersOf`'s comment for the shape and the measured cost this
          // replaces.
          // Discovery by name, soundness by CLOSURE. The spelled calls that
          // resolve to this owner are its callers only while the owner can
          // be reached from nowhere else: the body's own closure says where
          // the callable value goes, and for a class member each instance's
          // closure says where the receivers go -- an instance handed to
          // unknown code can be called through from there with arguments no
          // site spells. A spelled call whose targets are opaque is then
          // either a call through one of those closures, which already
          // refused, or a call on something that never holds this owner.
          // Requiring every candidate's targets instead made a class's `copy`
          // wait on `targetMatrix.copy( ... )` inside a module-level helper
          // literal, a matrix the graph never places.
          const owner = query.node
          // A constructor is never CALLED: its frames are its construction
          // sites, which `constructionSitesTargeting` names from the
          // construction domain, so it has no closure to read here.
          if (ts.isConstructorDeclaration(owner)) break
          read(closure(owner))
          if (ts.isClassElement(owner) && ts.isClassLike(owner.parent)) {
            if ((ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Static) !== 0) fail('static-member-callers-open', owner)
            else for (const instance of familyInstancesOf(owner.parent, 'member-family-open') ?? []) read(closure(instance))
          }
          for (const candidate of callerCandidatesOf(owner)) {
            if (candidate.call === null || observe(targets(candidate.call)).has(owner)) facts.add(candidate.site.call)
          }
          break
        }
        case 'closure': {
          const root = query.node
          if (ts.isFunctionDeclaration(root)) {
            // `refs` follows the same import inventory as stored cells. A
            // factory imported by a source module is not an external escape.
            if (importerMentions(root) === null) fail('exported-callable')
            if (!sourceGlobalCallableBindingIsClosed(checker, flow, root)) fail('global-object-callable')
            refs(root, root)
          } else if (ts.isMethodDeclaration(root)) {
            if (ts.isObjectLiteralExpression(root.parent)) {
              const key = declarationKey(root.name)
              if (key === null) fail('computed-method')
              else add(read(publication(root, root.parent, key)))
            } else refs(root, root)
          } else if (ts.isExpression(root)) add(read(use(root, root)))
          else fail('unmodelled-root')
          if (ts.isNewExpression(root) && !isFreshOrdinaryObject(root)) {
            const owners = constructionFrames.receiverOwnersOf(root)
            if (!owners) {
              fail('opaque-construction')
              break
            }
            for (const owner of owners) {
              if (!isClassSpelledSourceClass(owner)) {
                for (const reference of flow.receiverReferencesToDeclaration(owner)) add(read(use(root, reference)))
                continue
              }
              for (const member of owner.members) {
                if (
                  ts.isConstructorDeclaration(member) ||
                  (ts.isPropertyDeclaration(member) && (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0)
                )
                  for (const reference of flow.receiverReferencesToDeclaration(member)) add(read(use(root, reference)))
              }
            }
          }
          break
        }
        case 'use':
          visitUse(query.root, query.node)
          break
        case 'unknown-reads': {
          // Inverted from a scan of all 968 receivers to a reverse-index
          // lookup: `holdersOf` hands back the receiver queries that hold
          // THIS container, so the container asks once instead of every
          // container asking the same 968-entry list. A holder that is not
          // one of the unknown-read receivers -- a `slot`, `parameter` or any
          // other kind of state that also happens to hold this exact node --
          // is not in `unknownReadsByReceiver` and is simply skipped.
          for (const holder of holdersOf(query.node))
            for (const entry of unknownReadsByReceiver.get(holder) ?? NO_READS) facts.add(entry.access)
          break
        }
        case 'own-keys': {
          const root = query.node
          const keys = ownKeysOf(root)
          if (keys === null) {
            fail('unspelled-own-key-domain', root)
            break
          }
          const stored = read(closure(root))
          for (const key of keys) facts.add(keyValue(root, key))
          seeded = true
          // Discovery subscriptions alone cannot authenticate a bulk source.
          // Require each contributing source's complete keys and closure in
          // the same solver graph, including keys that it acquired earlier.
          for (const write of stored) {
            if (!ts.isCallExpression(write)) continue
            const bulk = bulkAssignOf(write)
            if (bulk === null || !read(value(bulk.target)).has(root)) continue
            for (const source of bulk.sources)
              for (const held of read(value(source))) {
                if (isNullish(held)) continue
                if (!ts.isObjectLiteralExpression(held)) fail('bulk-assign-source-unmodelled', source)
                else
                  for (const key of read(nodeQuery('own-keys', held))) {
                    if (ts.isStringLiteral(key)) facts.add(keyValue(root, key.text))
                    else fail('unmodelled-own-key-value', held)
                  }
              }
          }
          break
        }
        case 'publication': {
          read(closure(query.node))
          // A container merged into another by `Object.assign` hands this
          // key's value to the target as well.
          for (const stored of read(closure(query.node))) {
            if (!ts.isCallExpression(stored)) continue
            const bulk = bulkAssignOf(stored)
            if (bulk === null || !bulk.sources.some((source) => read(value(source)).has(query.node))) continue
            for (const held of read(value(bulk.target))) if (isObjectRoot(held)) add(read(publication(query.root, held, query.key)))
          }
          for (const stored of read(closure(query.node))) {
            const copied = ts.isExpression(stored) ? outermostErasureOf(stored).parent : undefined
            if (copied && ts.isSpreadAssignment(copied) && read(value(copied.expression)).has(query.node))
              add(read(publication(query.root, copied.parent, query.key)))
            if (!ts.isCallExpression(stored) || !definitionPlans.has(stored) || query.key !== 'value') continue
            const plan = definitionOf(stored)
            if (plan === null || !read(value(stored.arguments[2]!)).has(query.node)) continue
            for (const held of read(value(stored.arguments[0]!)))
              if (isObjectRoot(held)) for (const key of plan.keys) add(read(publication(query.root, held, key)))
          }
          const aliases = ts.isArrayLiteralExpression(query.node)
            ? query.key === ELEMENT_KEY
              ? [...readsByKey.keys()].filter((key) => key === ELEMENT_KEY || isCanonicalIndex(key))
              : isCanonicalIndex(query.key)
                ? [query.key, ELEMENT_KEY]
                : [query.key]
            : [query.key]
          for (const alias of aliases)
            for (const entry of readsByKey.get(alias) ?? NO_READS) {
              if (!observe(entry.receiver).has(query.node)) continue
              if (keyReaches(query.node, keysOf(entry.access), query.key)) add(read(use(query.root, entry.access)))
            }
          // Discovery-only, exactly as the receiver test it replaces was: a
          // publication never required the unknown reads to have settled, it
          // only had to see the ones that had.
          for (const access of observe(unknownReadsOf(query.node))) {
            if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) continue
            if (keyReaches(query.node, keysOf(access), query.key)) add(read(use(query.root, access)))
          }
          // The value this key holds also reaches every cell a binding element
          // of this container declares. Enumerating only `propertyAccesses`
          // left `const { app } = p; sink(app)` out of the inventory, which is
          // a hole in a closure proof, not a missing capability.
          for (const element of both(patternReadsByKey.get(query.key), unknownPatternReads)) {
            const container = bindingContainer(element)
            if (container === null || !observe(container).has(query.node)) continue
            if (element.dotDotDotToken || bindingElementKey(element) === null) fail('unmodelled-container-read', element)
            else refs(query.root, element)
          }
          if (ts.isArrayLiteralExpression(query.node) && (query.key === ELEMENT_KEY || isCanonicalIndex(query.key)))
            for (const write of (valueIterationWrites ??= flow.allWrites.filter((write) => write.iterationOrigin?.mode === 'values'))) {
              const origin = write.iterationOrigin!
              if (!observe(value(origin.source)).has(query.node)) continue
              if (origin.asynchronous || deferredIntrinsicProtocolLedgerOf(flow)?.require('Array', origin.source) !== true) {
                fail('unproven-array-iteration', write.site)
                continue
              }
              const declaration = write.target.declaration
              if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) refs(query.root, declaration)
              else fail('unmodelled-iteration-binding', write.site)
            }
          break
        }
      }
      finalCauses = causes
      // Only the seal reads the grounding edges, and the seal is the last
      // call this query receives; materializing the list on every transfer
      // allocated one object per carried edge per re-evaluation for nothing.
      if (sealing) finalGrounding = [...grounding].map((dependency) => ({ domain: VALUE_ORIGIN, dependency }))
      return facts
    }
    const run = (read: Read, observe: Read, holdersOf: DependencyFactHoldersOf<Query, Value>, sealing: boolean): ReadonlySet<Value> => {
      const ledger = deferredIntrinsicProtocolLedgerOf(flow)
      if (!ledger) return evaluate(read, observe, holdersOf, sealing)
      const captured = ledger.capture(() => evaluate(read, observe, holdersOf, sealing))
      // Overwrite, not union -- like `finalCauses`/`finalGrounding` above,
      // this is safe ONLY because `evaluate` is monotone: `facts` published to
      // the solver (`component-solver.ts`'s `state.facts`) accumulate forever
      // regardless of what any one call returns, so the LAST call for this
      // query (the seal that ends the re-seal loop) is the only one whose
      // `facts` can differ from that accumulated set, and then only by being
      // equal to it. `arrayElementKeys`' widen-on-empty was the one place that
      // invariant broke -- an early pass published every element as a
      // permanent fact that a later, exact pass never re-derived, so the
      // ledger requirement that early pass owed was needed forever but this
      // map would have forgotten it the moment a narrower pass overwrote it.
      // With that widening now gated on `sealing`, no known transfer in this
      // file can produce fewer facts on a later call than an earlier one
      // already published, and a requirement that is raised without being
      // needed is merely a stricter refusal, while a needed one gone missing
      // is a wrong answer -- so if this invariant is ever broken again by a
      // NEW transfer, union (not overwrite) is the direction that cannot lie:
      // `both(requirements.get(query), captured.requirements)`.
      requirements.set(query, captured.requirements)
      return captured.value
    }
    return {
      transfer: (read, observe, holdersOf) => run(read, observe, holdersOf, false),
      seal: (read, observe, holdersOf) => {
        run(read, observe, holdersOf, true)
        const carriesValue = VALUE_CARRYING_KINDS.has(query.kind)
        return {
          locallyComplete: finalCauses.length === 0,
          causes: finalCauses,
          groundingRequirements: carriesValue ? [VALUE_ORIGIN] : [],
          groundingSeeds: seeded ? [VALUE_ORIGIN] : [],
          groundingDependencies: finalGrounding
        }
      }
    }
  }
  const { solve, requiredDependenciesOf, seed } = dependencyFactSolver(define, 'grounding-domains')
  // `case 'unknown-reads'` now asks `holdersOf` for the receivers that hold a
  // container, instead of `observe`-ing all 968 of them itself -- but a
  // reverse index only finds states that already EXIST and have already run.
  // The `observe` calls it replaces used to materialise every receiver as a
  // SIDE EFFECT of `factsFrom`'s own `stateOf`; dropping them without this
  // loop would leave a receiver nothing else in the program asks about never
  // created; `holdersOf(container)` would then silently return nothing for
  // it, missing a read that program prints. Seeded once here, for the whole
  // session, not once per container: 968 scheduling operations total, zero
  // stored edges, against the 455,769 observe edges this replaces.
  for (const entry of unknownReads) seed(entry.receiver)
  // `hasUnnamedWrite` asks the same reverse question of every computed write's receiver.
  for (const receiver of computedWriteReceiverQueries) seed(receiver)
  const obligations = (root: Query): readonly IntrinsicProtocolRequirement[] => {
    const found: IntrinsicProtocolRequirement[] = []
    const visited = new Set<Query>()
    const queue = [root]
    for (let index = 0; index < queue.length; index++) {
      const query = queue[index]!
      if (visited.has(query)) continue
      visited.add(query)
      found.push(...(requirements.get(query) ?? []))
      for (const dependency of requiredDependenciesOf(query)) queue.push(dependency)
    }
    return found
  }
  // A literal's function-valued entry (`convert: function ( ... ) { ... }`)
  // is the same slot as its shorthand method: one literal, one write, no
  // nominal family. Both spellings commonly occur in one literal.
  const isObjectLiteralCallableEntry = (declaration: ts.Declaration): boolean =>
    ts.isObjectLiteralExpression(declaration.parent) &&
    !declaration.getSourceFile().isDeclarationFile &&
    (isSourceInstanceMethod(declaration) ||
      (ts.isPropertyAssignment(declaration) &&
        (ts.isFunctionExpression(declaration.initializer) ||
          ts.isArrowFunction(declaration.initializer) ||
          // `{ texImage3D: texImage3D }`: the entry names a source function;
          // the slot's value is that function's binding, which the graph
          // resolves as it resolves any identifier.
          (ts.isIdentifier(declaration.initializer) && isBody(flow.targetOf(declaration.initializer)?.declaration ?? declaration)))))
  const admitted = (query: Query): readonly Value[] | null => {
    const result = solve(query)
    if (result.status !== 'complete') return null
    const required = obligations(query)
    if (required.length && deferredIntrinsicProtocolLedgerOf(flow)?.include(required) !== true) return null
    return [...result.facts]
  }
  const invocationTargetsOf = (call: ts.CallExpression): readonly ts.SignatureDeclaration[] | null => {
    const found = admitted(targets(call))
    return found !== null && found.every(isCallableValue) ? found : null
  }
  const ownSlotOf = (expression: ts.Expression, key: string): SourceOwnSlot | null => {
    const incoming = admitted(value(expression))
    if (incoming === null) return null
    // This inventory names owners on the normal [[Get]]/[[Set]] path.
    // Nullish receiver alternatives throw at lookup, as the property-value
    // transfer above already models; they have no data slot to inventory.
    // Stored values remain untouched, including a real stored undefined.
    const roots = incoming.filter((root) => !isNullish(root))
    if (roots.length === 0) return null
    if (roots.every((root) => ts.isObjectLiteralExpression(root) && literalSpelledKeys(root)?.includes(key))) return null
    const slots: SourceOwnSlot['roots'][number][] = []
    for (const root of roots) {
      if (
        (!ts.isObjectLiteralExpression(root) && !sourceFreshOrdinaryObjectOf(checker, root)) ||
        literalSpelledKeys(root) === null ||
        (ts.isObjectLiteralExpression(root) &&
          root.properties.some((property) => !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)))
      )
        return null
      const uses = admitted(closure(root))
      if (uses === null || uses.some((use) => ts.isCallExpression(use) && definitionPlans.has(use))) return null
      const values = admitted(storedSlot(root, key))
      if (values === null) return null
      const writes: Access[] = []
      for (const use of uses) {
        if ((!ts.isPropertyAccessExpression(use) && !ts.isElementAccessExpression(use)) || !writeEdgeByAccess.has(use)) continue
        const direct = accessKey(use)
        if (direct !== null) {
          if (direct === key) writes.push(use)
          continue
        }
        if (!ts.isElementAccessExpression(use)) return null
        const names = admitted(value(use.argumentExpression))
        if (names === null || names.length === 0 || names.some((name) => !ts.isStringLiteralLike(name) && !ts.isNumericLiteral(name)))
          return null
        if (names.some((name) => (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) && name.text === key)) writes.push(use)
      }
      slots.push({ root, values, writes })
    }
    return { key, roots: slots }
  }
  const callerSitesOf = (body: ts.SignatureDeclaration): readonly (ts.CallExpression | ts.NewExpression)[] | null => {
    const callers = admitted(callersOf(body))
    return callers !== null && callers.every((caller) => ts.isCallExpression(caller) || ts.isNewExpression(caller))
      ? callers.filter(
          (caller): caller is ts.CallExpression | ts.NewExpression => ts.isCallExpression(caller) || ts.isNewExpression(caller)
        )
      : null
  }
  const ordinaryOwnCallableOperandsOf = (call: ts.CallExpression): FlowInvocationOperands | null => {
    const candidate = candidateOrdinaryOwnCallableOperandsOf(call)
    if (candidate === null) return null
    const found = admitted(targets(call))
    return found !== null && found.length > 0 && found.every(isCallableValue) ? candidate : null
  }
  const parameterSourceExpressionsOf = (parameter: ts.ParameterDeclaration): readonly ts.Expression[] | null => {
    const body = parameter.parent
    if (
      !isBody(body) ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined ||
      !ts.isIdentifier(parameter.name) ||
      !runtimeParametersOf(body).includes(parameter) ||
      flow.writesToDeclaration(parameter).some((write) => write.slot === 'whole' && write.edge !== 'call-argument')
    )
      return null
    const callers = callerSitesOf(body)
    if (callers === null) return null
    const expressions = new Set<ts.Expression>()
    for (const call of callers) {
      if (!ts.isCallExpression(call) || !invocationTargetsOf(call)?.includes(body)) return null
      const candidate = candidateOrdinaryOwnCallableOperandsOf(call)
      const own = ordinaryOwnCallableOperandsOf(call)
      if (candidate !== own) return null
      const frame = sourceInvocationFrameLayoutOf(flow, call, body, own ?? undefined)
      if (frame?.arguments.kind !== 'positional') return null
      const slot = frame.arguments.slots.find((one) => one.parameter === parameter)
      if (slot?.kind !== 'single' || slot.actual === null || slot.defaultValue !== null) return null
      expressions.add(slot.actual)
    }
    return [...expressions]
  }
  /** The copy no closed allocation family accounts for, described by its
   * operands' representations instead: no target root or slot domain is a
   * session fact (the IR proves the exact target allocation and its census
   * sizes any key it lacks), and every source's keys are the ones its
   * representation lays out (`describedKeysOf`). The session decides no key
   * set of its own; it publishes only the absence obligation over those
   * keys, since each may be absent from the target and [[Set]] then consults
   * the intact Object.prototype. */
  const describedOwnAssignmentOf = (
    call: ts.CallExpression,
    bulk: { readonly target: ts.Expression; readonly sources: readonly ts.Expression[] },
    describedKeysOf: ((expression: ts.Expression) => readonly string[] | null) | undefined
  ): SourceOwnAssignment | null => {
    if (bulk.sources.length === 0 || describedKeysOf === undefined) return null
    const sources: SourceOwnAssignment['sources'][number][] = []
    const copied = new Set<string>()
    for (const [index, expression] of bulk.sources.entries()) {
      const keys = describedKeysOf(expression)
      if (keys === null) return null
      // The description copies the declared keys through the source's
      // carrier, so a literal the source is known to hold must have no other
      // key and no replaced descriptor, ever: its own complete key domain and
      // closure say so, and fail where it was published, coerced, written
      // under a computed key or redefined. That is the SOURCE's own proof; the
      // closed family additionally closes the TARGET, which a target read
      // through a whole program (a constructor's `options` bag) cannot. A
      // literal held in an `any` position was handed to dynamic code as a
      // Document, and a typed read of it is a live view over those entries.
      const declared = new Set(keys)
      for (const root of admitted(value(expression)) ?? []) {
        if (!ts.isObjectLiteralExpression(root)) continue
        const contextual = checker.getContextualType(root)
        if (contextual !== undefined && (contextual.flags & ts.TypeFlags.Any) !== 0) continue
        const owned = admitted(nodeQuery('own-keys', root))
        if (owned === null || owned.some((key) => !ts.isStringLiteral(key) || !declared.has(key.text))) return null
        const writes = admitted(nodeQuery('closure', root))
        if (writes === null || writes.some((write) => ts.isCallExpression(write) && definitionPlans.has(write))) return null
      }
      for (const key of keys) copied.add(key)
      const type = checker.getTypeAtLocation(expression)
      const nullable = (type.isUnion() ? type.types : [type]).some(
        (one) => (one.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
      )
      sources.push({ ordinal: index + 1, expression, nullable, roots: [], described: { keys } })
    }
    // A key a fresh literal target spells is its own data property when the
    // copy runs (no source can reach the literal first), so [[Set]] never
    // consults the prototype for it.
    const fresh = unwrapErasedExpression(bulk.target)
    const spelled = ts.isObjectLiteralExpression(fresh) ? (literalSpelledKeys(fresh) ?? []) : []
    const missing = [...copied].filter((key) => !spelled.includes(key))
    if (!prototypeLacksCopiedKeys(missing, call)) return null
    return { call, targets: [], targetSlots: [], sources }
  }
  /** A source slot writes through [[Set]], not CreateDataProperty. A key
   * absent from the fresh target must also lack an inherited interceptor;
   * initial declaration absence alone does not prove the final prototype. */
  const prototypeLacksCopiedKeys = (missing: readonly string[], call: ts.CallExpression): boolean => {
    if (missing.length === 0) return true
    const ledger = deferredIntrinsicProtocolLedgerOf(flow)
    const absence = sourceObjectPrototypeAbsenceOf(checker, missing, call)
    return ledger !== null && absence !== null && ledger.include([absence])
  }
  // The closed literal family is the stronger fact and is preferred; where
  // the session cannot close it, the operands' representations describe it.
  const ownAssignmentOf = (
    call: ts.CallExpression,
    frames?: SourceInvocationFrames,
    describedKeysOf?: (expression: ts.Expression) => readonly string[] | null
  ): SourceOwnAssignment | null => {
    const bulk = bulkAssignOf(call)
    if (bulk === null) return null
    const closed = closedOwnAssignmentOf(call, bulk, frames)
    return closed !== undefined ? closed : describedOwnAssignmentOf(call, bulk, describedKeysOf)
  }
  /** `undefined` where no closed family describes the copy; `null` where a
   * specialized body copy cannot cite its own frames, which no description
   * repairs. */
  const closedOwnAssignmentOf = (
    call: ts.CallExpression,
    bulk: { readonly target: ts.Expression; readonly sources: readonly ts.Expression[] },
    frames?: SourceInvocationFrames
  ): SourceOwnAssignment | null | undefined => {
    if (frames !== undefined) {
      const callers = callerSitesOf(frames.body)
      if (
        ts.findAncestor(call, ts.isFunctionLike) !== frames.body ||
        callers === null ||
        frames.callers.length === 0 ||
        new Set(frames.callers).size !== frames.callers.length ||
        frames.callers.some((caller) => !callers.includes(caller))
      )
        return null
    }
    const frameValuesOf = (expression: ts.Expression): readonly Value[] | null => {
      if (frames === undefined) return admitted(value(expression))
      const values = new Set<Value>()
      for (const caller of frames.callers) {
        const held = admitted(frameQuery('frame-value', caller, frames.body, unwrapErasedExpression(expression)))
        if (held === null) return null
        for (const value of held) values.add(value)
      }
      return [...values]
    }
    const plainDataRoot = (held: Value): held is ts.ObjectLiteralExpression =>
      ts.isObjectLiteralExpression(held) &&
      literalSpelledKeys(held) !== null &&
      held.properties.every(
        (property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)
      )
    const targets = frameValuesOf(bulk.target)
    if (targets === null || targets.length === 0 || !targets.every(plainDataRoot)) return undefined
    for (const root of targets) if (admitted(closure(root)) === null) return undefined
    const sources: SourceOwnAssignment['sources'][number][] = []
    const copied = new Set<string>()
    for (const [index, expression] of bulk.sources.entries()) {
      const values = frameValuesOf(expression)
      if (values === null || values.length === 0) return undefined
      const roots: SourceOwnAssignment['sources'][number]['roots'][number][] = []
      for (const root of values) {
        if (isNullish(root)) continue
        if (!plainDataRoot(root)) return undefined
        const keys = admitted(nodeQuery('own-keys', root))
        if (keys === null || keys.some((key) => !ts.isStringLiteral(key))) return undefined
        const closure = admitted(nodeQuery('closure', root))
        if (closure === null) return undefined
        const descriptorChanged = closure.some((write) => ts.isCallExpression(write) && definitionPlans.has(write))
        const deleted = new Set<string>()
        for (const write of closure) {
          if (
            (!ts.isPropertyAccessExpression(write) && !ts.isElementAccessExpression(write)) ||
            writeEdgeByAccess.get(write)?.write.edge !== 'delete'
          )
            continue
          const key = accessKey(write)
          if (key !== null) deleted.add(key)
          else if (ts.isElementAccessExpression(write)) {
            const keys = admitted(value(write.argumentExpression))
            if (keys === null || keys.length === 0 || keys.some((key) => !ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)))
              return undefined
            for (const key of keys) if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) deleted.add(key.text)
          }
        }
        const slots: SourceOwnAssignment['sources'][number]['roots'][number]['slots'][number][] = []
        for (const name of keys) {
          if (!ts.isStringLiteral(name)) return undefined
          const values = admitted(storedSlot(root, name.text))
          if (values === null || values.length === 0) return undefined
          copied.add(name.text)
          // The finite key domain includes potential later additions. Only
          // an initial enumerable own data field whose descriptor is never
          // changed is an unavoidable contributor to every normal copy.
          slots.push({
            key: name.text,
            values,
            copyPresent: !descriptorChanged && !deleted.has(name.text) && literalSpelledKeys(root)!.includes(name.text)
          })
        }
        roots.push({ root, slots })
      }
      sources.push({ ordinal: index + 1, expression, nullable: values.some(isNullish), roots })
    }
    const targetSlots: SourceOwnAssignment['targetSlots'][number][] = []
    for (const root of targets) {
      const keys = admitted(nodeQuery('own-keys', root))
      if (keys === null) return undefined
      const slots: SourceOwnAssignment['targetSlots'][number]['slots'][number][] = []
      for (const key of keys) {
        if (!ts.isStringLiteral(key)) return undefined
        const values = admitted(storedSlot(root, key.text))
        if (values === null || values.length === 0) return undefined
        slots.push({ key: key.text, values })
      }
      targetSlots.push({ root, slots })
    }
    const missing = [...copied].filter((key) => targets.some((target) => !literalSpelledKeys(target)!.includes(key)))
    if (!prototypeLacksCopiedKeys(missing, call)) return undefined
    return { call, targets, targetSlots, sources }
  }
  return {
    candidateOrdinaryOwnCallableOperandsOf,
    ordinaryOwnCallableOperandsOf,
    ordinaryOwnCallableSourceOf: (call) => {
      const candidate = candidateOrdinaryOwnCallableOperandsOf(call)
      const site = sites.get(call)
      if (candidate === null && (!site || site.operands.explicitThis || ownCallableReadOf(site.operands.callee) === null)) return null
      const found = admitted(targets(call))
      return found !== null && found.length === 1 && isSourceCallableObject(found[0]!) ? found[0]! : null
    },
    ownsInvocation: (call) => {
      if (candidateOrdinaryOwnCallableOperandsOf(call) !== null) return true
      const site = sites.get(call)
      if (site && !site.operands.explicitThis && ownCallableReadOf(site.operands.callee) !== null) return true
      // Wrapper integrity and lexical-super lookup are separate dispatch
      // domains still owned by the existing invocation authority. Partition
      // before solving; failure within the ordinary-member domain is final.
      if (!site || site.explicitThis || site.operands.dispatch.kind !== 'member') return false
      const callee = site.operands.callee
      if (!callee || (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))) return false
      if (sourceIntrinsicMemberMayBeWrittenOf(checker, flow, callee)) return true
      const symbol = flow.targetOf(callee)?.nameSymbol ?? flow.targetOf(callee)?.symbol
      const declarations = symbol?.declarations
      if (!declarations?.length) return false
      // Ordinary source interface-member calls only (§5's cut-over row) --
      // the graph owns these with no fallback.
      if (
        declarations.some(
          (declaration) =>
            !declaration.getSourceFile().isDeclarationFile && (ts.isPropertySignature(declaration) || ts.isMethodSignature(declaration))
        )
      )
        return true
      // An OBJECT-LITERAL method has no nominal family: no `super`, no
      // override set to enumerate, no base constructor, no class receiver
      // forwarded through `new`. None of the four facts listed below applies
      // to it, and the graph already resolves a literal's slots joint with
      // the writes that replace them (source-value-session.test.ts). So the
      // graph owns these now; narrowing the whole `isSourceInstanceMethod`
      // widening back to the legacy resolver took literal-method-receiver
      // from 2/3 to 1/3 -- the legacy authority never counted
      // `registry.define( ... )` on a literal returned by a factory.
      if (declarations.every(isObjectLiteralCallableEntry)) return true
      // Ordinary CLASS methods stay with the legacy authority (§5's
      // "not migrated" row). Admitting them too, via
      // `declarations.every(isSourceInstanceMethod)`, was tried and measured
      // (SEMANTIC-AUTHORITY.md §7 item 5, "the partition, not landed"): it
      // broke 16 tests across 8 suites plus a new `computed-key-set` failure,
      // clustering on four still-unbuilt facts --
      //   - lexical `super` beside an ordinary override (invocation-dispatch)
      //   - computed member closure / override-family enumeration for an
      //     EXACT allocation rather than a whole nominal family
      //     (exact-class-allocation-origins, computed-key-set: `this[key] = v`)
      //   - base-constructor setter following (closed-callable-authority)
      //   - frame details: safe `arguments` reads, rest-array element
      //     continuations, TypeScript `this` positions, imported-function
      //     receiver evidence, and a receiver forwarded through a `new`
      //     constructor argument (member-call-forwarding,
      //     source-invocation-layout, array-element-continuation,
      //     class-origin-imports, arguments-frame-member-closure,
      //     mutable-method-parameters)
      //
      // Re-measured 2026-09-14 against a later tree (after
      // `sourceClassCallableMemberPlanOf` and the member-name-is-a-slot-read
      // fix, commit 83ad7008b and later, §7 item 5 "the missing fact,
      // built"): widening `ownsInvocation` to
      // `declarations.every(isSourceInstanceMethod)` now leaves SIX of the
      // nine files above green -- `invocation-dispatch`,
      // `exact-class-allocation-origins`, `member-call-forwarding`,
      // `source-invocation-layout`, `array-element-continuation` and
      // `class-origin-imports` all pass unmodified. THREE facts remain
      // unbuilt, each reproduced by exactly one still-failing suite:
      //   - `mutable-method-parameters.test.ts` (3/37 fail): once a class
      //     method's own member calls route through the graph, the legacy
      //     escape walk that `parameter-bindings.ts` still asks
      //     (`hasClosedMemberCallableUses`) cannot read the graph's answer
      //     for those calls and reports the receiver open, so a parameter
      //     bound only through sibling class-method calls loses its type.
      //   - `arguments-frame-member-closure.test.ts` (1/2 fail): a receiver
      //     forwarded through `arguments[ i ]` inside a recursive self-call
      //     (a `Node.add` multi-child form) is not a shape the
      //     graph's `targets`/`value` queries resolve yet, so the whole
      //     family closure opens with
      //     `function-escapes:uncounted-member-reference`. This is the
      //     single largest leaf-refusal shape measured on a large JS program
      //     (`measurements/leaf-refusals.log`): a receiver
      //     forwarded through a call argument is not followed -- see §7
      //     item 0's `uncounted-member-reference` breakdown.
      //   - `computed-key-set.test.ts` (1/10 fail, the reduced `setValues`
      //     case): the refusal reason regresses from the precise
      //     `origin-computed-write` to the earlier, coarser
      //     `object-origin-open-parameter` -- the graph trips a less
      //     specific refusal before it reaches the computed-write site.
      //   - `closed-callable-authority.test.ts` (1/20 fail, "a closed
      //     script realm includes writes and callers from every script"):
      //     the graph's caller closure for a class method shared by two
      //     files under one `ClosedScriptScope` does not yet match the
      //     legacy caller walk it is meant to replace.
      // Complete those, THEN widen this predicate, then delete the legacy
      // resolver -- in that order, and never by relaxing a test.
      return false
    },
    invocationTargetsOf,
    valuesOf: (expression) => admitted(value(expression)),
    closedValuesOf: (expression) => {
      const roots = admitted(value(expression))
      if (roots === null || roots.length === 0) return null
      for (const root of roots) if (admitted(closure(root)) === null) return null
      return roots
    },
    callerSitesOf,
    ownAssignmentOf,
    ownSlotOf,
    memberValuesOf: (expression, key) => {
      const roots = admitted(value(expression))
      if (roots === null || roots.length === 0 || roots.some((root) => !isObjectRoot(root))) return null
      const members = new Set<Value>()
      for (const root of roots) {
        if (!isObjectRoot(root)) return null
        const stored = admitted(slot(root, key))
        if (stored === null) return null
        for (const member of stored) members.add(member)
      }
      return [...members]
    },
    parameterValuesOf: (parameter) => admitted(nodeQuery('parameter', parameter)),
    parameterSourceExpressionsOf,
    explainParameter: (parameter) => solve(nodeQuery('parameter', parameter)).explain(),
    explainInvocation: (call) => solve(targets(call)).explain(),
    explainValue: (expression) => solve(value(expression)).explain()
  }
}
