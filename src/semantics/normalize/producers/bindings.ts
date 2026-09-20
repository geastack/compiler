import { enclosingArgumentsFunction, implicitArgumentsSlotOf, isBodiedSignatureDeclaration } from '../implicit-arguments.js'
export { argumentsObjectPhantomOrdinalAt, isArgumentsObjectIdentifier } from '../implicit-arguments.js'
import ts from 'typescript'
import {
  operationId,
  regionId,
  semanticResultId,
  type NodeId,
  type SemanticResultId,
  type StructuralTypeId
} from '../../../identity/ids.js'
import { normalCompletion, pureEffects, type SemanticCaller, type SemanticOperand } from '../../model/operands.js'
import type { SemanticEdge } from '../../model/edges.js'
import type {
  AllocationOperation,
  BindingOperation,
  DestructuringOperation,
  ReferenceOperation,
  SemanticOperation
} from '../../model/operations.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import type { CensusCandidate } from '../census.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import type { ProducerContext } from '../producer-context.js'
import type { IdentityTable } from '../identities.js'
import type { StructuralTypeTable } from '../../model/structural-type-table.js'
import { bindingKindOf, bindingKindOfElement } from './binding-kind.js'
import { boundElementType, citeBoundElementValue } from './destructuring.js'
import { citeExpressionResult } from './references.js'
import { resultEdge } from './shared.js'

/**
 * The binding a destructuring element introduces.
 *
 * Extraction and introduction are two operations, not one: the destructuring
 * family answers "which value does this position yield", and this family
 * answers "which name now holds it, with what mutability and dead zone". Fusing
 * them would put one question under two authorities, and the two answers would
 * eventually disagree.
 *
 * An element whose own name is a nested pattern binds nothing here -- the
 * nested pattern's elements are the declarations, and each is its own candidate
 * -- so this contributes an empty, fully covered publication rather than a
 * blocker: nothing is missing, there is simply nothing at this coordinate.
 */
const contributeBindingElement = (candidate: CensusCandidate, node: ts.BindingElement, context: ProducerContext): CandidateContribution => {
  if (!ts.isIdentifier(node.name)) return { kind: 'operations', operations: [], edges: [] }

  const { mutable, temporalDeadZone } = bindingKindOfElement(node)

  const extracted = citeBoundElementValue(node, context.identities)
  const type = boundElementType(node, context)
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const declaration = context.identities.declarationIdOf(node)
  const operation: BindingOperation = {
    id,
    family: 'binding',
    action: 'initialize',
    declaration,
    mutable,
    temporalDeadZone,
    ...(context.commonJsBindings.has(declaration)
      ? {
          commonJs: {
            global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
            owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body')
          }
        }
      : {}),
    ...(isParameterBindingElement(node) ? { parameterInitialization: true } : {}),
    caller: candidate.caller,
    operands: [operand('initializer', 0, extracted, type)],
    results: [mintResult(id, 'value', type)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const edges: SemanticEdge[] =
    extracted.kind === 'result' ? [{ kind: 'value', result: extracted.result, to: id, role: 'initializer', ordinal: 0 }] : []
  return { kind: 'operations', operations: [operation], edges }
}

/** Whether a nested binding element ultimately belongs to a formal parameter pattern. */
const isParameterBindingElement = (node: ts.BindingElement): boolean => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isParameter(current)) return true
    if (ts.isVariableDeclaration(current)) return false
    if (!ts.isBindingElement(current) && !ts.isArrayBindingPattern(current) && !ts.isObjectBindingPattern(current)) return false
  }
  return false
}

/**
 * The identity a defaulted parameter's raw argument value publishes under.
 *
 * A default initializer runs only when the caller's own value is exactly
 * `undefined`, which is a presence test over the raw, pre-default argument --
 * not over the named binding a program reads afterward, which by then always
 * excludes `undefined` (ECMA-262 9.2.10). Something has to be citable *as*
 * that raw value for a guard to test it, and `semantics/normalize/gating.ts`
 * has to name the exact same result `contributeDefaultedParameter` mints,
 * independently and in advance -- the same way every other cross-producer
 * citation in this compiler agrees on an identity rather than looking one up.
 */
export const parameterValueResultOf = (node: ts.ParameterDeclaration, identities: IdentityTable) =>
  semanticResultId(operationId(identities.nodeIdOf(node), 'reference', 0), 'value')

/**
 * The identity a formal parameter's own binding publishes its value under.
 *
 * The value AFTER `FunctionDeclarationInstantiation` has run -- so the default
 * applied where there is one, and the raw argument where there is not. Both
 * shapes below mint that binding as the first `binding`-family operation at
 * the parameter's node, which is what makes one rule serve both.
 *
 * Cited by `producers/class-lifecycle.ts`, which needs it for the store half
 * of a parameter property: `constructor(readonly name: T)` assigns the value
 * the parameter is BOUND to, not the raw slot -- `constructor(readonly n = 5)`
 * stores 5 when the caller passed nothing.
 */
export const parameterBindingResultOf = (node: ts.ParameterDeclaration, identities: IdentityTable): SemanticResultId =>
  semanticResultId(operationId(identities.nodeIdOf(node), 'binding', 0), 'value')

/**
 * The physical position a formal parameter occupies in its callable's frame.
 *
 * A `this` parameter is a type annotation with no argument slot behind it, so
 * it is not counted; every parameter after one would otherwise be off by one
 * against the ABI the signature shape describes.
 */
const abiOrdinalOf = (node: ts.ParameterDeclaration): number => {
  const parameters = (node.parent as ts.SignatureDeclarationBase).parameters
  const physical = parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
  return physical.indexOf(node)
}

/** What one `arguments` reference site resolves to, and the auxiliary operations that publish it. */
export interface ArgumentsObjectValue {
  /** Minted against the reference site's own node identity; merge into the citing candidate's own operation list. */
  readonly operations: readonly SemanticOperation[]
  readonly edges: readonly SemanticEdge[]
  /** The `'value'`-role result the `arguments` read itself should cite. */
  readonly value: SemanticResultId
  /** The array type physically carried by that result. */
  readonly type: StructuralTypeId
}

/**
 * The full logical `arguments` value at one reference site.
 *
 * `arguments[i]` is unmapped in every ES module (ES modules are always strict
 * mode, and strict-mode `arguments` never aliases a named parameter's later
 * reassignment -- ECMA-262 `MakeArgGetter`/`MakeArgSetter` bindings are
 * SLOPPY-mode only), so every position reads the RAW value the caller passed,
 * not whatever the named binding holds now. That raw value is available
 * directly from the frame at `{kind:'parameter', ordinal}` for every
 * position, the same source `contributeParameter`'s own binding reads.
 *
 * A `restFrom` REST PARAMETER (real or, through `implicitArgumentsSlotOf`, the checker's own phantom) is a DIFFERENT ECMAScript
 * concept: it packs only the TAIL of the argument list, from its own ordinal
 * onward, into a fresh array. `arguments`, by contrast, is EVERY argument, so
 * where the phantom sits at ordinal `P > 0`, `arguments` is P declared
 * parameters concatenated with that tail -- built as a range copy through the
 * same array-literal-with-spread shape `allocations.ts`'s own producer
 * builds for `[a, b, ...c]` (see `spread-arguments.ts`'s module comment: "the
 * same `appendRange`... an array literal's own admitted spread emits"), never
 * an alias of either source.
 *
 * `P === 0` (every forwarding shim this compiler has seen: `function
 * texImage2D(){ gl.texImage2D(...arguments) }`) degenerates to exactly the
 * phantom's own rest array -- no concatenation needed, so none is built.
 *
 * Every occurrence mints its own copy of these operations, the same way
 * `buildThisReference` (`references.ts`) mints one operation per `this`
 * keyword rather than sharing one across the function: cheap, and correct
 * only because `arguments` is exclusively READ by every body this compiler
 * normalizes -- an unmapped `arguments[i] = x` write would observably diverge
 * from a second, independently-read copy, and is not admitted here.
 *
 * Returns `null` when `node` is not inside a function with this recognized
 * phantom shape at all -- callers should treat that exactly as "this is not
 * the magic `arguments` binding this compiler can bind," the same fail-closed
 * answer `citeExpressionResult` gives any other unmodelled expression.
 */
export const argumentsObjectValueAt = (
  node: ts.Node,
  mintAgainst: NodeId,
  caller: SemanticCaller,
  evaluationOrdinal: number,
  context: ProducerContext
): ArgumentsObjectValue | null => {
  const fn = enclosingArgumentsFunction(node)
  if (!fn) return null
  const signature = context.checker.getSignatureFromDeclaration(fn)
  const phantom = signature ? implicitArgumentsSlotOf(signature) : null
  if (!phantom) return null

  // Read the same slot as the callable ABI. The signature mapper owns the
  // census-to-structural translation, including the checker fallback when
  // complete argument evidence is unavailable.
  if (!signature) return null
  const frame = context.table.get(context.types.resolvedSignatureTypeOf(signature, 'call')).shape
  const restType = frame.kind === 'signature' ? frame.call[0]?.parameters[phantom.ordinal]?.type : undefined
  if (restType === undefined) return null
  const restId = mintOperationId(context.ordinals, mintAgainst, 'reference')
  const restResult = mintResult(restId, 'value', restType)
  // Same shape `contributeDefaultedParameter`'s raw-argument citation mints
  // above, and for the identical reason: `projection/abi.ts`'s
  // `parameterCarrierKeys` already recognizes `reference`/`parameter-value`
  // as evidence ordinal `phantom.ordinal` is physically bound, so this needs
  // no change there to satisfy the ABI projection's own arity check.
  const restOperation: ReferenceOperation = {
    id: restId,
    family: 'reference',
    form: 'parameter-value',
    strict: true,
    unresolvableThrows: false,
    hasNoCell: false,
    caller,
    operands: [operand('argument', 0, { kind: 'parameter', ordinal: phantom.ordinal }, restType, { kind: 'provenance' })],
    results: [restResult],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal
  }

  if (phantom.ordinal === 0) return { operations: [restOperation], edges: [], value: restResult.id, type: restType }

  const operands: SemanticOperand[] = []
  for (let i = 0; i < phantom.ordinal; i++) {
    const declared = fn.parameters[i]
    const elementType = declared ? context.types.typeAt(declared) : restType
    operands.push(operand('element', i, { kind: 'parameter', ordinal: i }, elementType))
  }
  operands.push(operand('spread', phantom.ordinal, { kind: 'result', result: restResult.id }, restType))

  const arrayId = mintOperationId(context.ordinals, mintAgainst, 'allocation')
  const arrayOperation: AllocationOperation = {
    id: arrayId,
    family: 'allocation',
    caller,
    allocated: 'array-literal',
    callable: null,
    // The census element covers the complete argument list, including the
    // declared prefix, so the signature's array carrier also holds this copy.
    shape: restType,
    operands,
    results: [mintResult(arrayId, 'value', restType)],
    completion: normalCompletion,
    effects: { readsMutableState: false, writesMutableState: false, allocates: true, callsUserCode: false },
    evaluationOrdinal
  }
  return {
    operations: [restOperation, arrayOperation],
    edges: [{ kind: 'value', result: restResult.id, to: arrayId, role: 'spread', ordinal: phantom.ordinal }],
    value: semanticResultId(arrayId, 'value'),
    type: restType
  }
}

/**
 * Whether a parameter binds a cell in a real calling frame.
 *
 * A parameter's parent can be a type-level shape with no frame behind it at
 * all -- `FunctionTypeNode`, `ConstructorTypeNode`, `MethodSignature`,
 * `CallSignatureDeclaration`, `ConstructSignatureDeclaration`, and
 * `IndexSignatureDeclaration` all declare a parameter list without ever
 * calling it. Those parents are not in `BodiedSignatureDeclaration` at all, so
 * they answer `false` here directly. An ambient declaration or an overload
 * signature has a parent kind that *can* carry a body (`FunctionDeclaration`)
 * but this particular one does not (`declare function f(x: number): void`, or
 * one signature of an overloaded function with no implementation) -- checking
 * `.body` catches those the kind test alone would miss. Every one of these
 * shapes has no ABI a caller ever writes an argument into, so publishing an
 * `initialize` operand sourced from an ABI position would mint a read of a
 * frame slot nothing populates.
 */
const hasArgumentFrame = (node: ts.ParameterDeclaration): boolean => {
  const parent = node.parent
  return isBodiedSignatureDeclaration(parent) && parent.body !== undefined
}

/**
 * The structural type ECMAScript's default-parameter initializer eliminates:
 * exactly the `undefined` arm of a union, never `null`. Only a union the
 * checker widened with `undefined` needs the strip -- an inferred parameter
 * (`p = 0`, no annotation) is never widened that way to begin with, and
 * `checker.getNonNullableType` strips both absence values, which is the wrong
 * rule here: `function f(x: number | null = 0)` still binds `x` to `null`
 * when a caller passes it, and only an omitted or explicitly `undefined`
 * argument runs the initializer.
 *
 * This filters the *structural* union rather than reconstructing a `ts.Type`.
 * `ts.TypeChecker.getUnionType` is internal and not part of the public API,
 * so a `ts.Type`-level strip has no way to spell "the union of the two
 * declared members that are left" once `undefined` has more than one
 * sibling -- `function f(x: string | number | undefined = 0)` would have had
 * to fall back to the whole three-armed type, leaving `undefined` in the
 * binding's cell despite the initializer having just eliminated it, which is
 * exactly the `binding-read-conversion` mismatch this produced against every
 * later read (each of which derives its own, `undefined`-free structural
 * type independently). `StructuralTypeTable` has no such restriction: a
 * structural `union` is public data this file already constructs directly
 * two lines below, so dropping one member and re-interning -- or unwrapping
 * to the sole remaining member -- needs nothing internal.
 */
const withoutUndefinedMember = (id: StructuralTypeId, table: StructuralTypeTable): StructuralTypeId => {
  const type = table.get(id)
  if (type.shape.kind !== 'union') return id
  const remaining = type.shape.members.filter((memberId) => {
    const member = table.get(memberId)
    return member.shape.kind !== 'primitive' || member.shape.primitive !== 'undefined'
  })
  if (remaining.length === type.shape.members.length) return id
  const [first, ...rest] = remaining
  if (!first) return id
  return rest.length === 0 ? first : table.intern({ kind: 'union', members: remaining })
}

/** Whether a type IS `undefined`, or a union every member of which is -- the one initializer that replaces nothing. */
const isUndefinedType = (id: StructuralTypeId, table: StructuralTypeTable): boolean => {
  const shape = table.get(id).shape
  if (shape.kind === 'primitive') return shape.primitive === 'undefined'
  return shape.kind === 'union' && shape.members.every((member) => isUndefinedType(member, table))
}

/**
 * A defaulted parameter's three operations: the raw argument as a citable
 * guard, the default itself, and the named binding.
 *
 * `function f(x = 0)` binds `x` inside the body via
 * `FunctionDeclarationInstantiation` -> `IteratorBindingInitialization` ->
 * `KeyedBindingInitialization`'s Initializer_opt clause -- the exact same
 * production a destructuring element's own default already goes through,
 * which is why this reuses that family's operation rather than inventing a
 * second "default" shape: `family: 'destructuring', form: 'default-value'`
 * (`contributeDefault` above -- sibling code, not this parameter's own -- for
 * the object/array-pattern case) already models "fire only when the extracted
 * value is exactly `undefined`" with its own identity rather than the shared
 * conditional-edge vocabulary, for the reason given on that function: the
 * vocabulary only has `nullish`, which conflates `null` with `undefined`.
 *
 * The raw argument's own structural type is built here rather than read off
 * the parameter the way every other operand's type is, because the checker's
 * answer for it is not one shape across the two ways to spell a default:
 * `p: number | undefined = 0`'s parameter declaration reports the full
 * annotation, `number | undefined`, but `p = 0`'s already reports the
 * narrowed, `undefined`-free `number` there -- the same checker API
 * disagreeing with itself across two spellings of one feature. Building
 * `payload | undefined` directly, from the same payload type the default's
 * own result publishes, is what makes this operand's carrier agree with
 * `representation/derive.ts`'s `abiOf` regardless of which spelling produced
 * it, since both widen the same payload with the same absence value; a
 * parameter whose own declared type already carries a *different* absence
 * value (`p: number | null = 0`) has that same union collapse fail closed in
 * `abiOf`, for the reason given on the `optionalOf` call there.
 */
const contributeDefaultedParameter = (
  candidate: CensusCandidate,
  node: ts.ParameterDeclaration & { readonly initializer: ts.Expression },
  context: ProducerContext
): CandidateContribution => {
  const cited = citeExpressionResult(node.initializer, context)
  if (cited.kind === 'unmodelled') {
    return { kind: 'blocked', blocker: blocked(candidate.id, 'binding', `default parameter initializer ${cited.reason}`, null) }
  }

  // `undefined` is stripped from the body type because the initializer runs
  // exactly when the argument was `undefined` and replaces it -- unless the
  // initializer's own value IS `undefined`, in which case it replaces nothing
  // and the body really can observe one. `p: EventName | undefined = undefined`
  // is that case, it is ordinary TypeScript (which types the binding
  // `EventName | undefined` there, exactly as this now does), and stripping it
  // anyway gave the initializer's own constant the undefined-free carrier --
  // a literal `undefined` asserted into a `gea::TaggedUnion<std::string,
  // gea::Symbol>`, which has no state for it.
  // STATED, not held: this parameter's own written annotation, needed
  // verbatim (see the comment above) precisely because the checker's answer
  // to it differs across two annotation spellings -- the exact fact this
  // code compensates for, not one a census should paper over.
  // ...and asked of the CENSUS first, exactly as `structural-parts.ts`'s
  // `parameterOf` opens with `parameters.typeAt(declaration)` for the SLOT
  // this operand reads. The checker's answer at an UNANNOTATED defaulted
  // parameter is not the written annotation the paragraph above is about --
  // there is none -- it is the DEFAULT INITIALIZER'S own type, and a default
  // value is not a type. `RenderTarget.js`'s `_setTextureOptions( options =
  // {} )` is the measured case: the ABI slot and every body read carried
  // `RenderTarget_Options` (the census answer, from the call sites), while
  // the binding that initializes the cell both of those read through carried
  // `{}` -- 26 unmet `binding-read-conversion:record(...;)->record(... 20
  // fields ...)` obligations on the three.js app, one per read, and not one of them a
  // capability that was missing. Three authorities over one parameter, the
  // same shape `parameter-slot.ts`'s header records for rest parameters, and
  // closed the same way. Where the parameter DOES state a type the census
  // publishes nothing and the checker still answers, so the annotated
  // spellings this function compensates for are untouched.
  // The mapper's own answer for the parameter, not the checker's `ts.Type`
  // re-interned: for a destructured parameter the mapper lays the value out
  // as the array its call sites pass (`impliedPatternArrayElementAt`), where
  // the checker's tuple would put a record in the slot the pattern then
  // reads as an array.
  const declaredType = context.types.typeAt(node)
  const fallbackType = context.types.typeAt(node.initializer)
  const bodyType = isUndefinedType(fallbackType, context.table) ? declaredType : withoutUndefinedMember(declaredType, context.table)
  // The raw argument -- what the caller physically passed -- is the declared
  // type with `undefined` present, and it is asked of the CHECKER rather than
  // built here, because it has to be the same interned shape
  // `SignatureParameter.slot` is (`normalize/parameter-slot.ts`): the ABI
  // declares that slot and this operand reads it, and two spellings of one
  // union are two different shapes. Interning `union(bodyType, undefined)`
  // directly is the spelling that differs: where `bodyType` is itself a union
  // -- `f(x: T | null = null)`, which JSDoc writes as `@param {?T} [x=null]`
  // and three.js writes throughout -- that nests a union inside a union, and
  // a nested one derives as "an optional payload that is itself optional",
  // which is the carrier one flag cannot hold. `getNullableType` flattens, so
  // the three-armed union reaches the deriver as three arms.
  const rawType = context.table.intern({ kind: 'union', members: [declaredType, context.types.typeOf(context.checker.getUndefinedType())] })

  const valueId = mintOperationId(context.ordinals, candidate.id, 'reference')
  const valueResult = mintResult(valueId, 'value', rawType)
  const valueOperation: ReferenceOperation = {
    id: valueId,
    family: 'reference',
    form: 'parameter-value',
    strict: true,
    unresolvableThrows: false,
    hasNoCell: false,
    caller: candidate.caller,
    // Supplied by the frame the caller established, exactly as `this`'s own
    // `{kind: 'receiver'}` operand is (`references.ts`'s `buildThisReference`):
    // nothing here evaluates it, so it is recorded as provenance rather than
    // as a runtime step this operation performs.
    operands: [operand('argument', 0, { kind: 'parameter', ordinal: abiOrdinalOf(node) }, rawType, { kind: 'provenance' })],
    results: [valueResult],
    completion: normalCompletion,
    effects: pureEffects,
    evaluationOrdinal: candidate.evaluationOrdinal
  }

  const defaultId = mintOperationId(context.ordinals, candidate.id, 'destructuring')
  const defaultResult = mintResult(defaultId, 'value', bodyType)
  const defaultOperation: DestructuringOperation = {
    id: defaultId,
    family: 'destructuring',
    form: 'default-value',
    caller: candidate.caller,
    operands: [
      operand('extracted', 0, { kind: 'result', result: valueResult.id }, rawType, { kind: 'provenance' }),
      // The fallback is the initializer expression's own value. `bodyType`
      // describes the merge result after either the supplied argument or the
      // default wins; using it on this incoming edge erases the initializer's
      // physical carrier before conversion planning. A static `null` property
      // used as a default then masquerades as the parameter's broad Object
      // annotation and asks the emitter to convert a constructor carrier into
      // the call-site-derived image union. Keep the edge typed by the already
      // computed initializer answer and let the merge perform the one real
      // conversion, from that value into `bodyType`.
      operand('fallback', 0, cited.source, fallbackType)
    ],
    results: [defaultResult],
    completion: normalCompletion,
    effects: { readsMutableState: false, writesMutableState: false, allocates: false, callsUserCode: cited.source.kind === 'result' },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const defaultEdges: SemanticEdge[] = [{ kind: 'value', result: valueResult.id, to: defaultId, role: 'extracted', ordinal: 0 }]
  const fallbackEdge = resultEdge(cited.source, defaultId, 'fallback', 0)
  if (fallbackEdge) defaultEdges.push(fallbackEdge)

  const bindId = mintOperationId(context.ordinals, candidate.id, 'binding')
  const bindOperation: BindingOperation = {
    id: bindId,
    family: 'binding',
    action: 'initialize',
    declaration: context.identities.declarationIdOf(node),
    mutable: true,
    temporalDeadZone: false,
    parameterInitialization: true,
    caller: candidate.caller,
    operands: [operand('initializer', 0, { kind: 'result', result: defaultResult.id }, bodyType)],
    results: [mintResult(bindId, 'value', bodyType)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  const bindEdge: SemanticEdge = { kind: 'value', result: defaultResult.id, to: bindId, role: 'initializer', ordinal: 0 }

  return { kind: 'operations', operations: [valueOperation, defaultOperation, bindOperation], edges: [...defaultEdges, bindEdge] }
}

/**
 * A formal parameter: one binding, initialized from the caller's frame.
 *
 * A rest parameter is an ordinary binding: the language binds it to one Array
 * holding the trailing arguments, and that Array is a single frame slot like
 * any other. What varies is the *argument* count, which is the caller's problem,
 * not this binding's.
 *
 * A pattern-named parameter still binds one cell: `function f({a, b})` gives
 * the frame slot no *user-visible* name, but the language does hold that value
 * while the pattern destructures it, and the elements read it from there. So it
 * publishes the same `initialize` every other parameter does -- the declaration
 * it names is the parameter itself -- and the destructuring producer cites that
 * result as the pattern's source. Contributing nothing here is what left every
 * element of such a pattern with no value to read.
 *
 * A default initializer on a plain identifier mints three operations, not
 * one, via `contributeDefaultedParameter` above: the raw argument as its own
 * citable value, the guarded default itself, and the named binding this
 * parameter introduces -- initialized from the default's result rather than
 * the raw argument directly. A pattern reads that same initialized cell, so
 * its extractions naturally follow the completed default operation.
 */
const contributeParameter = (
  candidate: CensusCandidate,
  node: ts.ParameterDeclaration,
  context: ProducerContext
): CandidateContribution => {
  // `function f(this: T)` declares the receiver's type; it is erased and has no
  // argument slot, so there is no binding here to introduce.
  if (ts.isIdentifier(node.name) && node.name.text === 'this') return { kind: 'operations', operations: [], edges: [] }
  // A type-level or bodyless parameter list (an index signature, a method
  // signature, a function type, an ambient declaration, an overload with no
  // implementation) is never called, so there is no frame slot for this
  // binding to read -- nothing is missing here, there is simply nothing to
  // introduce, the same "not every candidate names a gap" answer a
  // pattern-nested BindingElement gives above.
  if (!hasArgumentFrame(node)) return { kind: 'operations', operations: [], edges: [] }
  if (node.initializer) {
    return contributeDefaultedParameter(candidate, node as ts.ParameterDeclaration & { initializer: ts.Expression }, context)
  }
  const type = context.types.typeAt(node)
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const operation: BindingOperation = {
    id,
    family: 'binding',
    action: 'initialize',
    declaration: context.identities.declarationIdOf(node),
    // A parameter is an ordinary mutable binding, and it is bound before the
    // body runs, so there is no dead zone a read could fall into.
    mutable: true,
    temporalDeadZone: false,
    parameterInitialization: true,
    caller: candidate.caller,
    operands: [operand('initializer', 0, { kind: 'parameter', ordinal: abiOrdinalOf(node) }, type)],
    results: [mintResult(id, 'value', type)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

/**
 * Whether a declaration is ambient: `declare const x`, or anything inside a
 * `declare module` / `.d.ts`.
 *
 * An ambient declaration states that something exists without defining it: the
 * program never introduces the cell, a host does. That is not a reason to
 * refuse it -- it is a different *kind* of introduction, one whose carrier
 * still comes from the declared type like any other binding's, but whose
 * storage is `external` rather than `local`/`region` (`BindingStorage`,
 * projection/bindings.ts) and whose obligation is a host-boundary capability
 * rather than a carrier-selection one (`buildExternalBindingObligation`,
 * preflight/run.ts). Emitting a definition for it regardless -- as though the
 * program itself owned the cell -- is what would be silently wrong: a null
 * function pointer called through, or a zeroed record loaded from.
 */
const isAmbient = (node: ts.Declaration): boolean => {
  if ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0) return true
  // `declare module "x" { const y: T }` marks only the module, so the walk is
  // what catches a declaration nested inside one.
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isModuleDeclaration(current) && (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * A `for`-`of`/`for`-`in` loop variable (`const value` in `for (const value of
 * values)`) has no `=` initializer of its own -- ECMA-262 assigns it from the
 * loop's own `IteratorStep`/enumerate step instead, at the head of every
 * iteration. `mintIteratorSteps` (protocol.ts) reserves `next` at a fixed
 * ordinal -- 2 -- specifically so a citation like this one can be built from
 * the enclosing loop's identity alone, without knowing which loop variant (or
 * which of its steps this compiler can actually lower) produced it: this
 * returns the same `SemanticResultId` regardless of whether that `next` takes
 * the array-native fast path or the general dynamic protocol.
 *
 * Returns `null` for anything that is not exactly this shape -- a plain `let x`
 * with no initializer stays an ordinary uninitialized declaration.
 */
const forOfLoopVariableNextResult = (node: ts.VariableDeclaration, context: ProducerContext) => {
  if (node.initializer || !ts.isIdentifier(node.name)) return null
  const list = node.parent
  if (!ts.isVariableDeclarationList(list)) return null
  const loop = list.parent
  if (!(ts.isForOfStatement(loop) || ts.isForInStatement(loop)) || loop.initializer !== list) return null
  return semanticResultId(operationId(context.identities.nodeIdOf(loop), 'protocol', 2), 'value')
}

/**
 * The per-iteration WRITE a for-of/for-in loop performs into a bare
 * identifier reused as its own head -- `var v; for (v of xs) { ... }`, where
 * `v` carries no `var`/`let`/`const` of its own at the loop and so mints no
 * `VariableDeclaration` candidate for `contributeVariableDeclaration` above to
 * bind. `census.ts`'s `isForOfLoopHeadWriteTarget` is what routes this exact
 * node shape to the `binding` family at all -- see its own header for why the
 * write had no producer before this one.
 *
 * Modelled as a `write` (not `initialize`) `BindingOperation`, exactly the
 * shape `computations.ts`'s `bindingWriteFor` builds for `x = expr`: the
 * declaration is resolved from the identifier's own SYMBOL
 * (`identities.symbolDeclarationId`), never minted fresh at this reference, so
 * the store lands in the SAME cell `var v`'s own declaration owns. The value
 * stored is the loop's own `next` result, cited by the identical fixed
 * `protocol` ordinal `forOfLoopVariableNextResult` cites for the declared-in-
 * loop case -- `mintIteratorSteps` reserves it regardless of which loop
 * variant or protocol path produced it.
 */
const contributeForOfLoopHeadWrite = (candidate: CensusCandidate, node: ts.Identifier, context: ProducerContext): CandidateContribution => {
  const loop = node.parent as ts.ForOfStatement | ts.ForInStatement
  const symbol = context.checker.getSymbolAtLocation(node)
  if (!symbol)
    return { kind: 'blocked', blocker: blocked(candidate.id, 'binding', 'a for-of/for-in loop head names no resolvable symbol', null) }
  const declaration = context.identities.symbolDeclarationId(symbol)
  if (!declaration) {
    return {
      kind: 'blocked',
      blocker: blocked(candidate.id, 'binding', 'a for-of/for-in loop head write names a symbol with no resolvable declaration', null)
    }
  }
  const declarationNode = context.identities.declarationOfSymbol(symbol)
  const { mutable, temporalDeadZone } = declarationNode ? bindingKindOf(declarationNode) : { mutable: true, temporalDeadZone: false }
  const value = semanticResultId(operationId(context.identities.nodeIdOf(loop), 'protocol', 2), 'value')
  const type = context.types.typeAt(node)
  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const operation: BindingOperation = {
    id,
    family: 'binding',
    action: 'write',
    declaration,
    mutable,
    temporalDeadZone,
    ...(context.commonJsBindings.has(declaration)
      ? {
          commonJs: {
            global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
            owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body')
          }
        }
      : {}),
    caller: candidate.caller,
    operands: [operand('value', 0, { kind: 'result', result: value }, type)],
    results: [mintResult(id, 'value', type)],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: [{ kind: 'value', result: value, to: id, role: 'value', ordinal: 0 }] }
}

const contributeVariableDeclaration = (
  candidate: CensusCandidate,
  node: ts.VariableDeclaration,
  context: ProducerContext
): CandidateContribution => {
  const ambient = isAmbient(node)
  const declaration = context.identities.declarationIdOf(node)

  // The linkage name is read here and nowhere else in the compiler: an ambient
  // declaration's spelling is the ABI contract with the host that defines it,
  // exactly as a C++ `extern` declaration's spelling is the contract with
  // whatever translation unit defines it elsewhere. Every downstream consumer
  // (projection, preflight, emission) carries this string as opaque data; none
  // of them may re-derive it from a name, a symbol, or source text of their
  // own. The checker already rejects an ambient declaration with a
  // destructured name (`declare const { a }: T` is not valid TypeScript), so a
  // non-identifier name here means the census and the checker have drifted.
  let external: { readonly linkageName: string } | undefined
  if (ambient) {
    if (!ts.isIdentifier(node.name)) {
      return {
        kind: 'blocked',
        blocker: blocked(
          candidate.id,
          'binding',
          'an ambient declaration with a destructured name has no single linkage symbol for a host to define',
          'P6'
        )
      }
    }
    // Unless an installed host has said it does not provide this name. An
    // ambient declaration is external BECAUSE some host defines it, and a host
    // that denied it is precisely the case where that stops being true --
    // `extern` for it names a symbol no object file defines. The same census
    // answers the value's TYPE as `undefined` (structural-layout-type.ts), so
    // the storage class and the carrier are one decision, not two.
    if (context.absentGlobals.typeAt(node) === null) external = { linkageName: node.name.text }
  }

  const { mutable, temporalDeadZone } = bindingKindOf(node)
  const initializer = node.initializer
  const loopValueResult = initializer ? null : forOfLoopVariableNextResult(node, context)

  const operands: SemanticOperand[] = []
  if (initializer) {
    const cited = citeExpressionResult(initializer, context)
    if (cited.kind === 'unmodelled') return { kind: 'blocked', blocker: blocked(candidate.id, 'binding', cited.reason, null) }
    operands.push(operand('initializer', 0, cited.source, context.types.typeAt(initializer)))
  } else if (loopValueResult) {
    operands.push(operand('initializer', 0, { kind: 'result', result: loopValueResult }, context.types.typeAt(node)))
  }

  const id = mintOperationId(context.ordinals, candidate.id, 'binding')
  const operation: BindingOperation = {
    id,
    family: 'binding',
    action: initializer || loopValueResult ? 'initialize' : 'declare',
    declaration,
    mutable,
    temporalDeadZone,
    ...(context.commonJsBindings.has(declaration)
      ? {
          commonJs: {
            global: context.commonJsBindings.get(declaration) as 'require' | 'exports' | 'module',
            owner: regionId(context.identities.nodeIdOf(node.getSourceFile()), 'module-body')
          }
        }
      : {}),
    caller: candidate.caller,
    operands,
    results: [mintResult(id, 'value', context.types.typeAt(node))],
    completion: normalCompletion,
    effects: { ...pureEffects, writesMutableState: true },
    evaluationOrdinal: candidate.evaluationOrdinal,
    ...(external ? { external } : {})
  }
  return { kind: 'operations', operations: [operation], edges: [] }
}

export const createBindingProducer = (context: ProducerContext): FamilyProducer => ({
  family: 'binding',
  contribute: (candidate) => {
    const node = candidate.node
    // A BindingElement exists only inside an ObjectBindingPattern or
    // ArrayBindingPattern -- by construction it is always a destructuring
    // introduction, whether or not its own name happens to be a plain
    // identifier one level down.
    if (ts.isBindingElement(node)) return contributeBindingElement(candidate, node, context)
    if (ts.isParameter(node)) return contributeParameter(candidate, node, context)
    if (ts.isVariableDeclaration(node)) {
      // `const {a} = x` declares nothing at the declaration node itself: every
      // name it introduces belongs to an element of the pattern, and each of
      // those is its own candidate handled above.
      if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
        return { kind: 'operations', operations: [], edges: [] }
      }
      return contributeVariableDeclaration(candidate, node, context)
    }
    // A bare identifier reused as a for-of/for-in loop's own head (`var v;
    // for (v of xs)`) is the fourth and last shape `census.ts` routes to this
    // family -- `isForOfLoopHeadWriteTarget` is the only thing that can have
    // put an `Identifier` candidate here.
    if (ts.isIdentifier(node)) return contributeForOfLoopHeadWrite(candidate, node, context)
    // census.ts assigns the 'binding' family only to VariableDeclaration,
    // BindingElement, Parameter, and for-of/for-in loop-head Identifier
    // nodes; reaching here means the census and this producer have drifted
    // out of sync.
    throw new Error(`binding producer received a candidate of unexpected syntax kind ${ts.SyntaxKind[node.kind]}`)
  }
})
