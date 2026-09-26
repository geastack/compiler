import ts from 'typescript'
import {
  isGlobalObjectConstructor,
  isStandardInterfaceType,
  invocationOperandsOf,
  literalMemberNameOf
} from '../derived-expression-type.js'
import { typedArrayInstanceInterfaceNames } from '../../host-protocols.js'
import {
  heritageClassOrInterfaceOf,
  isConstructorFunction,
  type ExplicitThisCallFrame,
  type FlowInvocationOperands,
  type FlowCallSite,
  type FlowEdgeKind,
  type FlowSlotKind,
  type FlowTarget,
  type IterationOrigin,
  type ReceiverReference,
  type SourceClass,
  type ValueFlowIndex,
  type ValueWrite
} from './model.js'
import {
  calleeDeclarationOf,
  callableDeclarationOfExpression,
  flowTargetOf,
  isRealCallableDeclaration,
  runtimeParametersOf,
  isTypePositionReference,
  resolveFlowSymbolAlias,
  returnOwnerOf,
  unwrapNaming
} from './targets.js'
import { forEachReachableStatement, type ProgramReachability } from '../reachability.js'
import { isAssignmentPattern, isObjectLiteralPrototypeSetter } from '../assignment-patterns.js'

/**
 * ONE walk of the program, producing every write edge every census needs.
 *
 * See `model.ts` for why this exists. The rules of the house, in the order
 * they matter:
 *
 * 1. **Edges, never answers.** Checker identities supply the initial edges.
 *    Later rounds consume receiver types and call attributions from the
 *    preceding census. This index never runs its own inference: it adds the
 *    argument and collection edges those answers identify. The frontend's
 *    fixed point observes these queries and publishes the index together with
 *    the settling round, so consumers cannot mix one round's calls with
 *    another round's writes.
 * 2. **A census's answer may change only by seeing MORE writes.** Every edge
 *    a consumer already discovered for itself is reported here in exactly the
 *    spelling that consumer used, including which of the two property-symbol
 *    resolutions it keyed on (see `FlowTarget`), so a conversion is an
 *    edge-source swap and never a policy change.
 * 3. **Both directions.** A write is recorded against the cell it fills AND
 *    against the cell its VALUE names, so "where does this cell's value go"
 *    is one lookup rather than a second walk.
 *
 * What it deliberately does NOT do: decide whether an edge is EVIDENCE. A
 * compound assignment carries no fresh value; a spread carries an
 * unenumerable key set; an `Object.assign` source may or may not be readable.
 * Those are policy, and policy stays in the census that owns the cell --
 * `object-bag-bindings.ts` reads a spread as a refusal, and it is right to.
 */

const COLLECTION_KEY_METHODS: ReadonlySet<string> = new Set(['get', 'set', 'has', 'delete', 'add'])
const APPEND_METHODS: ReadonlySet<string> = new Set(['push', 'unshift'])

/**
 * The four standard keyed-collection interface names, resolved by declaration
 * identity (`isStandardInterfaceType`) rather than matched by the call's own
 * method spelling.
 *
 * `COLLECTION_KEY_METHODS`/`APPEND_METHODS`/`'fill'` used to gate on the
 * method name ALONE, against any receiver: a user class declaring its own
 * `get`/`set`/`has`/`delete`/`add` (a Command/Strategy/cache-shaped API is an
 * ordinary reason to) had its calls read as `collection-key`/`collection-value`
 * writes into a cell that was never a `Map`/`Set` at all -- admitting a value
 * into a cell the program never fills that way, which is the one failure mode
 * this whole index exists to avoid rather than merely approximate. See
 * `host-protocols.ts`'s `keyedCollectionDeclarationsOf`, the same four names
 * resolved the same way for the census that reads THEIR identity from the
 * checker directly rather than a Map this layer would have to keep in sync
 * with it.
 */
const KEYED_COLLECTION_INTERFACES: readonly string[] = ['Map', 'Set', 'WeakMap', 'WeakSet']

/**
 * Whether `type` -- after resolving a type parameter to its constraint, and
 * a subclass to the base type its own declaration states -- is one of
 * `names`.
 *
 * `isStandardInterfaceType` alone answers this correctly only for a
 * receiver whose OWN symbol is the standard interface's symbol, which is
 * exactly the case that is NOT one symbol per checker: `class Registry
 * extends Map<string, number> {}` has its own distinct `Registry` symbol,
 * and `<T extends Map<string, number>>(cache: T)` has its own distinct
 * per-declaration type-parameter symbol. Both are real writes to a real
 * `Map`, and answering "no" to either is not a false-positive removed --
 * it is a write silently dropped, which types the target cell more
 * narrowly than the program fills it. the value-flow survey calls that strictly
 * worse than the boxing this whole despecialization pass exists to remove.
 *
 * The cure is two checker calls this file already treats as fixed
 * properties of the program rather than of a census's evolving view:
 * `checker.getApparentType` resolves a type parameter to its constraint
 * (an object type's apparent type is itself, so this is free for the
 * ordinary case), and `checker.getBaseTypes` walks a class/interface's
 * declared `extends` clause -- transitively, since a subclass may itself be
 * subclassed. A union answers "no" unless EVERY constituent qualifies: a
 * `Map<string, number> | SomethingElse` receiver is not a single collection
 * kind this layer can state a write for, so it refuses by name (the
 * `COLLECTION_KEY_METHODS`/`APPEND_METHODS` gate above simply does not fire)
 * rather than picking one union arm and guessing.
 */
const matchesStandardInterfaceTransitively = (
  checker: ts.TypeChecker,
  anchor: ts.Node,
  names: readonly string[],
  type: ts.Type
): boolean => {
  const apparent = checker.getApparentType(type)
  if (apparent.isUnion()) {
    return (
      apparent.types.length > 0 && apparent.types.every((member) => matchesStandardInterfaceTransitively(checker, anchor, names, member))
    )
  }
  const visited = new Set<ts.Type>()
  const visit = (candidate: ts.Type): boolean => {
    if (visited.has(candidate)) return false
    visited.add(candidate)
    if (names.some((name) => isStandardInterfaceType(checker, anchor, name, candidate))) return true
    const declared = heritageClassOrInterfaceOf(candidate)
    return declared !== null && checker.getBaseTypes(declared).some(visit)
  }
  return visit(apparent)
}

/** Whether `receiver`'s type is, or derives from, one of the four standard keyed-collection interfaces -- see `matchesStandardInterfaceTransitively`. */
const isKeyedCollectionReceiver = (checker: ts.TypeChecker, receiver: ts.Expression, type: ts.Type): boolean =>
  matchesStandardInterfaceTransitively(checker, receiver, KEYED_COLLECTION_INTERFACES, type)

/**
 * Whether `receiver`'s type is a real JS array or tuple -- `checker.isArrayType`
 * (the same authority `structural-array-element.ts`/`field-bindings.ts`/
 * `collection-bindings.ts`/`object-bag-bindings.ts`/`structural.ts` already
 * use for the identical question) plus `checker.isTupleType`, since a tuple
 * (`[number, number]`) is not an array type by that authority's own answer
 * but is exactly as real a receiver for `.push`/`.unshift`/`.fill`. Both are
 * asked of the APPARENT type so `<T extends number[]>(xs: T)` resolves `T`
 * to its constraint first, for the same reason `matchesStandardInterfaceTransitively`
 * does.
 */
const isArrayReceiver = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  const apparent = checker.getApparentType(type)
  return checker.isArrayType(apparent) || checker.isTupleType(apparent)
}

/**
 * Whether `receiver`'s type is, or derives from, one of the nine standard
 * TypedArray instance interfaces -- `Int8Array`, ..., `Float64Array` --
 * asked with the same base-chain-aware `matchesStandardInterfaceTransitively`
 * used for the keyed collections above, against the SAME nine names
 * `host-protocols.ts:typedArrayDeclarationsOf` resolves for the census that
 * reads a typed array's element domain. That function itself needs an
 * `IdentityTable`, which does not exist yet when this index is built (see
 * `isStandardInterfaceType`'s own doc comment on why this file resolves
 * standard-library identity by raw `ts.Symbol` rather than `DeclarationId`);
 * `typedArrayInstanceInterfaceNames` is the same nine names exported so this
 * is a second CALLER of one list, not a second, independently-typed list.
 *
 * `.fill` is the only method this file asks of a typed array receiver: a
 * typed array's element write is precisely what the dense-buffer carrier
 * exists to state, and `push`/`unshift` do not type-check against one at
 * all (a typed array has no such methods), so `APPEND_METHODS` never needs
 * this check.
 */
const isTypedArrayReceiver = (checker: ts.TypeChecker, receiver: ts.Expression, type: ts.Type): boolean =>
  matchesStandardInterfaceTransitively(checker, receiver, typedArrayInstanceInterfaceNames, type)

const COMPOUND_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken
])

const LOGICAL_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

/** Whether this call is `Object.assign(...)` on the real global, resolved by DECLARATION IDENTITY (`isGlobalObjectConstructor`) rather than by the spelling `'ObjectConstructor'`. */
export const isGlobalObjectAssign = (checker: ts.TypeChecker, call: ts.CallExpression): boolean => {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'assign') return false
  if (!ts.isIdentifier(callee.expression)) return false
  return isGlobalObjectConstructor(checker, callee.expression, checker.getTypeAtLocation(callee.expression))
}

interface Mutable {
  readonly bySymbol: Map<ts.Symbol, ValueWrite[]>
  readonly byDeclaration: Map<ts.Node, ValueWrite[]>
  readonly fromSymbol: Map<ts.Symbol, ValueWrite[]>
  readonly fromDeclaration: Map<ts.Node, ValueWrite[]>
  readonly referencesBySymbol: Map<ts.Symbol, ts.Expression[]>
  readonly referencesByDeclaration: Map<ts.Node, ts.Expression[]>
  readonly allWrites: ValueWrite[]
  readonly edgeCounts: Map<FlowEdgeKind, number>
}

const push = <K, V>(table: Map<K, V[]>, key: K, value: V): void => {
  const existing = table.get(key)
  if (existing) existing.push(value)
  else table.set(key, [value])
}

/**
 * Index every write edge in the program.
 *
 * The initial index uses checker identities. Later rounds add receiver and
 * call facts supplied by the preceding census, retaining the original edges.
 * Call attribution and its argument edges must enter together: publishing a
 * callee without its inputs would hide mutations performed by that body.
 */
export const indexValueFlow = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  /**
   * The round's settled census view of an expression's type, for the ONE
   * question this index cannot answer from the checker alone: a receiver the
   * checker types `any`. Absent it (round one, and every caller that has no
   * census yet) this index is byte-identical to the one it replaced.
   *
   * It is what makes rule 1 above conditional rather than absolute: an `any`
   * receiver has no member symbols and no array/collection identity, so
   * `container.seq.push(x)` -- three's `WebGLUniforms.addUniform`, with
   * `container` unannotated -- names no cell and records no append, and the
   * `seq` it fills is refused `array:no-writes` while every element it holds
   * sits at that push. The checker's answer is used whenever it HAS one; the
   * census is consulted only where the checker said `any`, so no edge this
   * index already stated can change.
   */
  censusTypeOf?: (expression: ts.Expression) => ts.Type | null,
  /** Existing call-attribution census, not a new resolver in the flow index. */
  censusCallDeclarationOf?: (call: ts.CallExpression | ts.NewExpression) => ts.SignatureDeclaration | ts.JSDocSignature | null,
  censusCallTargetsOf?: (call: ts.CallExpression | ts.NewExpression) => readonly ts.SignatureDeclaration[] | null,
  /** A compiler option, not a type/closure result; retained identically in every round. */
  buildIsStrict = false,
  /** Existing `.call`/`.apply` census, not a new resolver in the flow index -- see `invocationOperandsOf`'s own doc. */
  censusExplicitThisAt?: (call: ts.CallExpression) => ExplicitThisCallFrame | null
): ValueFlowIndex => {
  const calls: FlowCallSite[] = []
  const propertyAccesses: (ts.PropertyAccessExpression | ts.ElementAccessExpression)[] = []
  const bindingPatternReads: ts.BindingElement[] = []
  const arrayLiterals: ts.ArrayLiteralExpression[] = []
  const accessorNames = new Set<string>()
  let hasComputedAccessorName = false
  const classDeclarations: SourceClass[] = []
  const receiverReferences = new Map<ts.Node, ReceiverReference[]>()
  const receiverOwners = new Map<ts.Node, ts.Node>()
  const indexedCallableBodies = new WeakSet<ts.Node>()
  const memberReferences = new Map<ts.Symbol, ts.MemberName[]>()
  const state: Mutable = {
    bySymbol: new Map(),
    byDeclaration: new Map(),
    fromSymbol: new Map(),
    fromDeclaration: new Map(),
    referencesBySymbol: new Map(),
    referencesByDeclaration: new Map(),
    allWrites: [],
    edgeCounts: new Map()
  }

  const effectiveType = (expression: ts.Expression): ts.Type => {
    const stated = checker.getTypeAtLocation(expression)
    if (!censusTypeOf || (stated.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return stated
    return censusTypeOf(expression) ?? stated
  }

  const invocationOperands = new Map<ts.CallExpression | ts.NewExpression, FlowInvocationOperands>()
  const invocationOperandsAt = (call: ts.CallExpression | ts.NewExpression): FlowInvocationOperands => {
    const known = invocationOperands.get(call)
    if (known) return known
    // TEMPORARY bisect switch, remove before landing. `GEA_NO_EXPLICIT_THIS_FLOW=1`
    // unthreads the `.call`/`.apply` explicit-this census from the flow index so
    // one build answers whether it is what un-authenticates borrowed builtins.
    const operands =
      process.env['GEA_NO_EXPLICIT_THIS_FLOW'] === '1'
        ? invocationOperandsOf(checker, call)
        : invocationOperandsOf(checker, call, censusExplicitThisAt)
    invocationOperands.set(call, operands)
    return operands
  }

  const targetMemo = new Map<ts.Expression, FlowTarget | null>()
  const targetOf = (expression: ts.Expression): FlowTarget | null => {
    const cached = targetMemo.get(expression)
    if (cached !== undefined) return cached
    const resolved = flowTargetOf(checker, expression)
    targetMemo.set(expression, resolved)
    return resolved
  }

  const record = (
    target: FlowTarget | null,
    edge: FlowEdgeKind,
    slot: FlowSlotKind,
    member: string | null,
    value: ts.Expression | null,
    site: ts.Node,
    naming: ts.Expression | null = null,
    iterationOrigin?: IterationOrigin,
    propertyAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression | null = null
  ): void => {
    // A computed receiver or an `any` property can have no checker symbol
    // and still name real heap storage. Keep its write in the shared inventory;
    // symbol-keyed consumers have no entry, while provenance follows `naming`.
    if (!target && !naming) return
    const cell = target ?? { symbol: null, nameSymbol: null, declaration: null }
    const write: ValueWrite = {
      edge,
      slot,
      member,
      value,
      site,
      target: cell,
      naming,
      propertyAccess,
      ...(iterationOrigin ? { iterationOrigin } : {})
    }
    state.allWrites.push(write)
    if (cell.symbol) push(state.bySymbol, cell.symbol, write)
    if (cell.declaration) push(state.byDeclaration, cell.declaration, write)
    state.edgeCounts.set(edge, (state.edgeCounts.get(edge) ?? 0) + 1)
    // The reverse direction, recorded from the same edge: whatever cell the
    // VALUE names has its contents flowing into `target`.
    if (!value) return
    const source = targetOf(value)
    if (!source) return
    if (source.symbol) push(state.fromSymbol, source.symbol, write)
    if (source.declaration) push(state.fromDeclaration, source.declaration, write)
  }

  /** A cell reached BY NAME: `o.p = v` fills `p`'s own cell whole, and fills a `member` slot of `o`'s. Both are recorded, because different censuses own the two questions. */
  const recordNamedWrite = (access: ts.PropertyAccessExpression, edge: FlowEdgeKind, value: ts.Expression | null, site: ts.Node): void => {
    record(targetOf(access), edge, 'whole', null, value, site, access, undefined, access)
    record(targetOf(access.expression), edge, 'member', access.name.text, value, site, access.expression, undefined, access)
  }

  /** `o[k] = v`. A LITERAL `k` is a named member spelled with brackets -- the same partition every reader in this compiler already draws with `literalMemberNameOf`. */
  const recordIndexedWrite = (access: ts.ElementAccessExpression, edge: FlowEdgeKind, value: ts.Expression | null, site: ts.Node): void => {
    const name = literalMemberNameOf(access)
    if (name !== null) {
      record(targetOf(access), edge, 'whole', null, value, site, access, undefined, access)
      record(targetOf(access.expression), edge, 'member', name, value, site, access.expression, undefined, access)
      return
    }
    record(targetOf(access.expression), edge, 'element', null, value, site, access.expression, undefined, access)
  }

  /** The write target of an assignment-like form, in whichever of the three naming shapes it takes. */
  const recordAssignmentTarget = (
    left: ts.Expression,
    edge: FlowEdgeKind,
    value: ts.Expression | null,
    site: ts.Node,
    iterationOrigin?: IterationOrigin
  ): void => {
    const target = unwrapNaming(left)
    if (ts.isPropertyAccessExpression(target)) recordNamedWrite(target, edge, value, site)
    else if (ts.isElementAccessExpression(target)) recordIndexedWrite(target, edge, value, site)
    else record(targetOf(target), edge, 'whole', null, value, site, target, iterationOrigin)
  }

  /**
   * A binding pattern's elements, each of which is a cell the pattern fills.
   * The pattern's SOURCE is the write's value where the element names one
   * member of it; where it does not (an array pattern, a rest element), the
   * element states only that the cell exists, which is what a `null` value
   * means everywhere in this index.
   */
  const recordBindingPattern = (pattern: ts.BindingPattern, source: ts.Expression | null): void => {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue
      bindingPatternReads.push(element)
      const cell = ts.isIdentifier(element.name) ? targetOf(element.name) : null
      const naming = ts.isIdentifier(element.name) ? element.name : null
      record(cell, 'destructuring', 'whole', null, null, element, naming)
      if (element.initializer) record(cell, 'destructuring-default', 'whole', null, element.initializer, element, naming)
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) recordBindingPattern(element.name, null)
      // The pattern READS a slot of its source, which is the reverse-direction
      // fact a consumer asking "where does this cell's value go" needs.
      if (source && ts.isObjectBindingPattern(pattern) && !element.dotDotDotToken) {
        const key = element.propertyName ?? element.name
        if (ts.isIdentifier(key)) record(targetOf(source), 'destructuring', 'member', key.text, null, element, source)
      }
    }
  }

  /** `({ p: o.q } = v)` / `[o.q] = v` -- a destructuring ASSIGNMENT, whose targets are ordinary naming expressions rather than binding elements. */
  const recordAssignmentPattern = (pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): void => {
    if (ts.isArrayLiteralExpression(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue
        const inner = ts.isSpreadElement(element) ? element.expression : element
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const defaultedTarget = unwrapNaming(inner.left)
          // A nested pattern (`[a, [b]] = [1, [2]]`) names no single cell
          // itself -- `recordAssignmentTarget` on it would resolve to no
          // target and record nothing -- so its OWN elements are this same
          // walk one level deeper, the assignment twin of `recordBindingPattern`'s
          // identical recursion for a nested BINDING pattern above.
          if (ts.isObjectLiteralExpression(defaultedTarget) || ts.isArrayLiteralExpression(defaultedTarget)) {
            recordAssignmentPattern(defaultedTarget)
          } else {
            recordAssignmentTarget(inner.left, 'destructuring', null, inner)
          }
          recordAssignmentTarget(inner.left, 'destructuring-default', inner.right, inner)
          continue
        }
        const target = unwrapNaming(inner)
        if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
          recordAssignmentPattern(target)
          continue
        }
        recordAssignmentTarget(inner, 'destructuring', null, element)
      }
      return
    }
    for (const property of pattern.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        record(targetOf(property.name), 'destructuring', 'whole', null, null, property, property.name)
        if (property.objectAssignmentInitializer) {
          record(
            targetOf(property.name),
            'destructuring-default',
            'whole',
            null,
            property.objectAssignmentInitializer,
            property,
            property.name
          )
        }
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const value = property.initializer
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        recordAssignmentTarget(value.left, 'destructuring', null, value)
        recordAssignmentTarget(value.left, 'destructuring-default', value.right, value)
        continue
      }
      recordAssignmentTarget(value, 'destructuring', null, property)
    }
  }

  /** Every argument of a call reaching the parameter slot it lands in -- positionally, and never through a rest slot or a spread, neither of which is one slot. */
  const recordCallArguments = (call: ts.CallExpression | ts.NewExpression, edge: FlowEdgeKind): void => {
    const original = calleeDeclarationOf(checker, call)
    const inferred = censusCallDeclarationOf?.(call)
    const operands = invocationOperandsAt(call)
    const explicitTarget = operands.explicitThis ? callableDeclarationOfExpression(checker, operands.callee) : null
    for (const callee of new Set([original, explicitTarget, inferred, ...(censusCallTargetsOf?.(call) ?? [])])) {
      if (!callee || !isRealCallableDeclaration(callee) || callee.getSourceFile().isDeclarationFile) continue
      const args = callee === original && callee !== explicitTarget ? call.arguments : operands.args
      if (!args || args.length === 0) continue
      // Everything from the rest slot onward lands in the SAME parameter, and
      // `parameters[position]` runs out at the first one past it.
      const parameters = runtimeParametersOf(callee)
      const last = parameters[parameters.length - 1]
      const rest = last && ts.isParameter(last) && last.dotDotDotToken ? last : undefined
      args.forEach((argument, position) => {
        if (ts.isSpreadElement(argument)) return
        const parameter = parameters[position] ?? rest
        // `ts.isFunctionLike` admits a `JSDocSignature`, whose "parameters" are
        // JSDoc TAGS rather than real `ParameterDeclaration`s and carry no
        // `name` at all -- a shape `ts.isIdentifier` crashes on rather than
        // rejecting. A slot with no name is no slot.
        if (!parameter || !ts.isParameter(parameter) || !ts.isIdentifier(parameter.name)) return
        if (parameter.dotDotDotToken) record(targetOf(parameter.name), 'rest-argument', 'element', null, argument, argument, parameter.name)
        else record(targetOf(parameter.name), edge, 'whole', null, argument, argument, parameter.name)
      })
    }
  }

  const visitCall = (node: ts.CallExpression): void => {
    recordCallArguments(node, node.expression.kind === ts.SyntaxKind.SuperKeyword ? 'super-argument' : 'call-argument')
    if (isGlobalObjectAssign(checker, node) && node.arguments.length >= 2) {
      const [target, ...sources] = node.arguments
      // The key set a merge moves is the SOURCE's, and reading it is the
      // consuming census's own policy (`object-bag-bindings.ts` reads three
      // shapes in order and refuses the rest). This layer states only that a
      // bulk write happened and what it came from.
      if (target) for (const source of sources) record(targetOf(target), 'object-assign', 'bulk', null, source, node, target)
    }
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return
    const method = callee.name.text
    const receiver = callee.expression
    if (APPEND_METHODS.has(method)) {
      if (isArrayReceiver(checker, effectiveType(receiver))) {
        for (const argument of node.arguments) {
          if (ts.isSpreadElement(argument)) continue
          record(targetOf(receiver), 'array-append', 'element', null, argument, node, receiver)
        }
      }
      return
    }
    if (method === 'fill') {
      if (isArrayReceiver(checker, effectiveType(receiver)) || isTypedArrayReceiver(checker, receiver, effectiveType(receiver))) {
        const value = node.arguments[0]
        if (value && !ts.isSpreadElement(value)) record(targetOf(receiver), 'array-fill', 'element', null, value, node, receiver)
      }
      return
    }
    if (!COLLECTION_KEY_METHODS.has(method) || !isKeyedCollectionReceiver(checker, receiver, effectiveType(receiver))) return
    const key = node.arguments[0]
    if (key && !ts.isSpreadElement(key)) record(targetOf(receiver), 'collection-key', 'collection-key', null, key, node, receiver)
    if (method !== 'set') return
    const value = node.arguments[1]
    if (value && !ts.isSpreadElement(value)) record(targetOf(receiver), 'collection-value', 'collection-value', null, value, node, receiver)
  }

  /**
   * Every expression that NAMES a cell, in whatever position it stands.
   *
   * Recorded under all three of a `FlowTarget`'s keys deliberately: a
   * consumer's question here is negative ("is there a mention I cannot
   * explain?"), so a mention filed under one key too many can only make it
   * refuse. Filing one under too FEW is what makes an escape analysis
   * silently claim closure it has not proved -- and the two
   * property-symbol resolutions disagree on 1339 of the three.js app's 22556
   * property accesses, so picking one would do exactly that.
   */
  const recordReference = (expression: ts.Expression): void => {
    const target = targetOf(expression)
    if (!target) return
    const parent = expression.parent
    const aliasDeclaration =
      ts.isNamespaceImport(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent)
    if (
      aliasDeclaration ||
      (((target.symbol?.flags ?? 0) | (target.nameSymbol?.flags ?? 0)) & (ts.SymbolFlags.Alias | ts.SymbolFlags.Module)) === 0
    ) {
      if (target.symbol) push(state.referencesBySymbol, target.symbol, expression)
      if (target.nameSymbol && target.nameSymbol !== target.symbol) push(state.referencesBySymbol, target.nameSymbol, expression)
      if (target.declaration) push(state.referencesByDeclaration, target.declaration, expression)
      return
    }
    const symbols = new Set<ts.Symbol>()
    const declarations = new Set<ts.Node>()
    if (target.declaration) declarations.add(target.declaration)
    const addSymbol = (symbol: ts.Symbol | null | undefined): void => {
      if (!symbol || symbols.has(symbol)) return
      symbols.add(symbol)
      const canonical = resolveFlowSymbolAlias(checker, symbol)
      if (!canonical) return
      symbols.add(canonical)
      const declaration = canonical.valueDeclaration ?? canonical.declarations?.[0]
      if (declaration) declarations.add(declaration)
    }
    addSymbol(target.symbol)
    addSymbol(target.nameSymbol)

    // Keep the import's local cell identity, but also record uses under the
    // declaration it denotes. Otherwise an opaque consumer of an imported
    // constructor disappears from that constructor's escape inventory.
    // A whole namespace publication exposes its exported values as well;
    // selected members have their own references in this same walk.
    const selectedMember =
      (ts.isPropertyAccessExpression(parent) && parent.expression === expression) ||
      (ts.isElementAccessExpression(parent) && parent.expression === expression && ts.isStringLiteralLike(parent.argumentExpression))
    if (!selectedMember && !isTypePositionReference(expression)) {
      const visited = new Set<ts.Symbol>()
      const exposeNamespace = (symbol: ts.Symbol): void => {
        const canonical = resolveFlowSymbolAlias(checker, symbol)
        if (!canonical || visited.has(canonical)) return
        visited.add(canonical)
        if ((canonical.flags & ts.SymbolFlags.Module) === 0 || (canonical.flags & ts.SymbolFlags.Class) !== 0) return
        // Export identities and runtime property visibility answer different
        // questions. The synthetic global namespace exports lexical bindings
        // which globalThis cannot read. Conversely, a JS expando variable has
        // a module flag but its instance type also includes inherited methods;
        // those are receiver uses, not references to exported bindings.
        const runtimeKeys = new Set(
          checker
            .getTypeOfSymbolAtLocation(canonical, expression)
            .getProperties()
            .map((value) => value.name)
        )
        for (const exported of checker.getExportsOfModule(canonical)) {
          if (!runtimeKeys.has(exported.name)) continue
          const value = resolveFlowSymbolAlias(checker, exported)
          if (!value || (value.flags & ts.SymbolFlags.Value) === 0) continue
          addSymbol(value)
          exposeNamespace(value)
        }
      }
      for (const symbol of [...symbols]) exposeNamespace(symbol)
    }
    for (const symbol of symbols) push(state.referencesBySymbol, symbol, expression)
    for (const declaration of declarations) push(state.referencesByDeclaration, declaration, expression)
  }

  const visit = (node: ts.Node): void => {
    // Use the same member boundary as normalization: excluded bodies cannot
    // contribute callers or writes to the live program's typing evidence.
    if (reachable.memberIsPruned(node)) return
    if (ts.isFunctionLike(node) && 'body' in node && node.body) indexedCallableBodies.add(node)
    // A pre-ES6 `function F() { this.x = ... }` is a class -- TypeScript types
    // it as one -- and this enumeration is what every family walk means by
    // "the source classes". Widening the type without widening this made the
    // whole change inert: a constructor-function root reached
    // `owned-class-receivers.ts`'s family test, was not in this list, and was
    // refused as `root-outside-family` exactly as before.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || isConstructorFunction(node)) classDeclarations.push(node)
    if (ts.isArrayLiteralExpression(node) && !isAssignmentPattern(node)) arrayLiterals.push(node)
    if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const name = node.name
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) accessorNames.add(name.text)
      else hasComputedAccessorName = true
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      // `super` changes property lookup, not the receiver. Arrows inherit both
      // references from their enclosing frame; ordinary callables, class field
      // initializers and static blocks each introduce their own. Keep the two
      // spellings in one walk so closure consumers cannot miss a receiver edge
      // hidden behind lexical-super dispatch.
      let branch: ts.Node = node
      for (let owner = node.parent; owner; branch = owner, owner = owner.parent) {
        // A computed class/object member name evaluates in the enclosing
        // frame, before that member's own receiver exists.
        if (
          (ts.isMethodDeclaration(owner) ||
            ts.isGetAccessorDeclaration(owner) ||
            ts.isSetAccessorDeclaration(owner) ||
            ts.isPropertyDeclaration(owner)) &&
          owner.name === branch
        )
          continue
        if (
          (ts.isFunctionLike(owner) && !ts.isArrowFunction(owner)) ||
          ts.isPropertyDeclaration(owner) ||
          ts.isClassStaticBlockDeclaration(owner)
        ) {
          push(receiverReferences, owner, node as ReceiverReference)
          receiverOwners.set(node, owner)
          break
        }
        if (ts.isSourceFile(owner)) break
      }
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      if (symbol) push(memberReferences, symbol, node)
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const operands = invocationOperandsAt(node)
      const explicitThis = operands.explicitThis ? { callee: operands.callee, receiver: operands.receiver, args: operands.args } : null
      const inferredDeclaration = censusCallDeclarationOf?.(node)
      const explicitTarget = explicitThis ? callableDeclarationOfExpression(checker, explicitThis.callee) : null
      calls.push({
        call: node,
        targets: [...new Set([...(explicitTarget ? [explicitTarget] : []), ...(censusCallTargetsOf?.(node) ?? [])])],
        explicitThis,
        operands,
        ...(inferredDeclaration ? { inferredDeclaration } : {}),
        checkerDeclaration: explicitThis ? null : (checker.getResolvedSignature(node)?.declaration ?? null)
      })
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !isTypePositionReference(node))
      propertyAccesses.push(node)
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) recordReference(node)
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.initializer) record(targetOf(node.name), 'declaration-initializer', 'whole', null, node.initializer, node, node.name)
      } else recordBindingPattern(node.name, node.initializer ?? null)
    } else if (ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.initializer) record(targetOf(node.name), 'default-parameter', 'whole', null, node.initializer, node, node.name)
      } else recordBindingPattern(node.name, null)
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      record(
        targetOf(node.name as ts.Expression),
        'class-field-initializer',
        'whole',
        null,
        node.initializer,
        node,
        node.name as ts.Expression
      )
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && !isAssignmentPattern(node.parent)) {
      const name = node.name
      const named = ts.isComputedPropertyName(name) ? name.expression : name
      if (ts.isPropertyAssignment(node) && isObjectLiteralPrototypeSetter(node)) {
        // This is an observable prototype publication with no ordinary field
        // target. Closure consumers must account for that edge or refuse it.
        record(null, 'prototype-assignment', 'bulk', null, node.initializer, node, node.parent)
      } else if (
        (ts.isIdentifier(named) && !ts.isComputedPropertyName(name)) ||
        ts.isStringLiteralLike(named) ||
        ts.isNumericLiteral(named)
      ) {
        const key = named.text
        const value = ts.isPropertyAssignment(node) ? node.initializer : node.name
        // A shorthand's name resolves to its VALUE variable through targetOf;
        // the receiving property has the object type's distinct symbol.
        const property = checker.getTypeAtLocation(node.parent).getProperty(key) ?? null
        const target: FlowTarget = { symbol: property, nameSymbol: property, declaration: property?.declarations?.[0] ?? node }
        record(target, 'property-assignment', 'whole', null, value, node, name as ts.Expression)
        const container = node.parent.parent
        const naming =
          ts.isVariableDeclaration(container) && container.initializer === node.parent && ts.isIdentifier(container.name)
            ? container.name
            : ts.isBinaryExpression(container) &&
                container.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                container.right === node.parent
              ? container.left
              : null
        if (naming) record(targetOf(naming), 'property-assignment', 'member', key, value, node, naming)
      }
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.EqualsToken) {
        const left = unwrapNaming(node.left)
        if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) recordAssignmentPattern(left)
        else if (ts.isPropertyAccessExpression(left)) recordNamedWrite(left, 'property-assignment', node.right, node)
        else if (ts.isElementAccessExpression(left)) recordIndexedWrite(left, 'index-assignment', node.right, node)
        else record(targetOf(left), 'identifier-assignment', 'whole', null, node.right, node, left)
      } else if (LOGICAL_TOKENS.has(operator)) {
        recordAssignmentTarget(node.left, 'logical-assignment', node.right, node)
      } else if (COMPOUND_TOKENS.has(operator)) {
        recordAssignmentTarget(node.left, 'compound-assignment', null, node)
      }
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        recordAssignmentTarget(node.operand, 'compound-assignment', null, node)
      }
    } else if (ts.isCallExpression(node)) visitCall(node)
    else if (ts.isNewExpression(node)) recordCallArguments(node, 'call-argument')
    else if (ts.isReturnStatement(node)) {
      const owner = returnOwnerOf(node)
      if (owner) record({ symbol: null, nameSymbol: null, declaration: owner }, 'return', 'whole', null, node.expression ?? null, node)
    } else if (ts.isYieldExpression(node) && node.expression) {
      for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (!ts.isFunctionLike(current)) continue
        record({ symbol: null, nameSymbol: null, declaration: current }, 'yield', 'whole', null, node.expression, node)
        break
      }
    } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      record(targetOf(node.expression), 'spread', 'bulk', null, null, node, node.expression)
    } else if (ts.isDeleteExpression(node)) {
      const target = unwrapNaming(node.expression)
      if (ts.isPropertyAccessExpression(target)) recordNamedWrite(target, 'delete', null, node)
      else if (ts.isElementAccessExpression(target)) recordIndexedWrite(target, 'delete', null, node)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      const name = node.variableDeclaration.name
      if (ts.isIdentifier(name)) record(targetOf(name), 'catch-binding', 'whole', null, null, node, name)
      else recordBindingPattern(name, null)
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const iterationOrigin: IterationOrigin = {
        source: node.expression,
        mode: ts.isForInStatement(node) ? 'keys' : 'values',
        asynchronous: ts.isForOfStatement(node) && node.awaitModifier !== undefined
      }
      const initializer = node.initializer
      if (ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) {
          if (ts.isIdentifier(declaration.name))
            record(targetOf(declaration.name), 'iteration-binding', 'whole', null, null, declaration, declaration.name, iterationOrigin)
          else recordBindingPattern(declaration.name, null)
        }
      } else if (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer)) {
        // `for ([a, b] of pairs)` / `for ({ x, y } of points)` -- an array/
        // object LITERAL used directly as the loop's own head is a
        // destructuring ASSIGNMENT the same way `[a, b] = pairs` is; the only
        // difference is the value each iteration writes, which has no
        // right-hand-side expression at all (see `local-bindings.ts`'s
        // `forOfPatternElementTypeAt`, the consumer that derives it from the
        // loop's own iterable/key instead of a literal source).
        // `recordAssignmentPattern` already walks nested patterns and
        // per-element defaults identically to the `=` case -- it never looks
        // at what SYNTAX supplied the pattern's value, only at the pattern
        // itself, so this needs no shape of its own.
        recordAssignmentPattern(initializer)
      } else if (ts.isIdentifier(initializer)) {
        recordAssignmentTarget(initializer, 'iteration-binding', null, node, iterationOrigin)
      } else recordAssignmentTarget(initializer, 'iteration-binding', null, node)
    }
    ts.forEachChild(node, visit)
  }

  for (const file of files) forEachReachableStatement(reachable, file, visit)

  const NO_WRITES: readonly ValueWrite[] = []
  const NO_REFERENCES: readonly ts.Expression[] = []
  const callSites = new Map(calls.map((site) => [site.call, site]))
  const writesBySite = new Map<ts.Node, ValueWrite[]>()
  for (const write of state.allWrites) {
    let entries = writesBySite.get(write.site)
    if (!entries) writesBySite.set(write.site, (entries = []))
    entries.push(write)
  }
  return {
    buildIsStrict,
    calls,
    callSiteOf: (call) => callSites.get(call),
    writesAtSite: (site) => writesBySite.get(site) ?? NO_WRITES,
    propertyAccesses,
    bindingPatternReads,
    classDeclarations,
    arrayLiterals,
    accessorNames,
    hasComputedAccessorName,
    receiverReferencesToDeclaration: (declaration) => receiverReferences.get(declaration) ?? [],
    receiverOwnerOf: (reference) => receiverOwners.get(reference) ?? null,
    callableBodyIsIndexed: (declaration) => indexedCallableBodies.has(declaration),
    memberReferencesToSymbol: (symbol) => memberReferences.get(symbol) ?? [],
    targetOf,
    writesToSymbol: (symbol) => state.bySymbol.get(symbol) ?? NO_WRITES,
    writesToDeclaration: (declaration) => state.byDeclaration.get(declaration) ?? NO_WRITES,
    flowsFromSymbol: (symbol) => state.fromSymbol.get(symbol) ?? NO_WRITES,
    flowsFromDeclaration: (declaration) => state.fromDeclaration.get(declaration) ?? NO_WRITES,
    referencesToSymbol: (symbol) => state.referencesBySymbol.get(symbol) ?? NO_REFERENCES,
    referencesToDeclaration: (declaration) => state.referencesByDeclaration.get(declaration) ?? NO_REFERENCES,
    allWrites: state.allWrites,
    edgeCounts: state.edgeCounts,
    writeCount: [...state.edgeCounts.values()].reduce((total, count) => total + count, 0)
  }
}
