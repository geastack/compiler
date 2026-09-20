import type { ComponentId, FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { componentId, withoutFunctionSpecialization } from '../identity/ids.js'
import { callableOriginsOf, callableOwnPropertyWritesOf, unknownCallableOwnProperty } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { partitionAuthorityComponents } from '../semantics/model/graph.js'
import { operandOf, type SemanticResult } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type {
  DateDeclarationPolicy,
  HostBindingPolicy,
  HostNamespaceRootPolicy,
  KeyedCollectionPolicy,
  OwnershipPolicy,
  PromiseDeclarationPolicy,
  GeneratorDeclarationPolicy,
  InterfaceImplementorPolicy,
  RegExpDeclarationPolicy,
  RepresentationDeriver,
  StandardBufferPolicy,
  StringObjectDeclarationPolicy,
  ErrorDeclarationPolicy,
  FunctionDeclarationPolicy,
  ClassHeritagePolicy,
  ClassCopyPolicy,
  TypedArrayElementPolicy,
  ValueRecordPolicy
} from './derive.js'
import {
  createRepresentationDeriver,
  defaultDateDeclarationPolicy,
  defaultHostBindingPolicy,
  defaultHostNamespaceRootPolicy,
  defaultKeyedCollectionPolicy,
  defaultOwnershipPolicy,
  defaultPromiseDeclarationPolicy,
  defaultGeneratorDeclarationPolicy,
  defaultInterfaceImplementorPolicy,
  defaultRegExpDeclarationPolicy,
  defaultStandardBufferPolicy,
  defaultStringObjectDeclarationPolicy,
  defaultErrorDeclarationPolicy,
  defaultFunctionDeclarationPolicy,
  defaultClassHeritagePolicy,
  defaultTypedArrayElementPolicy,
  defaultValueRecordPolicy
} from './derive.js'
import { isArrayPatternCapable, representationKey, soleArrayPatternCapableArm, type Representation } from './model.js'
import { literalDestinationsOf } from './literal-destination.js'
import type { RepresentationConflict, SealedRepresentationPlan } from './plan.js'
import { createRepresentationPlanBuilder } from './plan.js'
import type { RepresentationViolation } from './verify.js'
import { verifyRepresentationPlan } from './verify.js'

/**
 * Turning a sealed semantic graph into a sealed representation plan.
 *
 * The order here is the mandatory publication order, and it is not an
 * implementation detail: every carrier is published as evidence first, then each
 * authority component selects once and commits, then the plan seals, then the
 * guards run. Selecting while publication is still open is what creates the
 * window in which one consumer reads a weaker answer than another.
 *
 * Components commit independently. A component whose carriers conflict commits
 * nothing and is reported, but it does not veto the rest of the program -- that
 * is the difference between a compiler that reports one defect and a compiler
 * that reports "nothing worked".
 */

export interface RepresentationPublication {
  readonly plan: SealedRepresentationPlan
  /** Components that committed, in deterministic order. */
  readonly committed: readonly ComponentId[]
  /** Components that selected nothing because their carriers disagreed. */
  readonly blocked: readonly ComponentId[]
  readonly conflicts: readonly RepresentationConflict[]
  /** The complete guard violation set; empty means the plan is materializable. */
  readonly violations: readonly RepresentationViolation[]
  /**
   * The deriver that produced this plan, handed out rather than rebuilt.
   *
   * A carrier is a function of a structural type *and* the policies this
   * compilation supplied -- which declared types are host handles, which are
   * typed-array views. Both policies come from the frontend's own census, so a
   * deriver constructed anywhere else defaults them to `() => null` and answers
   * a different question: measured on one 14-line fixture, a default-policy
   * deriver disagreed with this one about **10 of 32** structural types,
   * reading `typed-array(float32)` as `native-record-ref` and
   * `native-handle(ArrayBuffer@1)` as `native-record-ref`.
   *
   * Emission needs shape-keyed answers the plan does not index by shape (a
   * declared type's body is resolved from the structural table at emission --
   * see `records.ts`), so it has to ask a deriver. It must be *this* one. Two
   * instances are not "cheap and identical"; they are two authorities over
   * what a type physically is, and the drift between them is silent.
   */
  readonly deriver: RepresentationDeriver
}

const resultsOfComponent = (graph: SemanticGraph, members: readonly OperationId[]): readonly SemanticResultId[] =>
  members.flatMap((member) => {
    const operation = graph.operations.get(member)
    return operation ? operation.results.map((result) => result.id) : []
  })

/**
 * The element type a minted iterator record declares it will yield, read back
 * out of the record's own interned shape.
 *
 * `producers/protocol.ts`'s `iteratorMethodAndRecordTypes` builds that shape
 * from ONE element type: `{ next(): { value: E, done: boolean } }`. So `E` is
 * recoverable from the record, and recovering it is not a second derivation --
 * it is reading back the exact id the producer already committed to, which is
 * also the id the matching `next` step's own `value` result carries. That
 * matters for the `Map` case below: a pair's carrier is a RECORD keyed by its
 * shape id, and a shape id minted here rather than read back would name a
 * different C++ struct from the one the loop variable is destructured out of.
 *
 * `null` when the record is not that shape -- an `async-iterator`'s record is
 * interned `unresolved` on purpose, and a caller that cannot read an element
 * type must publish no cursor rather than guess one.
 */
const iteratorRecordElementTypeOf = (
  structuralTypes: SemanticGraph['structuralTypes'],
  recordType: StructuralTypeId
): StructuralTypeId | null => {
  const record = structuralTypes.get(recordType)?.shape
  if (record?.kind !== 'object') return null
  const next = record.members.find((member) => member.key.kind === 'string' && member.key.value === 'next')
  if (!next) return null
  const signature = structuralTypes.get(next.type)?.shape
  if (signature?.kind !== 'signature') return null
  const call = signature.call[0]
  if (!call) return null
  const step = structuralTypes.get(call.result)?.shape
  if (step?.kind !== 'object') return null
  return step.members.find((member) => member.key.kind === 'string' && member.key.value === 'value')?.type ?? null
}

/**
 * The `[K, V]` pair carrier a `Map`'s cursor yields, or `null` when this
 * compiler cannot lay that pair out.
 *
 * Strict on purpose, and stricter than the census side that lets a `Map`
 * source skip the `@@iterator` lookup (`producers/shared.ts`'s
 * `isNativeIterableMapType`): the pair must derive to a RECORD whose fields
 * are exactly "0" and "1", carrying the collection's own key and value
 * carriers. Anything else -- a `Map` whose value carrier is `unresolved`, an
 * element type the checker answered as something other than the pair -- means
 * the cursor and the destructuring that reads it would disagree about the
 * struct, so no cursor is published and the program refuses at preflight on
 * the unclaimed `protocol:iterator:next:record` instead.
 */
/**
 * The cursor carrier for one of the four fixed-storage walks (`Array`/`Set`/
 * `string`/`Map`) or the `for`-`in` enumerator/static-tuple walk -- every
 * `iterator(E)` this file publishes except the generator's own (`derive.ts`'s
 * `GeneratorDeclarationPolicy`). None of them ever resumes with a value or
 * completes with one (`%ArrayIteratorPrototype%` and its siblings define no
 * `.return`/`.throw` at all, ECMA-262 27.1.2), so `resume`/`completion` are
 * always the cursor's own "stores nothing" carrier and `source` always says
 * so -- see the `iterator` kind's own doc comment (`model.ts`) for why that
 * tag exists and what reads it.
 */
const sequenceIterator = (element: Representation): Representation => ({
  kind: 'iterator',
  element,
  resume: { kind: 'undefined' },
  completion: { kind: 'undefined' },
  source: 'sequence'
})

const mapPairCursorElementOf = (
  structuralTypes: SemanticGraph['structuralTypes'],
  operation: SemanticOperation,
  result: SemanticResult,
  source: Extract<Representation, { kind: 'keyed-collection' }>,
  deriver: RepresentationDeriver
): Representation | null => {
  if (source.family !== 'map' || source.value === null) return null
  const elementType = iteratorRecordElementTypeOf(structuralTypes, result.type)
  if (elementType === null) return null
  const pair = deriver.derive(elementType)
  if (pair.kind !== 'record' || pair.fields.length !== 2) return null
  const [first, second] = pair.fields
  if (!first || !second || first.key !== '0' || second.key !== '1') return null
  if (representationKey(first.value) !== representationKey(source.key)) return null
  if (representationKey(second.value) !== representationKey(source.value)) return null
  // `operation` is unread beyond the caller's own family/step check; naming it
  // keeps this helper's signature the same shape as its sibling above.
  void operation
  return pair
}

/**
 * The native carrier a protocol producer's private iterator-record gets. A
 * `for`-`in` record is always a string-key cursor; `for`-`of` (including
 * spread/`yield*`) gets one when its source's iteration is settled before the
 * program runs -- the fast path `contributeForOfIn`/`mintIteratorSteps`
 * (control.ts, protocol.ts) exist for.
 *
 * `derive.ts` cannot answer this on its own: an `IteratorRecord` is a
 * spec-level bookkeeping value with no TypeScript type at all, so its own
 * structural type is (correctly) `unresolved`, and `deriveShape`'s "one shape,
 * one carrier" rule has nothing to derive from. What decides the carrier here
 * is not the record's *own* shape but the *operation* that produces it: a
 * `get-iterator` step. Enumeration decides that from the protocol itself.
 * Ordinary iteration decides it from an `array-object`, `string`, `Set<T>` or
 * `Map<K, V>` source -- ECMA-262 23.1.5, 22.1.3.36, 24.2.3.10 and 24.1.5.1
 * are each a fixed walk over storage already in hand. Every other ordinary
 * iterator source is left alone: the result keeps its honest unresolved or
 * structural carrier and the program is refused at preflight, never boxed.
 */
const nativeCursorIteratorOf = (
  structuralTypes: SemanticGraph['structuralTypes'],
  operation: SemanticOperation | undefined,
  result: SemanticResult,
  deriver: RepresentationDeriver
): Representation | null => {
  if (!operation || operation.family !== 'protocol') return null
  if (operation.step !== 'get-iterator' || result.role !== 'iterator-record') return null
  const target = operandOf(operation, 'target')
  if (!target) return null
  // `for`-`in` never produces the synthetic `{ next }` method record used by
  // the general iterator protocol. Its producer has no get-method step at all:
  // `get-iterator` is the backend's own key-snapshot operation and `next`
  // advances that snapshot. Therefore the result contract is always the one
  // native `gea::Iterator<string>` cursor, even when the receiver itself is
  // unsupported and its get-iterator obligation correctly refuses emission.
  //
  // Keeping this independent of the receiver carrier is load-bearing for an
  // optional receiver: a possibly-absent TABLE walks its keys or, absent, an
  // empty cursor (`emit-iterator.ts`'s `enumerateIfPresent` -- ECMA-262
  // 14.7.5.5 runs the loop zero times), while an optional record such as
  // Fastify's `schema.properties` stays honestly keyed `optional(record)`
  // at its get-iterator site, and neither's paired next step fabricates the
  // unreachable `protocol:enumerate:next:record` obligation. The target key,
  // not a false result carrier, is the fail-closed boundary.
  if (operation.protocol === 'enumerate') {
    return sequenceIterator({ kind: 'string' })
  }
  if (operation.protocol !== 'iterator') return null
  const derived = deriver.derive(target.type)
  // An ABSENT source keeps its payload's cursor. Iterating `undefined` is a
  // runtime `TypeError` (ECMA-262 7.4.2 `GetIterator` calls `GetMethod` on it),
  // not a static impossibility, so `T[] | undefined` walks exactly the storage
  // `T[]` walks and the absence is one separate presence assertion the backend
  // spells in front of the cursor (`targets/cpp/emit-iterator.ts`). Unwrapped
  // HERE, once, ahead of the whole dispatch, so every payload shape below --
  // array, string, generator, tuple record, `Set`, `Map` -- inherits it for
  // free rather than each growing an absent-shaped twin.
  //
  // `producers/shared.ts`'s `presentIterationArm` is the same fact asked of
  // the structural type, which is what decides that the loop takes the fast
  // path at all; the two must agree, and they agree because `optionalOf`
  // builds this wrapper for exactly the unions that helper admits (and
  // COLLAPSES it for the three carriers that hold their own absence, so a
  // `class-ref`, a `native-handle` and the box never arrive wrapped).
  const source = derived.kind === 'optional' ? derived.payload : derived
  if (source.kind === 'array-object') return sequenceIterator(source.element)
  // A `string`'s own iteration (ECMA-262 22.1.3.36) is the third fixed walk
  // with no `@@iterator` lookup behind it, and the one whose snapshot is
  // EXACT rather than approximate: a String is an immutable primitive, so the
  // step sequence cannot change under the loop. Each step yields one code
  // point, which is itself a string -- hence `iterator(string)`, an element
  // carrier equal to the source's own.
  if (source.kind === 'string') return sequenceIterator({ kind: 'string' })
  // A source that is ALREADY a cursor -- a `Generator<T, ...>`, which
  // `derive.ts`'s `GeneratorDeclarationPolicy` carries as `iterator(T)` -- is
  // its own iterator record: ECMA-262 27.5.1.2 defines
  // `%GeneratorPrototype%[@@iterator]` as returning `this`, so `GetIterator`
  // over one publishes the source's own carrier and `emit-iterator.ts` renders
  // the step as the copy that is.
  if (source.kind === 'iterator') return source
  // A `Set<T>`'s own iteration (ECMA-262 24.2.3.10) is the same fixed walk
  // over the collection's own entries -- no `@@iterator` lookup, no dynamic
  // method call -- so it publishes the same cursor over the set's own key
  // carrier. The four keyed-collection families are not one: neither WEAK
  // family iterates at all (24.3/24.4), a `Set` yields its key, and a `Map`
  // yields a `[K, V]` PAIR whose record carrier is read back out of the
  // iterator record's own declared element type (`mapPairCursorElementOf`)
  // rather than assembled here, so the cursor and the destructuring that reads
  // it name one struct.
  // A fixed-arity tuple, whose storage is a positional struct rather than any
  // container with a walk of its own. It belongs beside the four sources above
  // for the same reason they belong to each other -- the step sequence is
  // settled before the program runs, here more completely than for any of
  // them, because the LENGTH is a compile-time fact -- and
  // `targets/cpp/emit-iterator.ts`'s `emitStaticTupleIterator` unrolls the
  // positions into the cursor's own reader.
  //
  // Gated on the absence of a `method` operand rather than on the record's
  // shape alone: that operand is exactly the signal that
  // `producers/shared.ts`'s `hasNativeIterationCursor` did NOT take this
  // source down the fast path, and a record reaching a general-protocol
  // `get-iterator` has a real `[Symbol.iterator]` to call -- publishing a
  // cursor over it would replace that call with a walk of the struct's own
  // fields, which is a different program.
  //
  // The element carrier comes from the iterator record's own declared element
  // type, not from the fields, so the cursor and the `next` value it yields
  // are one answer rather than two; the emitter re-checks that every position
  // really does carry it and refuses rather than publishing a cursor whose
  // element type is not the type of what it reads.
  if (source.kind === 'record' && !operandOf(operation, 'method')) {
    const positional =
      source.fields.length > 0 && source.fields.every((field, position) => field.key === String(position) && field.required)
    if (!positional) return null
    const elementType = iteratorRecordElementTypeOf(structuralTypes, result.type)
    return elementType === null ? null : sequenceIterator(deriver.derive(elementType))
  }
  if (source.kind !== 'keyed-collection') return null
  if (source.family === 'set') return sequenceIterator(source.key)
  const pair = mapPairCursorElementOf(structuralTypes, operation, result, source, deriver)
  return pair ? sequenceIterator(pair) : null
}

/**
 * The carrier an ARRAY BINDING PATTERN's own source step gets when its base is
 * a `Set<T>` or a `string`.
 *
 * `const [a, b] = set` is not a cursor walk in this backend: the pattern reads
 * its source BY POSITION (`ir/lower-destructuring.ts` reads element `n` and
 * range-copies a rest), which needs random access a cursor does not offer. So
 * the source step publishes an `array-object` of the source's own element
 * carrier and the lowering materializes exactly that -- the same snapshot
 * `[...set]`/`[...str]` already build, through the same `appendSetRange`/
 * `appendCodePointRange` range copy.
 *
 * That snapshot is where this backend and ECMA-262 7.4 differ, and the
 * difference is stated rather than hidden: the specification's
 * `ArrayBindingPattern` drains only as many steps as the pattern binds (plus
 * one `IteratorClose`), while this materializes the whole source first. It is
 * unobservable for these two sources -- a String is immutable, and neither a
 * Set walk nor a String walk can run user code that could observe the extra
 * steps -- and it is exactly why this is scoped to them. A `Map` is NOT
 * included even though its own `for`-`of` cursor is: a pattern's source step
 * publishes the PATTERN's type, not a minted iterator record, so there is no
 * `[K, V]` pair shape id to read back here (`mapPairCursorElementOf` above
 * needs one), and publishing a snapshot whose element carrier this cannot name
 * would be the disagreement the whole override exists to avoid.
 */
const patternSourceSnapshotOf = (
  structuralTypes: SemanticGraph['structuralTypes'],
  regexp: RegExpDeclarationPolicy,
  operation: SemanticOperation | undefined,
  result: SemanticResult,
  deriver: RepresentationDeriver
): Representation | null => {
  if (!operation || operation.family !== 'destructuring') return null
  if (operation.form !== 'array-pattern' || result.role !== 'iterator-record') return null
  const base = operandOf(operation, 'base')
  if (!base) return null
  const source = deriver.derive(base.type)
  if (source.kind === 'string') return { kind: 'array-object', element: { kind: 'string' }, ownership: 'shared-refcount', extension: null }
  // A `RegExpExecArray` (`const [, major, minor = '0'] = re.exec(text)`,
  // tsc's semver.ts) is the third source the same argument admits: its
  // capture slots are storage the runtime already holds, and a snapshot of
  // them can run no user code. The element is `optional(string)` and not the
  // `string` the interface's `extends Array<string>` claims, because ECMA-262
  // 22.2.7.2 puts `undefined` in a non-participating group's slot and the
  // pattern's defaults are written to fire on exactly that -- the same
  // honesty `emit-prototype-regexp.ts`'s `capturedOrAbsent` keeps for an
  // indexed read. A `RegExpMatchArray` is not admitted: its global-flag
  // answer is a list of whole matches with no capture slots at all.
  const shape = structuralTypes.get(base.type)?.shape
  if (shape?.kind === 'declared' && regexp.forDeclaration(shape.declaration)?.kind === 'exec-result') {
    const element: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
    return { kind: 'array-object', element, ownership: 'shared-refcount', extension: null }
  }
  if (source.kind !== 'keyed-collection' || source.family !== 'set') return null
  return { kind: 'array-object', element: source.key, ownership: 'shared-refcount', extension: null }
}

/**
 * An array pattern's own shared source step, published as the PAYLOAD it
 * actually reads positionally -- unwrapping `optional` (a position past a
 * plain array's own length, or fed by an enclosing pattern's own absent-
 * capable element read) and, once unwrapped, picking `soleArrayPatternCapableArm`
 * of whatever tagged union remains (`number | number[]`, a plain array's
 * element that is itself a union, only one arm of which supports positional
 * reads at all).
 *
 * Without this, a nested array-assignment pattern reading such a position
 * (`[a, [b, c]] = row` for `row: (number | number[])[]`) publishes its own
 * shared source step as the wrapped `optional(tagged-union(...))` itself --
 * a carrier the array/tuple fast path in `ir/lower-destructuring.ts` does not
 * read at all, so the position's own runtime-helper obligation censused
 * "missing" no matter how faithfully the rest of the pipeline modeled the
 * read. Publishing the picked payload here is what lets `lowerArrayPatternSource`
 * render the two runtime facts an `optional(tagged-union(...))` source
 * actually carries -- the value may be absent (ECMA-262 7.4.2 `GetIterator`
 * throws on `undefined`/`null`), and the union's OTHER arm is a real value
 * this pattern cannot iterate (the same clause throws on a non-iterable) --
 * as two explicit runtime checks in front of the SAME positional fast path
 * every other array-pattern source already takes, rather than inventing a
 * second, unclaimed carrier for the manifest to refuse.
 *
 * A plain, non-union `optional(array-object)`/`optional(record)` source (no
 * arm to pick, only a presence check to run) is unwrapped by the identical
 * path: `soleArrayPatternCapableArm` answers `null` for a non-tagged-union
 * payload, and `isArrayPatternCapable` already being true for it is what
 * publishes the bare payload outright.
 */
const patternSourceArmOf = (
  operation: SemanticOperation | undefined,
  result: SemanticResult,
  deriver: RepresentationDeriver
): Representation | null => {
  if (!operation || operation.family !== 'destructuring') return null
  if (operation.form !== 'array-pattern' || result.role !== 'iterator-record') return null
  const base = operandOf(operation, 'base')
  if (!base) return null
  const source = deriver.derive(base.type)
  const isOptional = source.kind === 'optional'
  const unwrapped = isOptional ? source.payload : source
  if (isArrayPatternCapable(unwrapped)) {
    // Already directly capable once unwrapped -- only a genuine CHANGE
    // (dropping the `optional` wrapper) counts as an override; a source that
    // was already bare (array-object/record/uniform tuple-union, no
    // wrapping at all) is left to the ordinary structural derivation, which
    // already agrees, rather than restating an identical answer as one.
    return isOptional ? unwrapped : null
  }
  const sole = soleArrayPatternCapableArm(unwrapped)
  return sole ? sole.arm : null
}

/** Method values read dynamically retain their runtime call frame, including this and rest arguments. */
const dynamicCallableReadOf = (
  operation: SemanticOperation | undefined,
  result: SemanticResult,
  deriver: RepresentationDeriver,
  callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>,
  dynamicCallables: ReadonlySet<FunctionId>
): Representation | null => {
  if (!deriver.dynamicFallback || operation?.family !== 'property' || operation.internalMethod !== 'get') return null
  const receiver = operandOf(operation, 'receiver')
  const receiverOrigin = receiver?.source.kind === 'result' ? callableOrigins.get(receiver.source.result) : undefined
  const receiverIsExactDynamicCallable = receiverOrigin !== undefined && dynamicCallables.has(withoutFunctionSpecialization(receiverOrigin))
  if (!receiver || (!receiverIsExactDynamicCallable && deriver.derive(receiver.type).kind !== 'dynamic')) return null
  const carrier = deriver.derive(result.type)
  if (
    carrier.kind === 'function' ||
    carrier.kind === 'function-family' ||
    carrier.kind === 'function-value-family' ||
    carrier.kind === 'function-value-dispatch'
  )
    return { kind: 'dynamic', reason: 'opt-in-fallback' }
  return null
}

/**
 * A read of a Function member the program itself overwrote on that object.
 *
 * `direct.call = replacement` installs an own `call`; every later
 * `direct.call(...)` finds THAT, not `Function.prototype.call`, but the
 * checker keeps typing the read as the builtin (or, for the three shapes
 * TypeScript recognizes as assignment declarations, as the installed
 * function's own signature) -- either way a convention the emitted read does
 * not produce, because `callableBuiltinRecipeKey` already routes exactly this
 * read through `callableDynamicGet` and a `gea::Value`.
 *
 * `callableOwnPropertyWritesOf` is the plan-free half of the one mutation
 * census; the certify stage asks the fuller `callableBuiltinResolution` of the
 * same scan. A write whose target object the graph cannot name is absent here
 * and present there, so this override is a strict SUBSET: it never boxes a
 * read the renderer would have spelled statically.
 */
const shadowedCallableBuiltinReadOf = (
  graph: SemanticGraph,
  operation: SemanticOperation | undefined,
  callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
): Representation | null => {
  if (operation?.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) return null
  const key = operandOf(operation, 'key')
  if (key?.source.kind !== 'constant' || key.source.literal !== 'string') return null
  const member = key.source.text
  if (member !== 'call' && member !== 'apply' && member !== 'bind') return null
  const receiver = operandOf(operation, 'receiver')
  if (receiver?.source.kind !== 'result') return null
  const origin = callableOrigins.get(receiver.source.result)
  if (origin === undefined) return null
  const own = callableOwnPropertyWritesOf(graph, callableOrigins).get(withoutFunctionSpecialization(origin))
  if (!own || (!own.has(member) && !own.has(unknownCallableOwnProperty))) return null
  return { kind: 'dynamic', reason: 'shadowed-callable-builtin' }
}

/** A semantic value proven to be one exact Function object selected for fallback storage. */
const dynamicCallableValueOf = (
  result: SemanticResult,
  callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>,
  dynamicCallables: ReadonlySet<FunctionId>
): Representation | null => {
  const origin = callableOrigins.get(result.id)
  return origin !== undefined && dynamicCallables.has(withoutFunctionSpecialization(origin))
    ? { kind: 'dynamic', reason: 'opt-in-fallback' }
    : null
}

/**
 * CommonJS module records are the one explicitly dynamic host boundary here.
 * The checker authenticated the wrapper declaration and normalization carried
 * that fact onto the operation; no arbitrary typed value reaches this route.
 */
const commonJsBoundaryOf = (graph: SemanticGraph, operation: SemanticOperation | undefined): Representation | null => {
  if (operation?.family === 'invocation' && operation.commonJsRequire !== undefined && operation.commonJsRequire.nativeRecord !== true)
    return { kind: 'dynamic', reason: 'commonjs-module-boundary' }
  if (
    operation?.family === 'binding' &&
    operation.commonJs !== undefined &&
    (operation.commonJs.global !== 'module' || operation.commonJs.nativeRecord !== true)
  )
    return { kind: 'dynamic', reason: 'commonjs-module-boundary' }
  // `module.exports` is a wrapper-cell read, not an ordinary read from the
  // declared shape of `module`.  Follow its normalized receiver edge instead
  // of asking the checker again: the only admitted route is the authenticated
  // `module` binding above and the literal property key the property operation
  // already carries.  A user object that merely has an `exports` field cannot
  // satisfy both facts and stays on its normal typed representation path.
  // A write THROUGH the wrapper cell publishes its result from the receiver it
  // wrote into (`lower-property.ts`'s `set`, rendered as the cell after
  // `reflectSet`), so the result crosses the same boundary the receiver did.
  // Derived structurally it was `module`'s declared `{ exports }` record, and
  // `module.exports = { ... }` emitted `gea::Ref<record> = gea::Value`.
  if (operation?.family === 'property' && operation.internalMethod === 'set') {
    const receiver = operandOf(operation, 'receiver')
    if (receiver?.source.kind === 'result') {
      const producerId = graph.results.get(receiver.source.result)
      const producer = producerId === undefined ? undefined : graph.operations.get(producerId)
      if (
        producer?.family === 'binding' &&
        producer.commonJs !== undefined &&
        (producer.commonJs.global !== 'module' || producer.commonJs.nativeRecord !== true)
      )
        return { kind: 'dynamic', reason: 'commonjs-module-boundary' }
    }
  }
  if (operation?.family === 'property' && operation.internalMethod === 'get') {
    const receiver = operandOf(operation, 'receiver')
    const key = operandOf(operation, 'key')
    if (
      receiver?.source.kind === 'result' &&
      key?.source.kind === 'constant' &&
      key.source.literal === 'string' &&
      key.source.text === 'exports'
    ) {
      const producerId = graph.results.get(receiver.source.result)
      const producer = producerId === undefined ? undefined : graph.operations.get(producerId)
      if (producer?.family === 'binding' && producer.commonJs?.global === 'module' && producer.commonJs.nativeRecord !== true)
        return { kind: 'dynamic', reason: 'commonjs-module-boundary' }
    }
  }
  return null
}

export const publishRepresentations = (
  graph: SemanticGraph,
  ownership: OwnershipPolicy = defaultOwnershipPolicy,
  // Which declared types are host handles rather than program-defined records.
  // It reaches the deriver and nothing else: a binding changes what a carrier
  // *is*, never how a carrier is selected or committed, so no other stage here
  // needs to know one exists.
  binding: HostBindingPolicy = defaultHostBindingPolicy,
  // Which declared types are typed-array views rather than program-defined
  // records -- the same shape of policy as `binding`, kept a separate
  // parameter because a typed array is not a host protocol (nothing installs
  // it) and answers a different question than "which protocol".
  elements: TypedArrayElementPolicy = defaultTypedArrayElementPolicy,
  // Which declared type is the standard library's own `Promise<T>` --
  // narrower than `elements` (one declaration, not eight), kept as its own
  // parameter for the same reason: it answers "is this THE ambient
  // `Promise`", not "which protocol/which width".
  promise: PromiseDeclarationPolicy = defaultPromiseDeclarationPolicy,
  // Which declared types are the standard `Map`/`Set`/`WeakMap`/`WeakSet`
  // interfaces -- the same shape of policy as `elements`, and separate for the
  // same reason: a keyed collection is not a host protocol and not a typed
  // array, it is its own core-ECMAScript carrier family.
  collections: KeyedCollectionPolicy = defaultKeyedCollectionPolicy,
  // Which declared types are the standard `ArrayBuffer`/`DataView` -- the same
  // shape of policy as `collections`, separate for the same reason, and
  // consulted at the same point. See `StandardBufferPolicy` (policies.ts).
  buffers: StandardBufferPolicy = defaultStandardBufferPolicy,
  // What carries a host NAMESPACE ROOT -- the one policy here keyed by
  // structural type rather than by declaration, because a root's value type is
  // routinely an intersection or an anonymous shape with no declaration to key
  // by. See `HostNamespaceRootPolicy` (policies.ts).
  namespaceRoots: HostNamespaceRootPolicy = defaultHostNamespaceRootPolicy,
  // Which declared type is the standard library's own `Date`, and the C++ type
  // one is carried in -- core ECMAScript with a compiler-owned native layout,
  // the same category as `promise` above. See `DateDeclarationPolicy`.
  date: DateDeclarationPolicy = defaultDateDeclarationPolicy,
  // Which declared type is the standard `Generator<T, TReturn, TNext>` -- one
  // declaration, its own parameter for the same reason `promise` is one. See
  // `GeneratorDeclarationPolicy` (policies.ts).
  generator: GeneratorDeclarationPolicy = defaultGeneratorDeclarationPolicy,
  // Which declared types are the standard `RegExp`/`RegExpExecArray`/
  // `RegExpMatchArray`, and the target's spelling for each -- separate from
  // `binding` for the reason stated on `RegExpDeclarationPolicy`: a regular
  // expression is core ECMAScript with a compiler-owned native layout, in the
  // same category as `promise` and `collections` above, not something a host
  // installs.
  regexp: RegExpDeclarationPolicy = defaultRegExpDeclarationPolicy,
  // Which declared type is the standard library's own `String` WRAPPER-OBJECT
  // interface -- one declaration, its own parameter for the same reason
  // `date` is one. See `StringObjectDeclarationPolicy` (policies.ts).
  stringObject: StringObjectDeclarationPolicy = defaultStringObjectDeclarationPolicy,
  // Which declared type is the bare `Function` interface -- one declaration,
  // its own parameter for the same reason `generator` is one. See
  // `FunctionDeclarationPolicy` (policies.ts).
  functionType: FunctionDeclarationPolicy = defaultFunctionDeclarationPolicy,
  // Which classes each class inherits from, transitively -- read by the
  // deriver's intersection reduction. See `ClassHeritagePolicy` (policies.ts).
  heritage: ClassHeritagePolicy = defaultClassHeritagePolicy,
  // Which object types may be carried BY VALUE -- see
  // `representation/value-records.ts`. Like `binding`, it reaches the deriver
  // and nothing else: it changes what a carrier IS, never how one is selected.
  valueRecords: ValueRecordPolicy = defaultValueRecordPolicy,
  // The one class a program declares as an interface's implementation -- see
  // `InterfaceImplementorPolicy` (policies.ts). Like `heritage`, it reaches
  // the deriver and nothing else.
  implementors: InterfaceImplementorPolicy = defaultInterfaceImplementorPolicy,
  errors: ErrorDeclarationPolicy = defaultErrorDeclarationPolicy,
  dynamicFallback = false,
  dynamicFallbackTypes: ReadonlySet<StructuralTypeId> = new Set(),
  dynamicFallbackCallables: ReadonlySet<FunctionId> = new Set(),
  dynamicWrittenTypes: ReadonlySet<StructuralTypeId> = new Set(),
  // The copies of every generic class whose copies can differ in layout; see
  // `ClassCopyPolicy` (policies.ts) and the deriver's `physicalClassDeclarationOf`.
  classCopies?: ClassCopyPolicy
): RepresentationPublication => {
  const callableOrigins = callableOriginsOf(graph)
  // The deriver may recover a boxed callable's declaration-owned frame only
  // from this exact semantic allocation index. A StructuralTypeId is not an
  // identity: unrelated same-signature functions intentionally share one.
  const dynamicCallableShapes = new Map<FunctionId, StructuralTypeId>()
  const conflictingCallableShapes = new Set<FunctionId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'allocation' || operation.allocated !== 'function-object' || operation.callable === null) continue
    // Every function-object allocation under fallback, not only the ones
    // `dynamicFallbackCallables` names. That set decides which callable VALUES
    // are boxed and must stay exactly as narrow as it is; this map answers a
    // different question -- what frame a body binds when it runs -- and the
    // answer is a fact about the DECLARATION whichever carrier the value ended
    // up in (`projection/abi.ts` says so where it reads this back). A function
    // handed to `new Proxy(fn, ...)` is boxed for a reason that has nothing to
    // do with a mutated `.prototype`, and its body was refused a calling
    // convention it had stated perfectly well in its own parameter list.
    if (!dynamicFallback) continue
    const previous = dynamicCallableShapes.get(operation.callable)
    if (previous !== undefined && previous !== operation.shape) {
      conflictingCallableShapes.add(operation.callable)
      dynamicCallableShapes.delete(operation.callable)
      continue
    }
    if (!conflictingCallableShapes.has(operation.callable)) dynamicCallableShapes.set(operation.callable, operation.shape)
  }
  const deriver = createRepresentationDeriver(
    graph.structuralTypes,
    ownership,
    binding,
    elements,
    promise,
    collections,
    buffers,
    namespaceRoots,
    date,
    generator,
    regexp,
    stringObject,
    functionType,
    heritage,
    valueRecords,
    implementors,
    errors,
    dynamicFallback,
    dynamicFallbackTypes,
    dynamicCallableShapes,
    dynamicWrittenTypes,
    classCopies
  )
  const builder = createRepresentationPlanBuilder()
  // A fresh object literal whose one consumer is a declared cell is minted as
  // that cell's record (`literal-destination.ts`).
  const literalDestinations = literalDestinationsOf(graph, deriver)

  // Evidence for every published result, including the ones that derive to
  // `unresolved`. Withholding those would leave the guards with nothing to fire
  // on, and a missing row reads downstream as "not reached" rather than "not
  // selected" -- the two failures need to stay distinguishable.
  for (const [resultId, operationId] of graph.results) {
    const operation = graph.operations.get(operationId)
    const result = operation?.results.find((candidate) => candidate.id === resultId)
    if (!result) continue
    // A result the array fast path claims gets an `exact` override below; the
    // structural-derivation row for that same coordinate is published at
    // `conservative` strength instead of `exact` so the two do not read as a
    // conflict (`plan.ts`'s `selectFrom`: two `exact` rows that disagree are a
    // conflict, one `exact` plus one `conservative` is simply an override).
    // Every other result is completely unaffected -- `override` is `null` for
    // all of them, and this degrades to exactly the unconditional `exact`
    // publish this loop always did.
    const override =
      commonJsBoundaryOf(graph, operation) ??
      shadowedCallableBuiltinReadOf(graph, operation, callableOrigins) ??
      dynamicCallableValueOf(result, callableOrigins, dynamicFallbackCallables) ??
      dynamicCallableReadOf(operation, result, deriver, callableOrigins, dynamicFallbackCallables) ??
      nativeCursorIteratorOf(graph.structuralTypes, operation, result, deriver) ??
      patternSourceSnapshotOf(graph.structuralTypes, regexp, operation, result, deriver) ??
      patternSourceArmOf(operation, result, deriver) ??
      literalDestinations.get(resultId) ??
      null
    // A `binding` operation's result is not a transient expression value --
    // it *is* the cell (`initialize`/`declare` introduce it, `read`/`write`
    // observe or mutate it), which is exactly the "value is actually kept"
    // case `primitives.ts`'s `storedCarrier` doc names alongside a record
    // field or array element. `deriveStored` already gets applied to every
    // *other* stored position (`abiOf`'s parameter slots, record fields,
    // array elements, all via this file's `deriver.deriveStored`) -- a
    // binding cell was the one stored position this generic loop still ran
    // through bare `derive`, so a `void`-typed cell (including a `never`-typed
    // one, which derives the same carrier) kept `{kind:'void'}` here while
    // the ABI computed for the very same declared type used `undefined`,
    // producing a spurious "bound as void but the ABI declares undefined"
    // blocker for a cell that never disagreed about anything -- only this
    // loop's own two call sites did.
    //
    // A `property` operation's result is the same kind of stored read: `.foo`
    // and `[i]` (census.ts assigns this one family to both node kinds) name a
    // field or element that is already sitting in a record/array, not a
    // completion this expression produces fresh. The checker can still type
    // that read bare `void` -- an unnarrowed `IteratorResult<T, void>.value`
    // narrows to exactly `void` once a preceding `done === true` check in the
    // same `&&`/`if` discriminates the arm, per ordinary control-flow
    // narrowing -- and bare `derive` handed that a `{kind:'void'}` carrier no
    // emitter can define storage for, because nothing about a *read* position
    // is discardable the way a bare statement's own value is. `deriveStored`
    // collapses it to `{kind:'undefined'}`, the same answer this same field
    // gets from every arm where the checker did not narrow it away.
    builder.publish({
      result: resultId,
      representation:
        operation?.family === 'binding' || operation?.family === 'property'
          ? deriver.deriveStored(result.type)
          : deriver.derive(result.type),
      strength: override ? 'conservative' : 'exact',
      producer: 'structural-derivation',
      // Structural derivation answers from one shape, so it never produces the
      // two co-equal answers a closed family is there to reconcile.
      joinsClosedFamily: false
    })
    if (override) {
      builder.publish({
        result: resultId,
        representation: override,
        strength: 'exact',
        producer:
          override === literalDestinations.get(resultId)
            ? 'literal-destination'
            : commonJsBoundaryOf(graph, operation)
              ? 'commonjs-module-boundary'
              : shadowedCallableBuiltinReadOf(graph, operation, callableOrigins)
                ? 'shadowed-callable-builtin'
                : dynamicCallableValueOf(result, callableOrigins, dynamicFallbackCallables)
                  ? 'dynamic-callable-identity'
                  : dynamicCallableReadOf(operation, result, deriver, callableOrigins, dynamicFallbackCallables)
                    ? 'dynamic-call-frame'
                    : 'protocol-array-fast-path',
        joinsClosedFamily: false
      })
    }
  }

  const committed: ComponentId[] = []
  const blocked: ComponentId[] = []
  const conflicts: RepresentationConflict[] = []

  for (const members of partitionAuthorityComponents(graph)) {
    const representative = members[0]
    if (!representative) continue
    const id = componentId(representative)
    const found = builder.commitComponent(id, resultsOfComponent(graph, members))
    if (found.length > 0) {
      blocked.push(id)
      conflicts.push(...found)
      continue
    }
    committed.push(id)
  }

  const plan = builder.seal()
  return { plan, committed, blocked, conflicts, violations: verifyRepresentationPlan(plan), deriver }
}
