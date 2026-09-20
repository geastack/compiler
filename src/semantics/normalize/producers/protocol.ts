import ts from 'typescript'
import type { OperationId, SemanticResultId, StructuralTypeId } from '../../../identity/ids.js'
import { operationId, semanticResultId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { pureEffects, throwingCompletion, type OperandSource } from '../../model/operands.js'
import type { ProtocolOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { CandidateContribution, FamilyProducer } from '../contribution.js'
import { blocked, mintOperationId, mintResult, operand } from './mint.js'
import { isArgumentsObjectIdentifier } from './bindings.js'
import { resolveExpressionOperand } from './boundary.js'
import type { ProducerContext } from '../producer-context.js'
import {
  hasNativeIterationCursor,
  iterationPayloadArm,
  isGeneratorType,
  isNativeIterableSetType,
  isNativeIterableStringType,
  staticSpreadMembersOf,
  valueEdgesInto
} from './shared.js'
import { iteratorMethodSymbolOf, iteratorRecordTypesOf, iteratorYieldStructuralType } from './iteration-yield.js'
import type { IterationProtocol } from './iteration-yield.js'
import { closedTupleElementTypesOf } from './tuple-spread.js'
import { symbolPropertyKeyText } from '../../model/structural-types.js'
import { symbolKeyDeclarationOf } from '../structural-leaves.js'

/**
 * Iterator/enumerate/spread protocols.
 *
 * `f(...xs)`, `[...xs]`, and `{...o}` all read as "spread" in surface syntax,
 * but they are three different runtime protocols and this file must never let
 * one stand in for another:
 *
 * - argument spread and array-literal spread both drive the sync iterator
 *   protocol (`GetIterator` / `IteratorNext`) over their operand -- the census
 *   assigns both to the single `SpreadElement` syntax kind, and the protocol
 *   they imply does not depend on which of the two contexts holds them;
 * - object spread (`SpreadAssignment`) is `CopyDataProperties`: own enumerable
 *   string+symbol keys copied directly, with no method lookup and no iterator
 *   at all -- it is `protocol: 'spread'` here, never `'iterator'`.
 *
 * `for`-`of`/`for`-`in` need this same sync-iterator/enumerate machinery, but
 * `census.ts` classifies those as `'control'`, not `'protocol'`, so
 * `control.ts` calls `mintIteratorSteps` below directly rather than this file
 * minting operations for a candidate it was never handed.
 */

const unresolvedType = (context: ProducerContext, reason: string): StructuralTypeId => context.table.intern({ kind: 'unresolved', reason })

/**
 * `any`/`unknown` is the one iteration source whose `@@iterator` lookup must
 * stay in the dynamic runtime.  It is deliberately narrower than "not a
 * native cursor": a typed class or a typed structural iterable still owns a
 * concrete method carrier, and routing either through `Value` would box a
 * statically represented value merely to iterate it.
 */
export const isDynamicIterationSource = (context: ProducerContext, type: StructuralTypeId): boolean => {
  const shape = context.table.get(type).shape
  return shape.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')
}

/** Which well-known-symbol chain an operation's protocol follows -- `iteration-yield.ts`'s question, asked in this file's own vocabulary. */
const iterationProtocolOf = (protocol: ProtocolOperation['protocol']): IterationProtocol =>
  protocol === 'async-iterator' ? 'async' : 'sync'

/**
 * The element type an iteration step yields.
 *
 * An array or tuple source is answered from the already-interned shape: those
 * two are the shapes this layer itself gave the source, so re-asking the
 * checker for them would be a second authority over an answer already held.
 *
 * Every other iterable is answered by `iteration-yield.ts`, which walks the
 * checker's own declared `@@iterator`/`next`/`IteratorResult` chain. That walk
 * used to be absent, and the gap was not small: a `for`-`of` over a `Map`, a
 * `Set` or any program-defined iterable got `unresolved` here, which then
 * propagated into the loop variable's carrier, the iterator record's carrier
 * and every value read out of the loop -- one missing derivation reported as
 * dozens of unrelated-looking carrier failures. `unresolved` is now reached
 * only when the source genuinely declares no protocol to follow, which is a
 * statement about the program rather than about this compiler.
 */
const iterationElementType = (
  context: ProducerContext,
  protocol: ProtocolOperation['protocol'],
  sourceType: StructuralTypeId,
  iterated: ts.Node | null,
  rawIterated: ts.Type | null = null
) => {
  if (protocol === 'enumerate') {
    // `for`-`in` yields only own+inherited *string* keys -- never symbols --
    // which is a guarantee of the enumerate protocol itself, not a fact about
    // any particular source, so it is safe to state outright.
    return context.table.intern({ kind: 'primitive', primitive: 'string' })
  }
  // `T | undefined` reaching here as the TOP-LEVEL shape -- exactly what
  // `subclass-member-overlay-transform.ts`'s own sound over-approximation
  // produces for a reference-typed member, and an ordinary pattern on its
  // own merits besides (an optional field checked truthy, then iterated) --
  // is peeled to its one real arm before any of the shape checks below run:
  // none of them recognize `union` at all, so a genuinely iterable single
  // arm buried under `| undefined` fell straight through to the checker
  // walk, which resolves `iterated`'s type from scratch and can disagree
  // with what this layer's own census already settled (an unannotated
  // parameter's call-site-inferred type, `parameter-bindings.ts`, is exactly
  // where the two diverge: the census resolves a concrete member type for
  // the RECEIVER, but the checker's per-expression walk has no memory of
  // that inference and answers plain `any`). Two or more non-nullish arms
  // stays unpeeled -- which arm's element type would even apply is a real
  // question this is not the layer to guess at, and the checker walk below,
  // or the final refusal, still answers it exactly as before.
  // Asked of `shared.ts`'s `iterationPayloadArm`, never re-derived here: this
  // peel and the one `hasNativeIterationCursor` performs are the same question
  // about the same type, and a third inline copy of it is what made the cursor
  // and the element type disagree (see that function's own comment for the
  // union-of-one-interned-id case it answers and this copy did not).
  const nonNullish = iterationPayloadArm(context, sourceType)
  const effectiveType = nonNullish ?? sourceType
  const shape = context.table.get(effectiveType).shape
  if (shape.kind === 'array') return shape.element
  if (shape.kind === 'tuple') return context.table.intern({ kind: 'union', members: shape.elements.map((element) => element.type) })
  if (shape.kind === 'unresolved') return effectiveType
  // A string yields STRINGS -- one code point per step (ECMA-262 22.1.3.36),
  // and a code point is itself a String value. Answered here rather than by
  // the checker walk below for the same reason an array's is: this layer
  // already knows the shape, and lib.es2015's `String` declares its own
  // `[Symbol.iterator](): IterableIterator<string>`, so asking would be a
  // second authority over an answer already held. It matters that the two
  // agree exactly: `publish.ts` publishes the cursor as `iterator(string)`
  // off the source's own carrier, and a `next` value typed anything else
  // would make the cursor and the value it yields disagree.
  if (isNativeIterableStringType(context, effectiveType)) return context.table.intern({ kind: 'primitive', primitive: 'string' })
  // A native `Set<T>` yields T directly (ECMA-262 24.2.3.10
  // `%SetPrototype%[Symbol.iterator]` delegates to
  // `%SetIteratorPrototype%.next`, whose `value` is the element itself) --
  // answered here, from the structural shape's own recorded type argument,
  // for the identical reason the array/tuple/string cases above are: this
  // layer already knows Set's own generic parameter
  // (`isNativeIterableSetType`/`context.keyedCollections`, the same
  // structural census `hasNativeIterationCursor` already consults to decide
  // this loop needs no dynamic `Symbol.iterator` lookup at all), so asking
  // the checker again below -- through `iterated`'s own PER-EXPRESSION type --
  // would be a second, less informed authority over an answer this layer
  // already holds: an unannotated parameter's call-site-inferred type
  // (`parameter-bindings.ts`) is exactly the case where the two can
  // genuinely disagree, since the checker's own per-expression walk has no
  // memory of that inference and answers `any` for the receiver where the
  // structural census already resolved a concrete `Set`. A `Set` JSDoc-typed
  // with no explicit type argument (three.js's own `new Set()` idiom, this
  // module's `subclass-member-overlay-transform.ts`) instantiates its one
  // parameter at `any`, which is exactly the honest answer -- an untyped
  // Set's elements are `any`, not a refusal.
  if (shape.kind === 'declared' && isNativeIterableSetType(context, effectiveType)) {
    return shape.typeArguments[0] ?? context.table.intern({ kind: 'primitive', primitive: 'any' })
  }
  // A source the program itself declared `any`/`unknown` is the one other
  // case this is not a gap for: every element an `any`-typed iterable yields
  // is `any` too, by the same rule that indexing an `any` value yields `any`
  // -- restating the source's own carrier is not a guess about a shape the
  // checker did not state, it is citing the shape the checker DID state.
  if (shape.kind === 'primitive' && (shape.primitive === 'any' || shape.primitive === 'unknown')) return effectiveType
  // HOLDS, census-aware: the exact disagreement this function's own comment
  // above warns about (an unannotated parameter's census-inferred receiver
  // vs. the checker's memory-less per-expression walk) applies here just as
  // much as it does to the union-peeling step above -- `context.types.
  // rawTypeAt` is the raw-`ts.Type` form of the same answer `source.type`
  // (this function's own `sourceType` parameter, from `resolveExpressionOperand`'s
  // `context.types.typeAt`) was already built from, so this fallback walk
  // stays in agreement with it instead of re-deriving a second, less informed
  // answer from the bare checker. A caller with no expression to offer (there
  // is none today) falls through to the same honest refusal as before rather
  // than getting a guess.
  const yielded = iterated
    ? iteratorYieldStructuralType(context, rawIterated ?? context.types.rawTypeAt(iterated), iterated, iterationProtocolOf(protocol))
    : null
  if (yielded !== null) return yielded
  return unresolvedType(context, 'the source declares no @@iterator/next/IteratorResult chain this can read an element type from')
}

/**
 * The `{ value, done }` result `IteratorNext` produces, and the method/record
 * pair that wraps it -- built once the element type is known, so the two are
 * never asked to name a shape independently and disagree about what each
 * other's `next()` returns.
 *
 * This is not a guess at "the" iterator protocol object: `[Symbol.iterator]`
 * is a niladic function returning a record with (at least) a `next` method,
 * and `next` is a niladic function returning `{value, done}` -- that is the
 * complete, load-bearing iteration shape. The general typed `for`-`of` path
 * now keeps the concrete declared record instead so its optional `return`
 * member remains available to IteratorClose. Every concrete iterator a
 * program can name -- an array's own, a
 * `Map`'s, a class's hand-written `[Symbol.iterator]()` -- satisfies this
 * exact structural record, so stating it is citing a fact the language
 * guarantees, not inventing a layout the source never declared. Scoped to
 * `iterator`/`enumerate`; `async-iterator`'s `next()` returns a `Promise` of
 * this record instead, a different shape this does not yet build.
 */
const iteratorMethodAndRecordTypes = (
  context: ProducerContext,
  elementType: StructuralTypeId,
  // The REAL structural type `receiver[Symbol.iterator]()` returns, when
  // `generatorRecordTypeOf` (below) has already proven it is the standard
  // `Generator<T, TReturn, TNext>` -- in which case that real type IS the
  // record, and the synthetic ECMA-262 simulation below would only publish a
  // second, disagreeing shape for the identical call. `null` for every other
  // source, which is the overwhelming common case and keeps this function's
  // synthetic branch exactly as it always was.
  generatorRecordType: StructuralTypeId | null
): { readonly methodType: StructuralTypeId; readonly recordType: StructuralTypeId } => {
  const recordType =
    generatorRecordType ??
    (() => {
      const boolType = context.table.intern({ kind: 'primitive', primitive: 'boolean' })
      const nextResultType = context.table.intern({
        kind: 'object',
        members: [
          { key: { kind: 'string', value: 'value' }, type: elementType, optional: false, readonly: true, accessor: null },
          { key: { kind: 'string', value: 'done' }, type: boolType, optional: false, readonly: true, accessor: null }
        ],
        index: [],
        membersDropped: false
      })
      const nextMethodType = context.table.intern({
        kind: 'signature',
        call: [{ parameters: [], minimumArity: 0, thisParameter: null, result: nextResultType }],
        construct: []
      })
      return context.table.intern({
        kind: 'object',
        members: [{ key: { kind: 'string', value: 'next' }, type: nextMethodType, optional: false, readonly: true, accessor: null }],
        index: [],
        membersDropped: false
      })
    })()
  const methodType = context.table.intern({
    kind: 'signature',
    call: [{ parameters: [], minimumArity: 0, thisParameter: null, result: recordType }],
    construct: []
  })
  return { methodType, recordType }
}

/**
 * The REAL structural type `receiver[Symbol.iterator]()` returns, when that
 * return is -- itself, not the receiver -- the standard `Generator<T,
 * TReturn, TNext>`: the one shape `representation/derive.ts`'s
 * `GeneratorDeclarationPolicy` carries as the native `gea::Iterator<T>`
 * cursor rather than a record. `null` otherwise -- including when `iterated`
 * resolves to more than one iterator record (a union receiver whose arms
 * declare different `[Symbol.iterator]`s) -- in which case
 * `iteratorMethodAndRecordTypes`'s synthetic ECMA-262 `{ next(): { value,
 * done } }` shape is exactly right and stays unchanged: it is what this
 * compiler still has to state generically for every OTHER concrete iterator a
 * program can name (a hand-written object literal, `Map`'s or `Set`'s own
 * iterator, a union of sources, etc.).
 *
 * `receiver[Symbol.iterator]` genuinely returning a `Generator<T>` happens
 * when the source declares the member as a GENERATOR method
 * (`*[Symbol.iterator]() { yield ... }`) rather than an ordinary method that
 * builds and returns an object literal. The receiver's own type is NOT
 * itself a Generator in this case -- `hasNativeIterationCursor`'s
 * `isGeneratorType` check, consulted before this producer ever mints a
 * `get-method` step, already routes a directly-Generator-typed receiver
 * around the whole dance -- but CALLING its `[Symbol.iterator]()` produces
 * one, and the call result needs the identical `iterator(T)` carrier a
 * directly-Generator-typed receiver gets: one runtime value, `gea::
 * Iterator<T>`, whether it arrived by being iterated directly or by being
 * handed back from a method call. `iteratorMethodKeyTextOf`, just below,
 * resolves the SAME method symbol this reads the return type of, so the
 * `get-method` step's own key and this record type can never name two
 * different members.
 */
const generatorRecordTypeOf = (
  context: ProducerContext,
  iterated: ts.Node | null,
  protocol: IterationProtocol,
  rawIterated: ts.Type | null = null
): StructuralTypeId | null => {
  if (!iterated) return null
  // HOLDS, census-aware -- kept in agreement with `iterationElementType`'s
  // own fallback walk over the SAME `iterated` expression (both must resolve
  // to the same receiver type, or this and that step could name two
  // different iterator records for one source).
  const sourceType = rawIterated ?? context.types.rawTypeAt(iterated)
  const iterators = iteratorRecordTypesOf(context, sourceType, iterated, protocol)
  if (!iterators || iterators.length !== 1) return null
  const [only] = iterators
  if (only === undefined) return null
  const recordType = context.types.typeOf(only)
  return isGeneratorType(context, recordType) ? recordType : null
}

/**
 * The concrete method/record pair declared by a statically typed iterable.
 * Keeping the real record is required for IteratorClose: unlike the minimal
 * synthetic `{ next }` protocol view, it retains an optional `return` method
 * without widening the iterator into the dynamic carrier.
 */
const declaredIteratorMethodAndRecordTypes = (
  context: ProducerContext,
  iterated: ts.Node | null,
  protocol: IterationProtocol,
  rawIterated: ts.Type | null = null
): { readonly methodType: StructuralTypeId; readonly recordType: StructuralTypeId } | null => {
  if (!iterated) return null
  const sourceType = rawIterated ?? context.types.rawTypeAt(iterated)
  const method = iteratorMethodSymbolOf(sourceType, protocol)
  const records = iteratorRecordTypesOf(context, sourceType, iterated, protocol)
  if (!method || !records || records.length !== 1) return null
  const record = records[0]
  if (!record) return null
  const declaredMethodType = context.checker.getTypeOfSymbolAtLocation(method, iterated)
  // The method's declared type and the record it returns are ONE fact, and the
  // member symbol is only an authority on it while the two agree. For an
  // overloaded generator member they do not: TypeScript shows the bodiless
  // `[Symbol.iterator](): IterableIterator<T>` here and never the
  // `*[Symbol.iterator](): Generator<T>` that physically runs, so the `get`
  // step published `() -> native-record-ref` for a body whose convention
  // returns the native `iterator` cursor -- `emit-class-properties.ts`'s
  // 'method "..." body convention cannot fill its published bound-method
  // convention'. `iteratorRecordTypesOf` already resolved the physical answer
  // (`physicalGeneratorOverloadReturnOf`), so the method type is rebuilt around
  // it rather than re-derived: same parameters, same receiver, the record this
  // pair has already settled on.
  //
  // Only when they DISAGREE. An ordinary iterable's `record` IS this
  // signature's own return type, object-identical, and rebuilding it there
  // would re-intern one unchanged shape through a second path for nothing.
  const only = declaredMethodType.getCallSignatures().length === 1 ? declaredMethodType.getCallSignatures()[0] : undefined
  const rebuilt =
    only && context.checker.getReturnTypeOfSignature(only) !== record ? context.types.resolvedSignatureTypeOf(only, 'call', record) : null
  const answer = { methodType: rebuilt ?? context.types.typeOf(declaredMethodType), recordType: context.types.typeOf(record) }
  // Opt-in, because this is the pair that has now disagreed twice and the
  // disagreement is invisible in the refusal: the emitter reports the METHOD
  // convention and names neither which of these two produced it nor what the
  // other said.
  if (process.env['GEA_DEBUG_ITERATOR']) {
    process.stderr.write(
      `[ITERATOR] ${method.getName()} declared=${context.checker.typeToString(declaredMethodType)} ` +
        `record=${context.checker.typeToString(record)} rebuilt=${rebuilt !== null} ` +
        `methodType=${answer.methodType} recordType=${answer.recordType}\n`
    )
  }
  return answer
}

export interface IteratorProtocolOptions {
  /** `for`-`in` enumerates the object directly; it never looks up a method. */
  readonly includeGetMethod: boolean
  /** Only sync/async iteration calls `IteratorClose` on early exit; enumerate and plain spread never do. */
  readonly includeClose: boolean
  /** A consuming spread drains the record itself; do not pre-step it. */
  readonly includeNext?: boolean
}

export interface IteratorProtocolSteps {
  readonly operations: readonly ProtocolOperation[]
  readonly edges: readonly SemanticEdge[]
  readonly iteratorRecord: SemanticResultId
  readonly recordType: StructuralTypeId
  readonly nextValue: SemanticResultId
  readonly nextOperationId: OperationId
  /** `null` when `includeClose` is false: there is no close step for a caller to route an abrupt exit into. */
  readonly closeOperationId: OperationId | null
}

/**
 * The static property-key text `receiver[Symbol.iterator]` names, or `null`
 * when `iterated` is absent or its type declares no such member.
 *
 * This is `producers/shared.ts`'s `symbolMemberKeyOf` in spirit -- a
 * `unique symbol` member's canonical key text, so a computed read and a
 * computed definition of the same well-known symbol resolve one identity --
 * but reached from the OTHER direction: `symbolMemberKeyOf` starts from a
 * key EXPRESSION already in the source and asks whether the receiver
 * declares a matching member, while the general iterator protocol has no
 * `Symbol.iterator` expression to start from at all (`for (const x of xs)`
 * writes no `[Symbol.iterator]` anywhere) and has to start from the
 * RECEIVER's own type instead. `iteratorMethodSymbolOf` is the one lookup
 * both `iterationElementType`'s checker walk (above) and this reuse: the step
 * that types what the source yields and the step that names the member to
 * call can never resolve to two different members of the same type.
 *
 * `symbolKeyDeclarationOf` resolves the member's COMPUTED name back to the
 * `const`/property the symbol was bound to (`Symbol.iterator` itself, for the
 * well-known case) -- the same anchor `representation/object-shape.ts`'s
 * `recordFieldKeyOf` spells a record's own symbol-keyed FIELD by
 * (`symbolPropertyKeyText`), so a class's or a record's `[Symbol.iterator]`
 * member and this producer's `get-method` key agree on one text without
 * either side re-deriving it. The `declarationOfSymbol` fallback covers a
 * member declared directly on the type rather than through a computed name
 * pointing at an aliasable `const` -- the same fallback `keyOfSymbol`
 * (`structural-leaves.ts`) takes for an ordinary interned symbol-keyed
 * member.
 */
const iteratorMethodKeyTextOf = (
  context: ProducerContext,
  iterated: ts.Node | null,
  protocol: IterationProtocol,
  rawIterated: ts.Type | null = null
): string | null => {
  if (!iterated) return null
  // HOLDS, census-aware -- the same `iterated` receiver `iterationElementType`
  // and `generatorRecordTypeOf` resolve, kept in agreement with both for the
  // reason this function's own doc states: the step that types what the
  // source yields and the step that names the member to call must resolve to
  // the same member of the same type.
  const type = rawIterated ?? context.types.rawTypeAt(iterated)
  const method = iteratorMethodSymbolOf(type, protocol)
  if (!method) return null
  const declaration = symbolKeyDeclarationOf(context.checker, context.identities, method) ?? context.identities.declarationOfSymbol(method)
  return declaration ? symbolPropertyKeyText(context.identities.declarationIdOf(declaration)) : null
}

/**
 * Mints the sync/async-iterator or enumerate protocol steps for one source
 * expression, sharing one implementation between this file's own spread
 * handling and `control.ts`'s `for`-`of`/`for`-`in`/`yield*` handling so both
 * always agree on the shape of "the iteration protocol" instead of drifting
 * into two independently-evolving copies.
 *
 * The four possible steps reserve fixed ordinals -- 0 `get-method`, 1
 * `get-iterator`, 2 `next`, 3 `close` -- by drawing from the counter in that
 * order even when a step is skipped for this `protocol` (`for`-`in` never has
 * a `get-method`; plain spread never has a `close`). Without that, `next`
 * would land at ordinal 1 for `for`-`in` but ordinal 2 for `for`-`of`, and any
 * other producer that needs to cite "the per-iteration value" for a loop node
 * -- the binding producer initializing the loop variable -- would have no
 * fixed identity to build without first knowing which loop variant produced
 * it. Reserving the ordinal even when unused keeps `next` at ordinal 2
 * regardless of variant.
 */
export const mintIteratorSteps = (
  context: ProducerContext,
  candidate: CensusCandidate,
  protocol: ProtocolOperation['protocol'],
  source: {
    readonly source: OperandSource
    readonly type: StructuralTypeId
    readonly iterated: ts.Node | null
    /** Census-correct checker type when `iterated` is target syntax rather than the source expression itself. */
    readonly rawIterated?: ts.Type | null
  },
  options: IteratorProtocolOptions
): IteratorProtocolSteps => {
  const operations: ProtocolOperation[] = []
  const edges: SemanticEdge[] = []
  // The element type is needed to state the record's own `next()` shape, so
  // it is derived first here rather than where `next`'s result is minted
  // below -- the record and the value it eventually yields must agree on one
  // element type, not derive it twice.
  const rawIterated = source.rawIterated ?? null
  const elementType = iterationElementType(context, protocol, source.type, source.iterated, rawIterated)
  const dynamicSource = isDynamicIterationSource(context, source.type)
  // `enumerate` is the one protocol with no method at all: `for`-`in` reads
  // the object directly and never resolves a `[Symbol.iterator]`, so there is
  // no return type to check. Sync and ASYNC iteration are one question here --
  // `iterationProtocolOf` picks which well-known symbol the walk follows, and
  // everything downstream of that answer is identical, because under this
  // runtime's settled-promise model an async generator is exactly a
  // synchronous cursor (see `producers/control.ts`'s yield comment).
  const generatorRecordType =
    protocol === 'enumerate' ? null : generatorRecordTypeOf(context, source.iterated, iterationProtocolOf(protocol), rawIterated)
  const declaredRecord =
    options.includeGetMethod && protocol !== 'enumerate'
      ? declaredIteratorMethodAndRecordTypes(context, source.iterated, iterationProtocolOf(protocol), rawIterated)
      : null
  const { methodType, recordType } = declaredRecord ?? iteratorMethodAndRecordTypes(context, elementType, generatorRecordType)
  // A dynamic source carries both the iterator record and every yielded value
  // as the source's authorized dynamic carrier.  The synthetic `{ next }`
  // record is for a statically known protocol member; publishing it here would
  // invent a native layout for a runtime object and strand the dynamic lookup
  // at lowering.
  const iteratorRecordType = dynamicSource ? source.type : recordType

  const getMethodId = mintOperationId(context.ordinals, candidate.id, 'protocol')
  const getIteratorId = mintOperationId(context.ordinals, candidate.id, 'protocol')
  const nextId = mintOperationId(context.ordinals, candidate.id, 'protocol')
  const closeId = mintOperationId(context.ordinals, candidate.id, 'protocol')

  let methodResult: SemanticResultId | null = null
  if (options.includeGetMethod) {
    // A "key" operand naming the exact member `[Symbol.iterator]` (or
    // `[Symbol.asyncIterator]`) resolves to, when the source's own type
    // declares one this producer can find and this backend's lowering can
    // therefore route as an ordinary `[[Get]]` (`ir/lower-protocol.ts`'s
    // `get-method` case) rather than the still-unbuilt fully dynamic method
    // lookup. Async iteration is out of scope for now -- `iterationElementType`
    // already leaves `methodType`/`recordType` unresolved for it above, so a
    // key here would name a member this backend has nowhere to route it to.
    const methodKeyText =
      protocol === 'enumerate' ? null : iteratorMethodKeyTextOf(context, source.iterated, iterationProtocolOf(protocol), rawIterated)
    const getMethodOperands = methodKeyText
      ? [
          operand('target', 0, source.source, source.type),
          operand(
            'key',
            0,
            { kind: 'constant', text: methodKeyText, literal: 'string' },
            context.table.intern({ kind: 'primitive', primitive: 'string' })
          )
        ]
      : [operand('target', 0, source.source, source.type)]
    const getMethod: ProtocolOperation = {
      family: 'protocol',
      id: getMethodId,
      protocol,
      step: 'get-method',
      caller: candidate.caller,
      operands: getMethodOperands,
      results: [mintResult(getMethodId, 'value', methodType)],
      // `GetMethod` throws when the property holds a non-callable, non-nullish
      // value; a missing/undefined method is not an error here; `get-iterator`
      // is where a missing iterator method becomes a `TypeError`.
      completion: throwingCompletion,
      effects: pureEffects,
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    operations.push(getMethod)
    methodResult = semanticResultId(getMethodId, 'value')
  }

  const getIteratorOperands = methodResult
    ? [operand('target', 0, source.source, source.type), operand('method', 0, { kind: 'result', result: methodResult }, methodType)]
    : [operand('target', 0, source.source, source.type)]
  const getIterator: ProtocolOperation = {
    family: 'protocol',
    id: getIteratorId,
    protocol,
    step: 'get-iterator',
    caller: candidate.caller,
    operands: getIteratorOperands,
    results: [mintResult(getIteratorId, 'iterator-record', iteratorRecordType)],
    completion: throwingCompletion,
    effects: { ...pureEffects, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  operations.push(getIterator)
  if (methodResult) edges.push({ kind: 'evaluation', from: getMethodId, to: getIteratorId })
  const iteratorRecord = semanticResultId(getIteratorId, 'iterator-record')

  const boolType = context.table.intern({ kind: 'primitive', primitive: 'boolean' })
  const next: ProtocolOperation = {
    family: 'protocol',
    id: nextId,
    protocol,
    step: 'next',
    caller: candidate.caller,
    operands: [operand('iterator-record', 0, { kind: 'result', result: iteratorRecord }, iteratorRecordType)],
    // `IteratorResult` is `{ value, done }`; publishing `done` under the
    // `completion` role (always boolean, never `elementType`) is what lets a
    // consumer gate "run the loop body" without re-deriving the flag itself.
    results: [mintResult(nextId, 'value', elementType), mintResult(nextId, 'completion', boolType)],
    completion: { ...throwingCompletion, canSuspend: protocol === 'async-iterator' },
    effects: { ...pureEffects, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  if (options.includeNext !== false) {
    operations.push(next)
    edges.push({ kind: 'evaluation', from: getIteratorId, to: nextId })
  }
  const nextValue = semanticResultId(nextId, 'value')

  let closeOperationId: OperationId | null = null
  if (options.includeClose) {
    const voidType = context.table.intern({ kind: 'primitive', primitive: 'void' })
    const close: ProtocolOperation = {
      family: 'protocol',
      id: closeId,
      protocol,
      step: 'close',
      caller: candidate.caller,
      operands: [operand('iterator-record', 0, { kind: 'result', result: iteratorRecord }, iteratorRecordType)],
      // IteratorClose produces no JavaScript value, but it still needs one
      // semantic anchor for IR provenance and its runtime-helper obligation.
      // A void completion is that anchor without inventing readable storage.
      results: [mintResult(closeId, 'completion', voidType)],
      completion: throwingCompletion,
      effects: { ...pureEffects, callsUserCode: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    }
    operations.push(close)
    // `IteratorClose` only runs on an abrupt exit from the loop body, and the
    // operations that can cause one (a `break`, a `return`, a throwing
    // statement inside the body) belong to other producers this single
    // candidate's contribution cannot see. Recording `close` as reachable in
    // program order from `next` states what is proven -- the step exists and
    // is part of this protocol -- without fabricating the precise trigger
    // edge; wiring that exactly needs a cross-producer operation index this
    // tree does not yet have.
    edges.push({ kind: 'evaluation', from: nextId, to: closeId })
    closeOperationId = closeId
  }

  return { operations, edges, iteratorRecord, recordType: iteratorRecordType, nextValue, nextOperationId: nextId, closeOperationId }
}

/**
 * Object spread's `CopyDataProperties`: own enumerable string+symbol keys
 * copied directly into the destination. There is no method lookup and no
 * iterator record, so this mints one operation, not a step sequence.
 *
 * `ProtocolOperation.step` is closed and shaped for iterator-style protocols
 * (`get-method`/`get-iterator`/`next`/`close`/`return`/`throw`); none of those
 * names is what `CopyDataProperties` does. `'next'` is reused here only as
 * "the single step this protocol performs" -- not as a claim that object
 * spread advances an iterator, which it never does.
 *
 * `receiver` names WHERE the copy writes -- `producers/allocations.ts`'s
 * `spreadCopyOf` defers this exact member to this exact operation (predicting
 * this same id, never re-minting it) whenever the source's own-property set
 * is not statically known, and `ir/lower-protocol.ts` needs the destination to
 * lower the copy at all. It is the SAME identity `allocations.ts`'s own
 * `AllocationOperation` for this literal already publishes -- the ordinal is 0
 * because the census gives an `ObjectLiteralExpression` the allocation family
 * exactly once, exactly as `methodValueOf` (allocations.ts) predicts a
 * sibling id the identical way -- so citing it here can never mint a second,
 * disagreeing identity for the one object this literal allocates.
 */
const contributeObjectSpread = (context: ProducerContext, candidate: CensusCandidate, node: ts.SpreadAssignment): CandidateContribution => {
  // A source whose own-property set is statically known takes no protocol step
  // at all: `producers/allocations.ts` copies its members field by field, so a
  // `spread` operation here would be a step nothing lowers, published for a
  // copy that already happened. Exactly the bypass an array-literal spread of a
  // plain array takes below, decided by the same shared predicate both halves
  // read (`shared.ts`'s `staticSpreadMembersOf`) so the two can never disagree
  // about which sources it covers.
  if (!('blocked' in staticSpreadMembersOf(context, context.types.typeAt(node.expression)))) {
    return { kind: 'operations', operations: [], edges: [] }
  }
  const source = resolveExpressionOperand(context, node.expression)
  if (!source) {
    return {
      kind: 'blocked',
      blocker: blocked(candidate.id, 'protocol', 'no normalized operation identifies the object-spread source expression value', null)
    }
  }
  const literal = node.parent
  if (!ts.isObjectLiteralExpression(literal)) {
    // Grammar-guaranteed: a `SpreadAssignment` is only ever a property of an
    // object literal. Refused by name rather than assumed, on the same
    // fail-closed footing as every other refusal here.
    return {
      kind: 'blocked',
      blocker: blocked(candidate.id, 'protocol', "an object spread's own parent is not the object literal it copies into", null)
    }
  }
  const receiverType = context.types.typeAt(literal)
  const receiverAllocationId = operationId(context.identities.nodeIdOf(literal), 'allocation', 0)
  const receiverOperand = operand(
    'receiver',
    0,
    { kind: 'result', result: semanticResultId(receiverAllocationId, 'value') },
    receiverType,
    { kind: 'provenance' }
  )
  const id = mintOperationId(context.ordinals, candidate.id, 'protocol')
  const operands = [operand('source', 0, source.source, source.type), receiverOperand]
  const operation: ProtocolOperation = {
    family: 'protocol',
    id,
    protocol: 'spread',
    step: 'next',
    caller: candidate.caller,
    operands,
    // `CopyDataProperties` returns nothing a JS consumer ever reads, but the
    // IR layer still needs a citable anchor for this operation's own lineage
    // (`ir/lower-operands.ts`'s `requireLineage`/`anchorResultOf` finds none
    // in an empty `results`) -- the same reason `producers/allocations.ts`'s
    // own property-install operations publish the RECEIVER as their result
    // even though nothing reads it either.
    results: [mintResult(id, 'value', receiverType)],
    // Unlike iterator/enumerate spread, `CopyDataProperties` on a null/undefined
    // source is a defined no-op, not a `TypeError` -- but reading an own
    // property can still invoke a getter that throws, so this stays throwing.
    completion: throwingCompletion,
    effects: { readsMutableState: true, writesMutableState: true, allocates: false, callsUserCode: true },
    evaluationOrdinal: candidate.evaluationOrdinal
  }
  return { kind: 'operations', operations: [operation], edges: valueEdgesInto(id, operands) }
}

const contributeIterationSpread = (context: ProducerContext, candidate: CensusCandidate, node: ts.SpreadElement): CandidateContribution => {
  // `...arguments` in an invocation is sourced by the CONSUMER, not here.
  // `resolveExpressionOperand` resolves an identifier's value through its
  // declaration, and the magic `arguments` binding has none, so this producer
  // reaches the `!source` refusal below and takes the whole enclosing function
  // with it -- for a spread `spread-arguments.ts` already knows how to read
  // (it calls `argumentsObjectValueAt` directly, minting the phantom rest
  // slot's own read against the invocation's candidate).
  //
  // Scoped to exactly the two parents that consumer serves: `invocations.ts`
  // routes both call and construct through `buildArgumentOperands`. An array
  // literal is deliberately NOT included -- `allocations.ts` has no
  // `arguments` case, so yielding no steps there would elide the iteration and
  // put nothing in its place, which is the same fail-closed reason the JSX
  // child spread is excluded below.
  const consumerSourcesArguments = ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)
  if (consumerSourcesArguments && isArgumentsObjectIdentifier(node.expression, context.checker)) {
    return { kind: 'operations', operations: [], edges: [] }
  }
  const source = resolveExpressionOperand(context, node.expression)
  if (!source) {
    return {
      kind: 'blocked',
      blocker: blocked(candidate.id, 'protocol', 'no normalized operation identifies the spread source expression value', null)
    }
  }
  // The two source shapes whose iteration is settled before the program runs,
  // in the two contexts that consume them without an iterator:
  //
  // - a plain `T[]`/`Array<T>` RANGE-COPIED: `[...xs, 1]` reads this exact
  //   spread element's own operand (role `spread`, `allocations.ts`) and
  //   `f(a, ...xs)` reads it under role `spread-argument`
  //   (`spread-arguments.ts`), and both end at the same `appendRange` into a
  //   freshly built array (`emit-arrays.ts`).
  // - a CLOSED TUPLE expanded positionally: `tuple-spread.ts` mints one
  //   `[[Get]]` per position and the consuming producer cites those reads
  //   directly.
  //
  // Minting iterator steps for either would publish a `get-iterator`/`next`
  // pair nobody cites, demand the iterator runtime helpers of a program that
  // performs no iteration, and -- for a tuple -- hand every position the UNION
  // of the tuple's element types, since `iterationElementType` has no
  // per-step answer to give. It measurably emitted exactly that: before the
  // call-argument half of this bypass existed, `sumRest(1, ...xs)` emitted a
  // live `gea::Iterator<double>` plus one `arrayNext()`/`done()` pair
  // alongside the `appendRange` that actually performed the spread.
  //
  // Scoped to the three parents that consume it: a JSX spread child
  // (`<div>{...kids}</div>`) is refused by `producers/jsx.ts` and has no
  // operand of its own to cite, so a bypass there would elide the steps and
  // put nothing in their place.
  const consumedWithoutIterator =
    ts.isArrayLiteralExpression(node.parent) || ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)
  if (
    consumedWithoutIterator &&
    (hasNativeIterationCursor(context, source.type) || closedTupleElementTypesOf(context, source.type) !== null)
  ) {
    return { kind: 'operations', operations: [], edges: [] }
  }
  // Everything else keeps its steps. When the source is a provably plain
  // `T[]` reaching here (a context none of the three above), those steps need
  // no dynamic `Symbol.iterator` lookup any more than a `for`-`of` over the
  // same array would (`control.ts`'s `contributeForOfIn` makes the identical
  // call): `get-method` is skipped and `get-iterator` takes the array-native
  // fast path.
  const arrayFastPath = hasNativeIterationCursor(context, source.type)
  const dynamicSource = isDynamicIterationSource(context, source.type)
  const steps = mintIteratorSteps(
    context,
    candidate,
    'iterator',
    { ...source, iterated: node.expression },
    {
      // A genuinely dynamic source resolves and calls @@iterator in the
      // runtime helper.  Keeping a synthetic `get-method` operation here
      // would require a static symbol-key operand that this source does not
      // have, then incorrectly ask `lower-protocol` to emit a native get.
      includeGetMethod: !arrayFastPath && !dynamicSource,
      // A spread element always drains its iterator to completion; there is no
      // `break` inside a spread that would trigger `IteratorClose`.
      includeClose: false,
      // The allocation/invocation consumer drains this record through its
      // gather operation. A speculative `next()` here would skip one value.
      // An ARRAY LITERAL drains whatever record this mints, through its own
      // gather step -- for a typed custom iterable (`[...new Range(1, 4)]`)
      // exactly as for a dynamic one. A speculative `next()` here would eat
      // the first value before the gather ever ran.
      includeNext: !(consumedWithoutIterator && (dynamicSource || ts.isArrayLiteralExpression(node.parent)))
    }
  )
  return { kind: 'operations', operations: steps.operations, edges: steps.edges }
}

/**
 * `SpreadElement` covers both `f(...xs)` and `[...xs]` -- the census assigns
 * one syntax kind to both contexts, and this producer treats them identically
 * because the iteration protocol they invoke does not differ by context.
 * `SpreadAssignment` is object-literal spread and is the only candidate routed
 * to `contributeObjectSpread`.
 */
export const createProtocolProducer = (context: ProducerContext): FamilyProducer => {
  const contribute = (candidate: CensusCandidate): CandidateContribution => {
    const node = candidate.node
    if (ts.isSpreadElement(node)) return contributeIterationSpread(context, candidate, node)
    if (ts.isSpreadAssignment(node)) return contributeObjectSpread(context, candidate, node)
    return {
      kind: 'blocked',
      blocker: blocked(candidate.id, 'protocol', 'protocol census produced a syntax kind this producer does not model', null)
    }
  }

  return { family: 'protocol', contribute }
}
