import type { FunctionId } from '../../identity/ids.js'
import type {
  GetIteratorOperation,
  IteratorCloseOperation,
  IteratorDoneOperation,
  IteratorNextOperation,
  IrBlockId,
  IrBody,
  IrIteratorCloseRegion,
  IrOperand
} from '../../ir/model.js'
import { representationKey, type CallableAbi, type RecordField, type Representation } from '../../representation/model.js'
import { nativeEnumerationPlanOf, type NativeEnumerationPlan } from '../../ir/native-enumeration.js'
import type { LazySplit } from '../../ir/lazy-splits.js'
import { createCppEmitBlockedError, defineValue, operandText, paddedArguments, suspendsInPlace, type EmitContext } from './emit-context.js'
import { receiverArgumentText } from './emit-callable.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import {
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppBodyName,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn,
  cppUndefinedValue
} from './types.js'
import { alignedValueText } from './emit-narrowing.js'
import { dispatchedLeafExpression, unionPropertyLeaves } from './emit-union-properties.js'
import { recordAccessorsOfShape, recordFieldsOfShape } from './records.js'
import { renderTryRegion, type RegionRendering } from './emit-exceptions.js'
import { awaitTickText, awaitedText, coroutineAwaitStatements } from './prototype/emit-prototype-promise.js'
import { accessorEnvironmentArguments } from './emit-properties.js'

/**
 * What `renderIteratorCloseRegion` needs from `emit.ts`, beyond ordinary
 * `RegionRendering` -- which is now nothing: `regionByTryEntry` covers a
 * plain `try` nested inside a loop/finite-destructuring body (the shape this
 * file always handled), and `RegionRendering.iteratorCloseRegionByEntry` plus
 * its paired `renderIteratorCloseRegion` callback now cover the reverse
 * nesting too (a loop/finite-destructuring region whose entry falls inside a
 * `try`'s own body/handler/finally, which used to render as unprotected plain
 * statements -- see that field's own comment in `emit-exceptions.ts`). Kept
 * as its own name, rather than inlining `RegionRendering` at every call site
 * in this file, so a future difference has somewhere to land without
 * renaming every signature that takes one.
 */
export type IteratorCloseRegionRendering = RegionRendering

/**
 * The settled value of a promise an async iteration step answered: a real
 * suspension (`co_await`) inside a coroutine frame, and the blocking read only
 * in a module body's top level -- the one frame `gea::detail::waitForPromise`
 * admits (`suspendsInPlace`). Every `for await` step in a function body is the
 * former: a nested pump there is the mongodb driver's deadlock, where a timer
 * fired inside `readMany`'s pump started a loop the pump beneath it never
 * returned from.
 */
const settledPromiseText = (ctx: EmitContext, promise: string): string =>
  suspendsInPlace(ctx) ? `(co_await ${promise})` : `(${promise}).awaited()`

/**
 * `for`-`of`/argument-spread/`yield*` over a provably plain `T[]`, and
 * `for`-`in` over a source whose own keys need no dynamic method lookup: the
 * iterator-protocol shapes this backend lowers today. ECMA-262 23.1.5's Array
 * Iterator is a fixed index/length walk over the exact array, so all three
 * steps below construct/advance/read a `gea::Iterator<T>` cursor directly --
 * no `[[Get]]` of `@@iterator`, no dynamic method call, no boxed callable.
 * `representation/publish.ts`'s `arrayFastPathIteratorCursorOf` is what
 * guarantees a `get-iterator` step reaching here always publishes an
 * "iterator"-kind result over an "array-object" target; `preflight/
 * runtime-helper-key.ts`'s carrier-suffixed obligation keys are what keep any
 * OTHER iterable (a `Map`, a `Set`, a genuinely dynamic `Iterable<T>`) refused
 * before it ever reaches this file. The checks below are fail-closed re-checks
 * of that guarantee, not a first opinion -- the same posture `emit-arrays.ts`'s
 * own ownership check takes.
 *
 * `for`-`in`'s two NATIVE enumeration sources join the same cursor for the
 * identical reason a `Set`/`Map`/`dictionary` `for`-`of`/`for`-`in` source
 * does: enumerating a receiver whose own key set this compiler already knows
 * needs no `Symbol.iterator`-style dispatch, so it is exactly as native as the
 * array fast path.
 *
 * A **record, a class instance, or any other statically shaped receiver** is a
 * STATIC question -- its key set is its own declared fields, known at compile
 * time, never a boxed dynamic-object walk (`geastack/compiler/CLAUDE.md`'s "No
 * Boxing" rule). `gea::nativeDynamicKeys` answers it from the struct's own
 * field dispatcher (`records.ts`'s `gea_ownFieldKeys`) plus its
 * dynamic-property sidecar, the same two tables `emit-dynamic-properties.ts`
 * already reads and writes through for a computed property on the same
 * receiver -- so `for`-`in`, `[k]`-write and `[k]`-read agree about what a key
 * on this object is.
 *
 * A **genuinely dynamic receiver** -- a value the program declared `any`/
 * `unknown` and never narrowed -- has no compile-time key set to state, and
 * that IS the honest boundary this backend's boxing rule admits: a real
 * runtime walk of the box's own (and inherited) enumerable string keys,
 * `Value::ownEnumerableStringKeys`.
 *
 * Both native sources still recheck a key's presence at the step that would
 * yield it (`Iterator`'s own snapshot+recheck constructor,
 * `gea::nativeDynamicHas`/`Value::hasProperty`), for the same reason the
 * `Dictionary` source above does: a key deleted mid-loop, before its own
 * step runs, must not be visited (ECMA-262 14.7.5.9).
 */

/** The receiver shapes whose own key set is a compile-time fact -- see this file's own header comment. */
type StaticEnumerationTarget = Extract<Representation, { kind: 'record' | 'record-with-index' | 'class-ref' | 'native-record-ref' }>

const isStaticEnumerationTarget = (target: Representation): target is StaticEnumerationTarget =>
  target.kind === 'record' || target.kind === 'record-with-index' || target.kind === 'class-ref' || target.kind === 'native-record-ref'

/**
 * `for`-`in` over a statically shaped receiver, constructed from the snapshot
 * a shared C++ helper (`gea::nativeDynamicKeys`) already knows how to build --
 * see this file's own header comment for why this is a static question rather
 * than a boxed walk.
 *
 * Returns `false` -- emitting nothing -- for a target this static path cannot
 * spell, so its caller can fall through to the next candidate rather than this
 * function committing to a throw the caller did not ask for.
 */
const emitStaticEnumerateIterator = (
  ctx: EmitContext,
  lines: string[],
  operation: GetIteratorOperation,
  target: Representation
): boolean => {
  if (!isStaticEnumerationTarget(target)) return false
  // A `native-record-ref` naming a HOST struct has no C++ definition this
  // backend renders (`types.ts`'s own comment: "records.ts emits no struct for
  // it"), so it never gets the `gea_ownFieldKeys`/`gea_readOwnField` dispatcher
  // `nativeDynamicKeys` calls -- refused by name rather than reaching a method
  // that does not exist on the host's own type.
  if (target.kind === 'native-record-ref' && target.native !== null) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:enumerate:get-iterator:native-record-ref',
      'enumerates a "native-record-ref" receiver naming a host-defined struct, which carries no compiler-rendered field ' +
        'dispatcher for this walk to call'
    )
  }
  // Every one of the four static kinds carries an `ownership` field; the
  // dynamic-property sidecar this walk also visits needs the object's own
  // shared identity to key on, exactly as `emit-dynamic-properties.ts`'s
  // `nativeSidecarReceiver` requires for the identical reason -- a by-value
  // struct has no stable address the sidecar table could be keyed on.
  if (target.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:enumerate:get-iterator:${target.kind}`,
      `enumerates a "${target.kind}" receiver carried with ownership "${target.ownership}"; the dynamic-property sidecar this ` +
        "walk also visits needs the object's own shared identity to key on, which a by-value struct does not have"
    )
  }
  const receiver = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = gea::Iterator<std::string>(gea::nativeDynamicKeys(${receiver}), ` +
      `std::function<bool(const std::string&)>([gea_receiver = ${receiver}](const std::string& gea_key) { ` +
      'return gea::nativeDynamicHas(gea_receiver, gea::PropertyKey::string(gea_key)); }));'
  )
  return true
}

/**
 * `for`-`of` over a fixed-arity tuple, whose storage is a struct with one
 * member per position (`gea_slot_0`, `gea_slot_1`, ...) rather than any
 * container `gea::Iterator` has a constructor for. The cursor is built from a
 * reader closure that returns the member at a given step -- a `switch` over
 * the positions, which is the whole of the walk because the position count is
 * a compile-time fact.
 *
 * This is a VALUES walk over the same `record` carrier `for`-`in` walks for
 * its KEYS, which is why `emitGetIterator` dispatches on the operation's own
 * `protocol` before reaching either: for a tuple of strings both cursors are
 * `gea::Iterator<std::string>`, so neither carrier can tell them apart and
 * picking the wrong one would compile cleanly and yield `"0", "1", "2"` where
 * the program asked for its elements.
 *
 * Every field must be positional, required, and carried identically -- one
 * cursor has one element type. `preflight/runtime-helper-key.ts`'s
 * `isUniformTupleRecord` already keeps a heterogeneous tuple off the claimed
 * `record(tuple-values)` key, so the checks here are fail-closed re-checks of
 * that guarantee rather than a first opinion, the same posture every other
 * source in this file takes.
 */
const emitStaticTupleIterator = (
  ctx: EmitContext,
  lines: string[],
  operation: GetIteratorOperation,
  target: Representation,
  element: Representation
): boolean => {
  if (target.kind !== 'record' || target.fields.length === 0) return false
  const elementType = cppTypeOf(element)
  const positional = target.fields.every((field, position) => field.key === String(position) && field.required)
  if (!positional) return false
  const uniform = target.fields.every((field) => cppTypeOf(field.value) === elementType)
  if (!uniform) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:iterator:get-iterator:record(tuple-values)',
      `iterates a tuple whose positions do not share one carrier, so the single "${elementType}" element type its cursor would ` +
        'have to publish is not the type of every position'
    )
  }
  const accessor = memberAccessOperator(target.ownership)
  const receiver = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  const cases = target.fields
    .map((field, position) => `case ${position}: gea_out = gea_receiver${accessor}${cppRecordFieldName(field.key)}; return true;`)
    .join(' ')
  lines.push(
    `${name} = ${cppTypeOf(operation.result.representation)}(std::function<bool(std::size_t, ${elementType}&)>(` +
      `[gea_receiver = ${receiver}](std::size_t gea_position, ${elementType}& gea_out) -> bool { ` +
      `switch (gea_position) { ${cases} default: return false; } }));`
  )
  return true
}

/**
 * A named layout is a record everywhere the iterator protocol asks about one.
 *
 * `interface Bag { [Symbol.iterator](): IterableIterator<T> }` derives a
 * `native-record-ref` -- the nominal carrier that keeps a self-referential
 * declaration finite -- while the very same shape written inline derives a
 * structural `record`. Every step below reads a FIELD off the shape (`next`,
 * `value`, `done`); which of the two carriers names it changes only where the
 * field list is written down, never whether the field exists, so both go
 * through the one layout authority `cppRecordDeclarations` builds the struct
 * body from instead of each step forming its own opinion.
 *
 * A host-bound shape (`native !== null`) is deliberately excluded: the engine
 * spells those members, not this compiler, so its own field list is not the
 * struct being read -- the identical split `preflight/runtime-helper-key.ts`'s
 * `enumerateGetIteratorCarrierKind` already makes for the enumerate protocol.
 */
const iteratorRecordFieldsOf = (ctx: EmitContext, representation: Representation): readonly RecordField[] | null => {
  if (representation.kind === 'record') return representation.fields
  if (representation.kind !== 'native-record-ref' || representation.native !== null) return null
  return recordFieldsOfShape(ctx.deriver, representation.shapeId)
}

const iteratorRecordAccessorsOf = (ctx: EmitContext, representation: Representation) => {
  if (representation.kind === 'record') return representation.accessors
  if (representation.kind !== 'native-record-ref' || representation.native !== null) return null
  return recordAccessorsOfShape(ctx.deriver, representation.shapeId)
}

/**
 * `for`-`in` over a `native-handle` receiver (`Math`, `Array.prototype`, ...).
 *
 * ECMA-262 declares every own property of a host intrinsic non-enumerable --
 * 21.3.1's Math constants are `{writable: false, enumerable: false,
 * configurable: false}`, and a builtin method is `{writable: true,
 * enumerable: false, configurable: true}` (10.2.4 `SetFunctionLength`/
 * `AddRestrictedFunctionProperties` and the per-clause "the length/name
 * property" language throughout clause 21) -- so a `for`-`in` walk over one
 * always visits zero keys, regardless of which intrinsic it is or how many
 * members the checker's own lib types say it has. There is nothing to name at
 * runtime here, unlike `emitStaticEnumerateIterator`'s struct walk: the empty
 * vector plus an always-false presence predicate is the whole cursor, and the
 * receiver text is never read at all (a `gea::NativeHandle<...>` carries no
 * runtime value to key a table on regardless).
 */
const emitNativeHandleEnumerateIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = gea::Iterator<std::string>(std::vector<std::string>{}, ` +
      'std::function<bool(const std::string&)>([](const std::string&) { return false; }));'
  )
}

/**
 * `for`-`in` over a callable: the shared function-object table's own
 * enumerable string keys. `name`/`length` are installed non-enumerable first
 * so the walk sees exactly the expandos the program wrote, and a key deleted
 * mid-walk is skipped the way the dynamic walk below skips one.
 */
const emitCallableEnumerateIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  const receiver = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = gea::Iterator<std::string>(([&]() { const auto& __gea_callable = ${receiver}; ` +
      'gea::installCallableOwnFacts(__gea_callable.functionObjectIdentity(), __gea_callable.name(), __gea_callable.length()); ' +
      'std::vector<std::string> __gea_keys; for (const auto& __gea_key : __gea_callable.functionObjectIdentity()->properties->ownKeys()) { ' +
      'if (__gea_key.isSymbol()) continue; const gea::PropertyDescriptor* __gea_own = __gea_callable.functionObjectIdentity()->properties->ownProperty(__gea_key); ' +
      'if (__gea_own != nullptr && __gea_own->enumerable) __gea_keys.push_back(__gea_key.text()); } return __gea_keys; })(), ' +
      `std::function<bool(const std::string&)>([gea_receiver = ${receiver}](const std::string& gea_key) { ` +
      'return static_cast<bool>(gea_receiver.functionObjectIdentity()->properties->ownProperty(gea::PropertyKey::string(gea_key))); }));'
  )
}

/**
 * `for`-`in` over an ARRAY -- ECMA-262 14.7.5.9 over the array exotic object's
 * own key space: its present indices as decimal strings, then whatever string
 * keys an expando write put on the same object.
 *
 * It is reached by dispatching on the operation's own `protocol` BEFORE the
 * shared collection path below, for the identical reason `for`-`of` over a
 * tuple record is: an `array-object` is a `nativeSource` down there, and the
 * cursor that path builds walks the array's ELEMENTS. For `number[]` both
 * cursors compile, so picking the wrong one is not a compile error -- it is a
 * program that yields `1, 2, 3` where the language yields `"0", "1", "2"`.
 * hono's regexp router is the call site (`for (const i in
 * indexReplacementMap)`, with its own comment saying it uses `in` precisely
 * because the array is SPARSE), and a values walk would have visited the holes
 * it is written to skip.
 *
 * The snapshot-plus-recheck shape is the one every other `for`-`in` source
 * here uses, and `gea::arrayOwnEnumerableKeys` was already written for
 * `Object.keys` of the same receiver -- so the two answers cannot disagree
 * about what an array's own enumerable keys are.
 */
const emitArrayEnumerateIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  const receiver = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = gea::Iterator<std::string>(gea::arrayOwnEnumerableKeys(${receiver}), ` +
      `std::function<bool(const std::string&)>([gea_receiver = ${receiver}](const std::string& gea_key) { ` +
      'return gea::arrayHasOwnEnumerableKey(gea_receiver, gea_key); }));'
  )
}

/** `for`-`in` over a genuinely dynamic receiver -- see this file's own header comment. */
const emitDynamicEnumerateIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  const receiver = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = gea::Iterator<std::string>((${receiver}).ownEnumerableStringKeys(), ` +
      `std::function<bool(const std::string&)>([gea_receiver = ${receiver}](const std::string& gea_key) { ` +
      'return gea_receiver.hasProperty(gea::PropertyKey::string(gea_key)); }));'
  )
}

/**
 * The general iterator protocol's `get-iterator` step: `receiver[Symbol.iterator]()`,
 * called through the method value `get-method` already resolved -- a class
 * instance's own hand-written `[Symbol.iterator]()`, or a plain object's.
 *
 * This is sound over exactly the two carriers `manifest/capabilities.ts`
 * claims it for (`class-ref`, `record`), and NOT over every "record"-carried
 * receiver: `preflight/runtime-helper-key.ts`'s `iteratorMethodCarrierKind`
 * keeps a "record" with no discoverable `@@iterator` FIELD -- an open tuple
 * spread through its inherited `Array.prototype[Symbol.iterator]`, carried as
 * a positional "0"/"1"/... record with no such field at all -- off the
 * claimed key, refused by name at preflight instead of reaching here. So
 * every "record" receiver that DOES reach this function really does carry a
 * callable `method` operand, and the checks below are fail-closed re-checks
 * of that guarantee, not a first opinion -- the same posture this file's
 * static/dynamic `for`-`in` sources already take.
 *
 * The call goes through the SAME dispatch check `emit-callable.ts`'s general
 * call emission performs for an ordinary method reference: an overridden
 * `[Symbol.iterator]` (`ctx.virtualCallees`) is called through the object, so
 * a subclass's override runs rather than the base's; anything else calls
 * through the `gea::CallableObject` carrier directly (`.call(receiver)`),
 * exactly as `emit-properties.ts`'s `classMemberText` built it to be called.
 */
const emitDynamicGetIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  const method = operation.method
  if (method === null) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:iterator:get-method:record',
      'carries no "method" operand to call; the general iterator protocol has nothing else to advance the iteration with'
    )
  }
  const representation = operation.result.representation
  // Almost always a "record" -- the synthetic `{ next }` shape ECMA-262 7.4.2
  // `GetIterator` guarantees for a call this compiler cannot see the real
  // return type of at the producer layer generically. "iterator" is the one
  // other carrier this call can genuinely produce: `producers/protocol.ts`'s
  // `generatorRecordTypeOf` publishes it instead, in place of the synthetic
  // record, exactly when the resolved `[Symbol.iterator]` is written as a
  // GENERATOR method (`*[Symbol.iterator]() { yield ... }`) and so really
  // returns a `Generator<T>` -- which IS its own iterator (ECMA-262 27.5.1.2),
  // so the call below needs no further unwrapping either way: assigning its
  // result is the whole step, whether that result is the record or the cursor.
  if (
    representation.kind !== 'iterator' &&
    representation.kind !== 'async-generator' &&
    iteratorRecordFieldsOf(ctx, representation) === null
  ) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:get-iterator:${representation.kind}`,
      `carries a "${representation.kind}" result over a dynamic "method" operand, but the general iterator protocol only ever ` +
        'publishes a record result -- the `{ next }` record ECMA-262 7.4.2 `GetIterator` returns, structural or named -- or an ' +
        '"iterator" result when the resolved method is itself a generator'
    )
  }
  if (method.representation.kind !== 'function-value-dispatch') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:get-method:${method.representation.kind}`,
      `calls a "method" operand carried as "${method.representation.kind}", but the general iterator protocol only ever resolves ` +
        'one through a "function-value-dispatch" carrier -- the class/record member read `preflight/runtime-helper-key.ts` gates on'
    )
  }
  const receiverText = operandText(ctx, operation.receiver)
  const name = defineValue(ctx, operation.result)
  // An overridden `[Symbol.iterator]` goes through the object, exactly as an
  // ordinary overridden method call does (`emit-callable.ts`): the value
  // `classMemberText` built names the base's body, and only the object's own
  // virtual member selects the override.
  const dispatched = ctx.virtualCallees.get(method.value)
  if (dispatched !== undefined) {
    ctx.virtualCalleesUsed.add(method.value)
    lines.push(`${name} = ${receiverText}->${dispatched.member}();`)
    return
  }
  // `iteratorMethodCallText` is the one place that decides whether a receiver
  // argument is supplied, and it decides it from the callable's own ABI --
  // the same authority `next()` and an accessor-held `next` already read. A
  // hand-written `.call(receiver)` here spelled a second answer, and it was
  // the wrong one for every `[Symbol.iterator]` whose convention declares no
  // receiver.
  lines.push(
    `${name} = ${iteratorMethodCallText(ctx, operandText(ctx, method), method.representation.abi, operation.receiver, 'iterator get-iterator')};`
  )
}

/**
 * `for`-`of` over a sum of Arrays -- mongodb's `seeds: string[] |
 * HostAddress[]` once the Topology constructor has normalized a lone seed --
 * or of Arrays and Sets (`isSuperset`'s rebound `string[] | Set<string>`).
 *
 * Whichever arm is live is an ordinary Array, so its walk is ECMA-262
 * 23.1.5's index/length cursor over exactly that array, re-reading the length
 * each step as `Iterator::arrayNext` does. The only thing the sum adds is the
 * element: each arm's element widens into the iterator's declared element
 * carrier (the union of the arms' elements) through the ordinary conversion
 * table, and an arm whose element has no such widening refuses by name
 * rather than being walked as another arm's.
 */
const emitSequenceSumIterator = (
  ctx: EmitContext,
  lines: string[],
  operation: GetIteratorOperation,
  source: Extract<Representation, { kind: 'tagged-union' }>,
  element: Representation
): void => {
  const elementType = cppTypeOf(element)
  const cursorType = `gea::Iterator<${elementType}>`
  const refuse = (index: number, detail: string): never => {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${operation.protocol}:get-iterator:tagged-union`,
      `walks a sum whose arm ${index} ${detail}`
    )
  }
  const widenedOf = (index: number, from: Representation, read: string): string =>
    alignedValueText(ctx, 'emit-iterator.ts:emitSequenceSumIterator', from, element, read) ??
    refuse(index, `yields "${representationKey(from)}", which does not widen into the cursor's element "${representationKey(element)}"`)
  const armCursors = source.arms.map((arm, index) => {
    const carrier = arm.value
    const signature = `std::function<bool(std::size_t, ${elementType}&)>`
    if (carrier.kind === 'array-object' && carrier.ownership === 'shared-refcount') {
      const read = `(gea_array->present(gea_position) ? gea_array->at(gea_position) : ${cppTypeOf(carrier.element)}{})`
      return (
        `${cursorType}(${signature}([gea_array = gea_sum.template get<${index}>()]` +
        `(std::size_t gea_position, ${elementType}& gea_out) -> bool { ` +
        `if (!gea_array || gea_position >= gea_array->size()) return false; gea_out = ${widenedOf(index, carrier.element, read)}; return true; }))`
      )
    }
    // A Set walks by insertion serial (`Set::itemAfter`), the cursor
    // 24.2.5.1 %SetIteratorPrototype%.next needs: an item added during the
    // walk is visited, one deleted before it is reached is not.
    if (carrier.kind === 'keyed-collection' && carrier.family === 'set' && carrier.ownership === 'shared-refcount') {
      return (
        `${cursorType}(${signature}([gea_set = gea_sum.template get<${index}>(), gea_serial = gea::makeRef<std::uint64_t>(0)]` +
        `(std::size_t, ${elementType}& gea_out) -> bool { ` +
        `if (!gea_set) return false; const auto* gea_item = gea_set->itemAfter(*gea_serial); if (!gea_item) return false; ` +
        `gea_out = ${widenedOf(index, carrier.key, '(*gea_item)')}; return true; }))`
      )
    }
    return refuse(index, `carries "${representationKey(carrier)}"; only a sum of shared Arrays and Sets has a native cursor`)
  })
  let chain = armCursors[armCursors.length - 1]!
  for (let index = armCursors.length - 2; index >= 0; index--) chain = `(gea_sum.template is<${index}>() ? ${armCursors[index]} : ${chain})`
  const name = defineValue(ctx, operation.result)
  lines.push(
    `${name} = ([](const ${cppTypeOf(source)}& gea_sum) -> ${cursorType} { return ${chain}; })(${operandText(ctx, operation.receiver)});`
  )
}

/**
 * The cursor over a `split` whose array nothing else reads (`ir/lazy-splits.ts`).
 * It reads the string as the loop runs, so it borrows only a private binding
 * written once -- nothing in the loop can change it -- and takes its own copy
 * of anything else.
 */
const emitSplitCursor = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation, split: LazySplit): void => {
  const declaration = split.receiverDeclaration
  const borrowed =
    declaration !== null && ctx.stableBorrowActuals.has(split.receiver.value) && (ctx.bindingWriteCounts.get(declaration) ?? 0) === 1
  const type = 'gea::runtime::string::SplitCursor'
  const name = defineValue(ctx, operation.result, type)
  const receiver = operandText(ctx, split.receiver)
  lines.push(`${name}.${borrowed ? 'borrow' : 'own'}(${receiver}, ${operandText(ctx, split.separator)});`)
}

export const emitGetIterator = (ctx: EmitContext, lines: string[], operation: GetIteratorOperation): void => {
  // The general protocol: `receiver[Symbol.iterator]()`, called through the
  // method value `get-method` already resolved -- see `emitDynamicGetIterator`
  // for the whole of why this is sound. Checked first because its own result
  // carrier ("record") is never the "iterator" cursor every branch below this
  // point assumes.
  if (operation.method) {
    emitDynamicGetIterator(ctx, lines, operation)
    return
  }
  const split = ctx.lazySplits.get(operation.receiver.value)
  if (split !== undefined) {
    emitSplitCursor(ctx, lines, operation, split)
    return
  }
  const representation = operation.result.representation
  // A source explicitly declared `any`/`unknown` owns no static
  // `[Symbol.iterator]` member to lower.  Its record is a `Value`, and the
  // runtime performs GetMethod, Call, and the iterable/result object checks
  // against that one live value.  This branch is intentionally before the
  // native cursor assertion: the static cursor branch below is for a typed
  // value and must never be widened into this dynamic path.
  if (representation.kind === 'dynamic') {
    if (operation.protocol !== 'iterator' || operation.receiver.representation.kind !== 'dynamic') {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:iterator:get-iterator:dynamic',
        'uses a dynamic iterator record outside the synchronous genuinely-dynamic source path'
      )
    }
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = gea::runtime::iterator::getIterator(${operandText(ctx, operation.receiver)});`)
    const doneState = `v${ctx.nextValueOrdinal++}`
    ctx.declarations.push({ name: doneState, type: 'bool' })
    lines.push(`${doneState} = false;`)
    ctx.dynamicIteratorDoneStates.set(operation.result.id, doneState)
    return
  }
  if (representation.kind !== 'iterator' && representation.kind !== 'async-generator') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${operation.protocol}:get-iterator:${representation.kind}`,
      `carries a "${representation.kind}" result, but the only get-iterator step this backend lowers produces an "iterator" carrier`
    )
  }
  const carried = operation.receiver.representation
  // `for await` over an async generator (possibly absent) is the one source
  // whose record is the generator itself; nothing below builds a cursor for it.
  if (representation.kind === 'async-generator') {
    const target = carried.kind === 'optional' ? carried.payload : carried
    if (operation.protocol !== 'async-iterator' || target.kind !== 'async-generator') {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:${operation.protocol}:get-iterator:${representation.kind}`,
        `publishes an async generator record over a "${representationKey(carried)}" source; only \`for await\` over the generator itself aliases one`
      )
    }
    const aliasName = defineValue(ctx, operation.result)
    lines.push(
      carried.kind === 'optional'
        ? `${aliasName} = gea::detail::requireIterablePresent(${operandText(ctx, operation.receiver)}, ${cppStringLiteral('a for await over a possibly-absent source')});`
        : `${aliasName} = ${operandText(ctx, operation.receiver)};`
    )
    return
  }
  if (operation.protocol === 'enumerate' && (carried.kind === 'optional' || carried.kind === 'tagged-union')) {
    const plan = nativeEnumerationPlanOf(carried)
    if (plan) {
      const render = (step: NativeEnumerationPlan, receiver: string): string => {
        switch (step.kind) {
          case 'empty':
            return 'gea::Iterator<std::string>{}'
          case 'fields':
            return `gea::Iterator<std::string>(gea::nativeDynamicKeys(${receiver}), std::function<bool(const std::string&)>([gea_receiver = ${receiver}](const std::string& gea_key) { return gea::nativeDynamicHas(gea_receiver, gea::PropertyKey::string(gea_key)); }))`
          case 'optional':
            return `((${receiver}).has_value() ? ${render(step.present, `(*(${receiver}))`)} : gea::Iterator<std::string>{})`
          case 'union': {
            let result = render(step.arms[step.arms.length - 1]!, `(${receiver}).template get<${step.arms.length - 1}>()`)
            for (let index = step.arms.length - 2; index >= 0; index--)
              result = `((${receiver}).template is<${index}>() ? ${render(step.arms[index]!, `(${receiver}).template get<${index}>()`)} : ${result})`
            return result
          }
        }
      }
      const name = defineValue(ctx, operation.result)
      lines.push(
        `${name} = ([](const auto& gea_enumerated) -> gea::Iterator<std::string> { return ${render(plan, 'gea_enumerated')}; })(${operandText(ctx, operation.receiver)});`
      )
      return
    }
  }
  // An ABSENT source iterates its PAYLOAD, behind a presence assertion.
  //
  // ECMA-262 7.4.2 `GetIterator` performs `GetMethod(obj, @@iterator)`, and
  // `GetMethod` on `undefined`/`null` throws a `TypeError` -- so iterating an
  // absent value is a RUNTIME refusal in the language itself, and the walk
  // over a present payload is byte-for-byte the walk over a bare payload.
  // That is why `producers/shared.ts`'s `presentIterationArm` routes such a
  // source down this native fast path at all, and why the whole of the
  // dispatch below reads the payload's carrier: the absence changes exactly
  // one thing, whether the walk starts.
  //
  // `gea::detail::requireIterablePresent`, never a bare `*opt`: an
  // `Optional<T>` always holds a constructed `T`, so dereferencing an absent
  // one hands back a DEFAULT-constructed value and the loop would quietly
  // walk an empty container -- a silently wrong answer where the language
  // says throw.
  //
  // Preflight has already refused every payload this dispatch cannot spell:
  // `runtime-helper-key.ts` reports an absent source under its own
  // `optional(<payload kind>)` key rather than borrowing the payload's, so a
  // shape the manifest does not claim never reaches here.
  //
  // The ASSERTION is scoped to the `iterator` protocol, and that scope is
  // load-bearing rather than defensive: `for`-`in` over an absent value does
  // NOT throw in JavaScript (ECMA-262 14.7.5.5 evaluates `undefined`/`null`
  // to a BREAK completion and the loop runs zero times), so asserting
  // presence for one would abort where the language quietly skips. An absent
  // `for`-`in` source is instead an EMPTY cursor. A statically nullish source
  // uses the default cursor below; a possibly-absent table uses
  // `gea::detail::enumerateIfPresent` at the bottom of this function:
  // the static-snapshot walks below read fields off the receiver itself, and
  // preflight (`runtime-helper-key.ts`'s `enumerateGetIteratorCarrierKind`)
  // keeps every non-table payload on an unclaimed `optional(<kind>)` key.
  const absent = carried.kind === 'optional'
  const target = absent ? carried.payload : carried
  if (operation.protocol === 'enumerate' && (carried.kind === 'undefined' || carried.kind === 'null')) {
    // ForIn/OfHeadEvaluation skips nullish enumeration. Keep evaluation of
    // the source even when a deferred call supplies this known-empty cursor.
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = (static_cast<void>(${operandText(ctx, operation.receiver)}), ${cppTypeOf(representation)}{});`)
    return
  }
  const asserted = absent && operation.protocol !== 'enumerate'
  const skipped = absent && operation.protocol === 'enumerate'
  if (skipped && target.kind !== 'dictionary') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:enumerate:get-iterator:optional(${target.kind})`,
      `enumerates a possibly-absent "${target.kind}" source; only a table has a cursor an absent source can be the empty one of`
    )
  }
  // Three native sources, one cursor: an Array (ECMA-262 23.1.5), a `Set`
  // (24.2.3.10) and a `string` (22.1.3.36). All three walk storage already in
  // hand with no `@@iterator` lookup, and `gea::Iterator<E>` has a constructor
  // for each -- see its own comment for why one cursor type rather than three.
  // A `Map` is deliberately NOT here: its iterator yields a `[K, V]` pair with
  // no cursor carrier to publish (`producers/shared.ts`'s
  // `isNativeIterableSetType`), so it never reaches the fast path and refuses
  // at preflight instead.
  //
  // A string is passed BY VALUE, not through a `shared_ptr`: that is what its
  // carrier is (`std::string`), and the cursor's own string constructor takes
  // it by value for the dangling reason its comment states. The ownership
  // check below is therefore scoped to the two collection sources, which are
  // the only ones that have an ownership at all.
  // The payload kinds whose spelling below actually reads the source through
  // `sourceText()`. A fixed-arity tuple is the one that does NOT: its
  // positions are read straight off the receiver inside a lambda capture
  // (`emitStaticTupleIterator`), so an absent tuple would capture the
  // `Optional` itself and index a payload nobody proved present. Refused by
  // name rather than unwrapped blind -- `runtime-helper-key.ts` reports it
  // under the unclaimed `optional(record)` key, so preflight already stops it
  // and this is the fail-closed backstop that keeps the two agreeing.
  if (asserted && !['string', 'iterator', 'async-generator', 'array-object', 'dictionary', 'keyed-collection'].includes(target.kind)) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${operation.protocol}:get-iterator:optional(${target.kind})`,
      `targets a possibly-absent "${target.kind}" source; the presence assertion this backend spells sits in front of a cursor ` +
        'constructor, and that payload is not read through one'
    )
  }
  // Every spelling below reads the source through this, so the presence
  // assertion is written once for whichever payload shape the dispatch lands
  // on rather than once per branch.
  const sourceText = (): string =>
    asserted
      ? `gea::detail::requireIterablePresent(${operandText(ctx, operation.receiver)}, ${cppStringLiteral('a for-of over a possibly-absent source')})`
      : operandText(ctx, operation.receiver)
  if (target.kind === 'string') {
    const cursorName = defineValue(ctx, operation.result)
    lines.push(`${cursorName} = ${cppTypeOf(representation)}(${sourceText()});`)
    return
  }
  // A source that IS a cursor -- a `Generator<T, ...>`, carried as
  // `iterator(T)` (`representation/derive.ts`) -- is its own iterator record:
  // ECMA-262 27.5.1.2 `%GeneratorPrototype%[@@iterator]` returns `this`. So the
  // step is an assignment, not a construction. The copy shares the coroutine
  // frame (`gea::Iterator`'s `CoroutineState` is held by `shared_ptr`), which
  // is what makes `g.next()` and a later `for (const x of g)` advance the one
  // generator the language says they do.
  // An async generator is its own async iterator the same way (27.6.1.2
  // `%AsyncGeneratorPrototype%[@@asyncIterator]` returns `this`), and its
  // copies share one generator (`gea::AsyncGenerator`'s `Core`).
  if (target.kind === 'iterator' || target.kind === 'async-generator') {
    const aliasName = defineValue(ctx, operation.result)
    lines.push(`${aliasName} = ${sourceText()};`)
    return
  }
  // A `Set` and a `Map` share this one spelling: `gea::Iterator<E>` has a
  // constructor for each, and overload resolution picks by the collection's own
  // C++ type. The two WEAK families never reach here -- they have no iteration
  // at all (ECMA-262 24.3/24.4), `producers/shared.ts` mints a `get-method`
  // step for them, and `protocol:iterator:get-method:keyed-collection` is
  // claimed by no manifest.
  //
  // A `dictionary` joins them from the `enumerate` protocol -- `for`-`in` --
  // and reaches the same spelling for the same reason: `gea::Iterator<E>` has
  // a `Dictionary` constructor too, which walks the table's `propertyKeys()`.
  // Nothing here distinguishes the two protocols, because nothing needs to:
  // the operation's own receiver carrier already says which walk it is, and
  // preflight has already refused every receiver neither claim covers.
  //
  // The two remaining `for`-`in` sources -- a statically shaped receiver and a
  // genuinely dynamic one -- are checked before the collection group below
  // rather than folded into it: neither is a `nativeSource` a bare
  // `${cppTypeOf(representation)}(...)` construction can spell, each needs its
  // own C++ helper call, and nothing here needs an explicit "is this really
  // `for`-`in`" test to keep the two apart from a `for`-`of`/spread reaching
  // this function -- see this file's own header comment for why the `iterator`
  // result carrier these two branches require never gets published for the
  // ONE protocol (`iterator`/`async-iterator`) that could target the same
  // receiver kinds with a `method` operand still attached, and `operation.method`
  // already refused that case above.
  //
  // The one thing the receiver's carrier CANNOT say is which of the two walks
  // over a struct this is -- `for`-`in` yields its keys, `for`-`of` over a
  // fixed-arity tuple yields its positions, and for a tuple of strings both
  // cursors are `gea::Iterator<std::string>`. So the protocol the operation
  // carries decides, and the two static struct walks are reached only through
  // it; anything else is left to the collection group below, which refuses
  // what it cannot spell.
  if (operation.protocol === 'enumerate') {
    if (emitStaticEnumerateIterator(ctx, lines, operation, target)) return
    if (target.kind === 'dynamic') {
      emitDynamicEnumerateIterator(ctx, lines, operation)
      return
    }
    if (target.kind === 'native-handle') {
      emitNativeHandleEnumerateIterator(ctx, lines, operation)
      return
    }
    if (target.kind === 'function-value-dispatch') {
      emitCallableEnumerateIterator(ctx, lines, operation)
      return
    }
    if (target.kind === 'array-object' && target.ownership === 'shared-refcount') {
      emitArrayEnumerateIterator(ctx, lines, operation)
      return
    }
    if (target.kind === 'dictionary' && target.key === 'symbol') {
      // EnumerateObjectProperties visits string keys only. A symbol-keyed
      // table therefore has a complete native cursor whose sequence is empty;
      // it must not instantiate the string Dictionary cursor or stringify a
      // symbol description into a property name.
      const name = defineValue(ctx, operation.result)
      lines.push(
        `${name} = gea::Iterator<std::string>(std::vector<std::string>{}, ` +
          'std::function<bool(const std::string&)>([](const std::string&) { return false; }));'
      )
      return
    }
  } else if (emitStaticTupleIterator(ctx, lines, operation, target, representation.element)) return
  if (operation.protocol !== 'enumerate' && !absent && target.kind === 'tagged-union') {
    emitSequenceSumIterator(ctx, lines, operation, target, representation.element)
    return
  }
  const iterableCollection = target.kind === 'keyed-collection' && (target.family === 'set' || target.family === 'map')
  const nativeSource = target.kind === 'array-object' || target.kind === 'dictionary' || iterableCollection
  if (!nativeSource) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${operation.protocol}:get-iterator:${target.kind}`,
      `targets a "${target.kind}" receiver, but the native fast path only ever targets an "array-object", a "Set", a "Map", a "string" or a "dictionary"`
    )
  }
  if (target.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${operation.protocol}:get-iterator:${target.kind}`,
      `targets a collection carried with ownership "${target.ownership}", but this emitter only spells the cursor constructor for "shared-refcount"`
    )
  }
  // Only a protocol-private SSA cursor may use a compact local layout. A
  // returned, stored, merged or copied iterator retains the shared carrier.
  const localType = ctx.localIterators.has(operation.result.id)
    ? target.kind === 'array-object'
      ? `gea::LocalArrayCursor<${cppTypeOf(representation.element)}>`
      : target.kind === 'dictionary' && target.key === 'string'
        ? `gea::LocalDictionaryCursor<${cppTypeOf(target.value)}>`
        : null
    : null
  const type = localType ?? cppTypeOf(representation)
  const name = defineValue(ctx, operation.result, type)
  lines.push(skipped ? `${name} = gea::detail::enumerateIfPresent<${type}>(${sourceText()});` : `${name} = ${type}(${sourceText()});`)
}

/**
 * The general iterator protocol's `next` step over a "record"-carried
 * iterator-record: ECMA-262 7.4.3 `IteratorNext` is ONE call producing
 * `{value, done}` together, unlike the native array cursor's `arrayNext()` +
 * `.done()` pair (which answers the same two-op IR split for free, by
 * stepping a stateful cursor and reading a flag back). A record's own `next`
 * is a real, once-only call through a `gea::CallableObject`, so it is called
 * exactly once here and its `{value, done}` result is cached in a fresh local
 * for the paired `iterator-done` step (`emitIteratorDone` below) to read --
 * `ctx.protocolNextResults`, keyed by the iterator-record value both steps
 * name, so the cache always survives to when `iterator-done` runs (the same
 * per-body evaluation order the array cursor's own split already relies on).
 * Calling `next` a second time to answer `done` would both double the source
 * iterator's side effect and skip every other element.
 *
 * The `next` FIELD's own shape is a fail-closed re-check of
 * `iteratorMethodAndRecordTypes` (`producers/protocol.ts`), the one place
 * that publishes it -- see `emitDynamicGetIterator`'s header for why every
 * "record" reaching this step really does carry it.
 *
 * Invariant 5 audit (invariant 5: no write during render): `protocolNextResults`
 * -- and, by the identical reasoning, `dynamicIteratorSteps` and
 * `dynamicIteratorDoneStates` below -- is NAMING, not a fact, and correctly
 * carries no `EmitBodyFacts`/`EmitContext` fact field. WHICH iterator values
 * are dynamic or record-carried is answered entirely by `operation.iterator
 * .representation`, an IR-settled carrier asked afresh at every use; nothing
 * here decides that. What each map holds is the C++ NAME of a scratch local
 * this render just minted (`v<ordinal>` off `ctx.nextValueOrdinal`, a counter
 * tied to render's own traversal order, never a foreign table's `.size`) --
 * a name that cannot exist before the call it names is printed, so it cannot
 * be settled in a prepass. All three are correctly listed in
 * `emit-context.ts`'s `renderMutableEmitContextFields`.
 */
/** Invoke a protocol method with the iterator as its real ECMAScript receiver. */
const iteratorMethodCallText = (ctx: EmitContext, callable: string, abi: CallableAbi, iterator: IrOperand, what: string): string => {
  const supplied = abi.receiver === null ? [] : [receiverArgumentText(ctx, abi, iterator)]
  return `${callable}.call(${paddedArguments(abi, supplied, what).join(', ')})`
}

/**
 * A getter is itself a receiver-bearing call and must use its projected ABI
 * too -- and, when it captures, the environment the iterator object carries
 * for it (`accessorEnvironmentArguments`), exactly as an ordinary member read
 * of the same accessor does.
 */
const iteratorGetterText = (ctx: EmitContext, key: string, getter: FunctionId, iterator: IrOperand, what: string): string => {
  const abi = ctx.abiOfCallable(getter)
  if (abi === null) throw createCppEmitBlockedError(`runtime-helper:protocol:${what}`, `getter ${getter} publishes no callable ABI`)
  const supplied = abi.receiver === null ? [] : [receiverArgumentText(ctx, abi, iterator)]
  const environment = accessorEnvironmentArguments(ctx, iterator.representation, key, getter, 'getter', operandText(ctx, iterator))
  return `${cppBodyName(getter)}(${[...environment, ...paddedArguments(abi, supplied, `${what} getter`)].join(', ')})`
}

/**
 * `next()` whose result is the LIBRARY's own `IteratorResult<T>` union.
 *
 * One call, cached in a local of the union's type, and two reads dispatched
 * over its arms -- the same leaf dispatch `emit-union-properties.ts` performs
 * for any other member read of a tagged union. Every arm must be a record
 * carrying both members, because that is what the protocol reads; an arm that
 * is not is refused by name rather than defaulted.
 */
const emitUnionResultIteratorNext = (
  ctx: EmitContext,
  lines: string[],
  operation: IteratorNextOperation,
  iteratorRecord: Extract<Representation, { kind: 'record' | 'native-record-ref' }>,
  nextAbi: CallableAbi,
  nextField: RecordField | undefined,
  nextAccessor: { readonly key: string; readonly getter: FunctionId | null } | undefined,
  result: Extract<Representation, { kind: 'tagged-union' }>,
  awaits: boolean
): void => {
  const receiverText = operandText(ctx, operation.iterator)
  const receiverAccessor = memberAccessOperator(iteratorRecord.ownership)
  const nextText = nextField
    ? `${receiverText}${receiverAccessor}${cppRecordFieldName('next')}`
    : nextAccessor?.getter
      ? iteratorGetterText(ctx, nextAccessor.key, nextAccessor.getter, operation.iterator, 'iterator-next')
      : null
  if (nextText === null)
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRecord.kind}`,
      'cannot resolve the iterator next method'
    )
  const called = iteratorMethodCallText(ctx, nextText, nextAbi, operation.iterator, 'iterator next()')
  const callText = awaits ? settledPromiseText(ctx, called) : called
  const tempName = `v${ctx.nextValueOrdinal}`
  ctx.nextValueOrdinal += 1
  ctx.declarations.push({ name: tempName, type: cppTypeOf(result) })
  lines.push(`${tempName} = ${callText};`)
  const name = defineValue(ctx, operation.result)
  const leaves = unionPropertyLeaves(result, tempName)
  const memberText = (key: 'value' | 'done', target: Representation): string => {
    const texts = leaves.map((leaf): string | null => {
      const arm = leaf.representation
      if (arm.kind !== 'record' && arm.kind !== 'native-record-ref') return null
      const field = iteratorRecordFieldsOf(ctx, arm)?.find((candidate) => candidate.key === key)
      if (field === undefined) return null
      return alignedValueText(
        ctx,
        'emit-iterator.ts:671',
        field.value,
        target,
        `${leaf.text}${memberAccessOperator(arm.ownership)}${cppRecordFieldName(key)}`
      )
    })
    const dispatched = texts.every((text): text is string => text !== null) ? dispatchedLeafExpression(leaves, texts) : null
    if (dispatched === null) {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:iterator:next:${iteratorRecord.kind}`,
        `calls a "next()" whose result union has an arm with no readable "${key}" member of the published carrier`
      )
    }
    return dispatched
  }
  ctx.protocolNextResults.set(operation.iterator.value, {
    tempName,
    accessor: '.',
    valueName: name,
    valueText: memberText('value', operation.result.representation),
    doneText: memberText('done', { kind: 'scalar', domain: 'boolean' })
  })
}

const emitDynamicIteratorNext = (
  ctx: EmitContext,
  lines: string[],
  operation: IteratorNextOperation,
  iteratorRecord: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
): void => {
  if (operation.value) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRecord.kind}`,
      'carries a "value" argument; the general iterator protocol\'s next() call never consumes one (only a generator\'s .next(v) does, which is never carried as a "record")'
    )
  }
  const iteratorFields = iteratorRecordFieldsOf(ctx, iteratorRecord)
  const nextField = iteratorFields?.find((field) => field.key === 'next')
  const nextAccessor = iteratorRecordAccessorsOf(ctx, iteratorRecord)?.find((accessor) => accessor.key === 'next')
  const nextCallable = nextField?.value ?? (nextAccessor?.getter ? ctx.abiOfCallable(nextAccessor.getter)?.result : null)
  if (!nextCallable || nextCallable.kind !== 'function-value-dispatch') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRecord.kind}`,
      `advances a "${iteratorRecord.kind}" iterator-record with no callable "next" field; the general iterator protocol has nothing else to call`
    )
  }
  // An async iterator's `next()` answers a promise of the `{ value, done }`
  // record (27.1.1.3), which `for await` awaits before reading it
  // (7.4.3 via AsyncIteratorNext's Await). Only async iteration can reach a
  // promise here: a sync iterator's result must itself carry `done`, which
  // the checker proves a Promise does not.
  const promised = nextCallable.abi.result
  const awaits = promised.kind === 'promise'
  const resultRepresentation = promised.kind === 'promise' ? promised.value : promised
  const resultFields = iteratorRecordFieldsOf(ctx, resultRepresentation)
  const resultAccessors = iteratorRecordAccessorsOf(ctx, resultRepresentation)
  // `IteratorResult<T>` IS a discriminated union in TypeScript's own library
  // -- `IteratorYieldResult<T> | IteratorReturnResult<TReturn>` -- so a
  // hand-written `next(): IteratorResult<number>` publishes a tagged union of
  // two records, not one record. Both arms carry `value` and `done`; which
  // arm is live is the tag, and the read dispatches on it exactly as any
  // other union member read does.
  if (resultRepresentation.kind === 'tagged-union') {
    emitUnionResultIteratorNext(
      ctx,
      lines,
      operation,
      iteratorRecord,
      nextCallable.abi,
      nextField,
      nextAccessor,
      resultRepresentation,
      awaits
    )
    return
  }
  if (
    (resultFields === null && resultAccessors === null) ||
    (resultRepresentation.kind !== 'record' && resultRepresentation.kind !== 'native-record-ref')
  ) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${resultRepresentation.kind}`,
      `calls a "next()" whose own result is carried as "${resultRepresentation.kind}", but the general iterator protocol only ever ` +
        'publishes a record result for it -- the `{ value, done }` pair ECMA-262 7.4.3 `IteratorNext` returns'
    )
  }
  const hasMember = (key: string): boolean =>
    (resultFields?.some((field) => field.key === key) ?? false) || (resultAccessors?.some((accessor) => accessor.key === key) ?? false)
  if (!hasMember('value') || !hasMember('done')) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${resultRepresentation.kind}`,
      'calls a "next()" whose result record has no "value"/"done" field pair to read the iteration result out of'
    )
  }
  const receiverText = operandText(ctx, operation.iterator)
  const receiverAccessor = memberAccessOperator(iteratorRecord.ownership)
  const nextText = nextField
    ? `${receiverText}${receiverAccessor}${cppRecordFieldName('next')}`
    : nextAccessor?.getter
      ? iteratorGetterText(ctx, nextAccessor.key, nextAccessor.getter, operation.iterator, 'iterator-next')
      : null
  if (nextText === null)
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRecord.kind}`,
      'cannot resolve the iterator next method'
    )
  const called = iteratorMethodCallText(ctx, nextText, nextCallable.abi, operation.iterator, 'iterator next()')
  const callText = awaits ? settledPromiseText(ctx, called) : called
  // A fresh local, hoisted exactly as `defineValue` hoists every other IR
  // result -- this one just names no semantic result of its own, because
  // `IteratorResult` as a whole is never published as one value (`next`'s own
  // "value" role is the payload half; "done" is the sibling `iterator-done`
  // step reads out of the SAME call, below).
  const tempName = `v${ctx.nextValueOrdinal}`
  ctx.nextValueOrdinal += 1
  ctx.declarations.push({ name: tempName, type: cppTypeOf(resultRepresentation) })
  lines.push(`${tempName} = ${callText};`)
  const resultAccessor = memberAccessOperator(resultRepresentation.ownership)
  const name = defineValue(ctx, operation.result)
  const memberText = (key: 'value' | 'done'): string => {
    if (resultFields?.some((field) => field.key === key)) return `${tempName}${resultAccessor}${cppRecordFieldName(key)}`
    const accessor = resultAccessors?.find((candidate) => candidate.key === key)
    if (!accessor?.getter) {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:iterator:next:${resultRepresentation.kind}`,
        `reads iterator result ${key} through an accessor with no getter body`
      )
    }
    const environment = accessorEnvironmentArguments(ctx, resultRepresentation, key, accessor.getter, 'getter', tempName)
    return `${cppBodyName(accessor.getter)}(${[...environment, tempName].join(', ')})`
  }
  ctx.protocolNextResults.set(operation.iterator.value, {
    tempName,
    accessor: resultAccessor,
    valueName: name,
    valueText: memberText('value'),
    doneText: memberText('done')
  })
}

/**
 * `for await` over an async generator: 27.1.4.4 AsyncIteratorNext is ONE call
 * of `next()` whose promise settles to the whole step -- `done`, the yielded
 * value and the completion -- so the step is awaited once into a local of the
 * generator's own `AsyncIteratorResult` and the paired `iterator-done` reads
 * the same local (`ctx.protocolNextResults`, as a hand-written iterator's
 * cached record is read). The value is read only when the step is not done:
 * a done step's `value` is the completion, which the loop never binds.
 */
const emitAsyncGeneratorNext = (
  ctx: EmitContext,
  lines: string[],
  operation: IteratorNextOperation,
  generator: Extract<Representation, { kind: 'async-generator' }>
): void => {
  if (operation.value) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:async-iterator:next:async-generator',
      'carries a "value" argument; `for await` calls next() with none'
    )
  }
  const tempName = `v${ctx.nextValueOrdinal}`
  ctx.nextValueOrdinal += 1
  ctx.declarations.push({ name: tempName, type: `${cppTypeOf(generator)}::Result` })
  lines.push(`${tempName} = ${settledPromiseText(ctx, `${operandText(ctx, operation.iterator)}.next()`)};`)
  const name = defineValue(ctx, operation.result)
  const valueText = alignedValueText(
    ctx,
    'emit-iterator.ts:async-generator-next',
    generator.element,
    operation.result.representation,
    `${tempName}.value`
  )
  if (valueText === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(generator.element)}->${representationKey(operation.result.representation)}`,
      `reads an async generator's "${representationKey(generator.element)}" element into a ` +
        `"${representationKey(operation.result.representation)}" binding, and no conversion is installed`
    )
  }
  ctx.protocolNextResults.set(operation.iterator.value, {
    tempName,
    accessor: '.',
    valueName: name,
    valueText,
    doneText: `${tempName}.done`
  })
}

/**
 * `for await` over a sync cursor (27.1.6 CreateAsyncFromSyncIterator): the
 * cursor steps as a `for`-`of` would, and a value it yields is then awaited
 * before the loop binds it -- a promise adopted, a plain value settled on a
 * later tick, as `%AsyncFromSyncIteratorPrototype%.next` resolves it. Only a
 * value that is there is awaited: an exhausted step binds nothing.
 */
const emitAsyncFromSyncNext = (
  ctx: EmitContext,
  lines: string[],
  operation: IteratorNextOperation,
  cursor: Extract<Representation, { kind: 'iterator' }>
): void => {
  const name = defineValue(ctx, operation.result)
  const result = operation.result.representation
  const raw = '__gea_next'
  const iterator = operandText(ctx, operation.iterator)
  let settle: readonly string[]
  if (suspendsInPlace(ctx)) {
    // Two ticks, as in the language: the wrapper's `then` on the value
    // (AsyncFromSyncIteratorContinuation) settles `next()`'s own promise, and
    // the loop's Await of that promise is the second. One fewer and the loop
    // overtakes every other task by a step per iteration.
    settle = [
      ...coroutineAwaitStatements(ctx, 'emit-iterator.ts:async-from-sync', cursor.element, raw, result, name),
      `${name} = ${awaitTickText(result, name)};`
    ]
  } else if (ctx.abi === null) {
    // The top level of a module is the one frame that may read a promise in place.
    const settled = awaitedText(ctx, 'emit-iterator.ts:async-from-sync', cursor.element, raw, result) ?? raw
    settle = [`${name} = ${settled};`]
  } else {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:async-iterator:next:iterator',
      "awaits a sync cursor's value outside a coroutine frame, where reading the promise in place would pump the event loop on this stack"
    )
  }
  lines.push(`{ auto ${raw} = ${iterator}.arrayNext(); if (!${iterator}.done()) { ${settle.join(' ')} } }`)
}

export const emitIteratorNext = (ctx: EmitContext, lines: string[], operation: IteratorNextOperation): void => {
  const iteratorRepresentation = operation.iterator.representation
  if (iteratorRepresentation.kind === 'dynamic') {
    if (operation.value) {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:iterator:next:dynamic',
        'passes a value to a dynamic iterator step; ordinary iterator consumption calls next() with no arguments'
      )
    }
    const stepName = `v${ctx.nextValueOrdinal}`
    ctx.nextValueOrdinal += 1
    ctx.declarations.push({ name: stepName, type: 'gea::runtime::iterator::Step' })
    const doneState = ctx.dynamicIteratorDoneStates.get(operation.iterator.value)
    if (!doneState) {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:iterator:next:dynamic',
        'advances a dynamic iterator with no exhaustion state from its get-iterator step'
      )
    }
    lines.push(
      `${stepName} = ${doneState} ? gea::runtime::iterator::Step{} : ` +
        `gea::runtime::iterator::step(${operandText(ctx, operation.iterator)});`
    )
    lines.push(`${doneState} = ${stepName}.done;`)
    ctx.dynamicIteratorSteps.set(operation.iterator.value, stepName)
    const name = defineValue(ctx, operation.result)
    const result = operation.result.representation
    if (result.kind === 'dynamic') {
      lines.push(`${name} = ${stepName}.value;`)
      return
    }
    // A destructuring position can carry `E | undefined`: IteratorStep's
    // exhausted answer is the language value `undefined`, not a default C++
    // element.  The same checked dynamic conversions that ordinary property
    // reads use reconcile both outcomes.  This deliberately has no raw cast:
    // a typed pattern over a dynamic iterator is valid only where both its
    // element and its exhausted value have installed conversions.
    const absent = alignedValueText(ctx, 'emit-iterator.ts:815', { kind: 'undefined' }, result, cppUndefinedValue)
    const present = alignedValueText(
      ctx,
      'emit-iterator.ts:816',
      { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
      result,
      `${stepName}.value`
    )
    if (absent === null || present === null) {
      throw createCppEmitBlockedError(
        `conversion:dynamic->${representationKey(result)}`,
        `reads a dynamic iterator element into a "${representationKey(result)}" result, but no checked conversion handles both ` +
          'the yielded value and IteratorStep exhaustion'
      )
    }
    lines.push(`${name} = ${stepName}.done ? (${absent}) : (${present});`)
    return
  }
  if (iteratorRepresentation.kind === 'record' || iteratorRepresentation.kind === 'native-record-ref') {
    emitDynamicIteratorNext(ctx, lines, operation, iteratorRepresentation)
    return
  }
  if (iteratorRepresentation.kind === 'async-generator') {
    emitAsyncGeneratorNext(ctx, lines, operation, iteratorRepresentation)
    return
  }
  if (iteratorRepresentation.kind !== 'iterator') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRepresentation.kind}`,
      `advances a "${iteratorRepresentation.kind}" iterator-record, but the only "next" step this backend lowers advances an "iterator" cursor`
    )
  }
  if (operation.value) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:iterator:next:iterator',
      'carries a "value" argument; the array-native fast path never consumes one (the standard Array Iterator\'s own .next takes none)'
    )
  }
  if (operation.settlesValue) {
    emitAsyncFromSyncNext(ctx, lines, operation, iteratorRepresentation)
    return
  }
  const name = defineValue(ctx, operation.result)
  const element = iteratorRepresentation.element
  const result = operation.result.representation
  if (representationKey(result) === representationKey(element)) {
    // A string element is stored in place: `name = arrayNext()` copied it out
    // and then moved it in, and libstdc++ moves an inline string with a
    // `memcpy` call on its length.
    if (element.kind === 'string') lines.push(`gea::detail::nextInto(${operandText(ctx, operation.iterator)}, ${name});`)
    else lines.push(`${name} = ${operandText(ctx, operation.iterator)}.arrayNext();`)
    return
  }
  // An absence-capable read: the position may lie past the cursor's end, and
  // `arrayNext()` on an exhausted cursor sets `done()` rather than throwing,
  // so the result's own absence is what an exhausted step yields
  // (`lower-destructuring.ts`'s `lowerArrayPatternIteratorRead`).
  const absent = alignedValueText(ctx, 'emit-iterator.ts:854', { kind: 'undefined' }, result, cppUndefinedValue)
  const present = alignedValueText(ctx, 'emit-iterator.ts:855', element, result, '__gea_next')
  if (absent === null || present === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(element)}->${representationKey(result)}`,
      `reads an "${representationKey(element)}" cursor element into a "${representationKey(result)}" result, and no conversion is installed`
    )
  }
  const cursor = operandText(ctx, operation.iterator)
  lines.push(`{ auto __gea_next = ${cursor}.arrayNext(); ${name} = ${cursor}.done() ? (${absent}) : (${present}); }`)
}

export const emitIteratorDone = (ctx: EmitContext, lines: string[], operation: IteratorDoneOperation): void => {
  const iteratorRepresentation = operation.iterator.representation
  if (iteratorRepresentation.kind === 'dynamic') {
    const step = ctx.dynamicIteratorSteps.get(operation.iterator.value)
    if (!step) {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:iterator:next:dynamic',
        'reads a dynamic iterator result before its paired next() step produced the shared value/done record'
      )
    }
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${step}.done;`)
    return
  }
  if (
    iteratorRepresentation.kind === 'record' ||
    iteratorRepresentation.kind === 'native-record-ref' ||
    iteratorRepresentation.kind === 'async-generator'
  ) {
    // The paired `next` step (`emitDynamicIteratorNext`) always runs first --
    // see its own header comment -- and always caches its call's result here
    // before this step can be reached, so a miss means the two have somehow
    // become decoupled rather than that this receiver is unsupported.
    const cached = ctx.protocolNextResults.get(operation.iterator.value)
    if (!cached) {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:iterator:next:${iteratorRepresentation.kind}`,
        'reads "done" off a "record" iterator-record before its paired "next" step cached a result to read it from'
      )
    }
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${cached.doneText};`)
    lines.push(`if (!${name}) ${cached.valueName} = ${cached.valueText};`)
    return
  }
  if (iteratorRepresentation.kind !== 'iterator') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:next:${iteratorRepresentation.kind}`,
      `reads "done" off a "${iteratorRepresentation.kind}" iterator-record, but the only shape this backend lowers is an "iterator" cursor`
    )
  }
  const name = defineValue(ctx, operation.result)
  lines.push(`${name} = ${operandText(ctx, operation.iterator)}.done();`)
}

const staticallyObjectCloseResult = (representation: Representation): boolean => {
  if (representation.kind === 'record' || representation.kind === 'native-record-ref') return true
  return representation.kind === 'tagged-union' && representation.arms.every((arm) => staticallyObjectCloseResult(arm.value))
}

/** Statements implementing IteratorClose for either an admitted dynamic value or a concrete typed iterator record. */
const iteratorCloseStatements = (ctx: EmitContext, iterator: IteratorCloseOperation['iterator']): readonly string[] => {
  const representation = iterator.representation
  const receiver = operandText(ctx, iterator)
  if (representation.kind === 'dynamic') return [`gea::runtime::iterator::close(${receiver});`]
  // 7.4.13 AsyncIteratorClose: call `return()` and AWAIT its promise before
  // the loop's own completion continues -- the generator's `finally` blocks,
  // awaits included, run inside that wait.
  if (representation.kind === 'async-generator') {
    // `return()` is called with no argument, and nothing can observe what the
    // completion channel holds for it: the close's result is discarded, a
    // `finally` cannot read the pending return value, and every later `next()`
    // answers `{ value: undefined, done: true }` whatever it was. So a valued
    // completion channel (`AsyncGenerator<T, string>`) takes its empty storage
    // rather than refusing a value no one reads.
    return [`(void)${settledPromiseText(ctx, `${receiver}.return_()`)};`]
  }
  if (representation.kind === 'iterator') {
    if (representation.source !== 'generator') {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:iterator:close:iterator',
        'cannot close a non-generator native sequence cursor'
      )
    }
    const absent =
      representation.completion.kind === 'undefined' || representation.completion.kind === 'void'
        ? '{}'
        : cppUndefinedIn(representation.completion)
    if (absent === null) {
      throw createCppEmitBlockedError(
        `conversion:undefined->${representationKey(representation.completion)}`,
        `calls generator return() without a value, but its completion channel "${representationKey(representation.completion)}" cannot carry undefined`
      )
    }
    return [`(void)(${receiver}.resumeReturn(${absent}));`]
  }
  if (representation.kind !== 'record' && representation.kind !== 'native-record-ref') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${representation.kind}`,
      `cannot close an iterator carried as "${representation.kind}"`
    )
  }
  const fields = iteratorRecordFieldsOf(ctx, representation)
  const returnField = fields?.find((field) => field.key === 'return')
  const returnAccessor = iteratorRecordAccessorsOf(ctx, representation)?.find((accessor) => accessor.key === 'return')
  if (!returnField && !returnAccessor) return []
  // `Iterator<T>`'s own `return?(...)` is an OPTIONAL method, so the field's
  // carrier is `optional(function-value-dispatch)` for every hand-written
  // iterator object that omits it. The payload is the convention to call; the
  // optional is a second presence question, answered beside the field's own
  // presence bit below rather than refused.
  const declared = returnField?.value ?? (returnAccessor?.getter ? ctx.abiOfCallable(returnAccessor.getter)?.result : null)
  const optionalReturn = declared?.kind === 'optional'
  const callable = declared?.kind === 'optional' ? declared.payload : declared
  if (!callable || callable.kind !== 'function-value-dispatch') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${representation.kind}`,
      `reads a typed iterator return method carried as "${callable?.kind ?? 'absent'}", not a callable dispatch value`
    )
  }
  const access = memberAccessOperator(representation.ownership)
  const method = returnField
    ? `${optionalReturn ? `(*${receiver}${access}${cppRecordFieldName('return')})` : `${receiver}${access}${cppRecordFieldName('return')}`}`
    : returnAccessor?.getter
      ? iteratorGetterText(ctx, returnAccessor.key, returnAccessor.getter, iterator, 'iterator-close')
      : null
  if (method === null)
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${representation.kind}`,
      'cannot resolve the iterator return method'
    )
  const called = iteratorMethodCallText(ctx, method, callable.abi, iterator, 'iterator return()')
  // An async iterator's `return()` answers a promise of the record, and
  // AsyncIteratorClose awaits it (7.4.13 step 5) before checking the record:
  // mongodb's `onData.return()` resolves only once its listeners are gone.
  // Only async iteration reaches a promise here, for the reason
  // `emitDynamicIteratorNext` gives about `next`.
  const awaitsClose = callable.abi.result.kind === 'promise'
  const call = awaitsClose ? settledPromiseText(ctx, called) : called
  const result = callable.abi.result.kind === 'promise' ? callable.abi.result.value : callable.abi.result
  const invoke =
    result.kind === 'dynamic'
      ? `gea::runtime::iterator::validateCloseResult(${call});`
      : staticallyObjectCloseResult(result)
        ? `(void)(${call});`
        : `{ (void)(${call}); gea::runtime::iterator::throwNotIterable("iterator return method returned a non-object value"); }`
  if (!returnField) return [invoke]
  const guards = [
    ...(returnField.required ? [] : [`${receiver}${access}${cppRecordFieldPresenceName('return')}`]),
    ...(optionalReturn ? [`${receiver}${access}${cppRecordFieldName('return')}.has_value()`] : [])
  ]
  if (guards.length === 0) return [invoke]
  return [`if (${guards.join(' && ')}) { ${invoke} }`]
}

const iteratorCloseWhileOpenStatements = (
  ctx: EmitContext,
  iterator: IteratorCloseOperation['iterator'],
  onlyIfOpen: boolean
): readonly string[] => {
  const close = iteratorCloseStatements(ctx, iterator)
  if (!onlyIfOpen || close.length === 0) return close
  const representation = iterator.representation
  const condition =
    representation.kind === 'dynamic'
      ? (() => {
          const done = ctx.dynamicIteratorDoneStates.get(iterator.value)
          if (!done)
            throw createCppEmitBlockedError(
              'runtime-helper:protocol:iterator:close:dynamic',
              'conditionally closes a dynamic iterator with no exhaustion state'
            )
          return `!${done}`
        })()
      : representation.kind === 'iterator'
        ? `!${operandText(ctx, iterator)}.done()`
        : null
  if (condition === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${representation.kind}`,
      `conditionally closes a "${representation.kind}" iterator without a persistent exhaustion state`
    )
  }
  return [`if (${condition}) { ${close.join(' ')} }`]
}

/** Direct IteratorClose; a close failure propagates when no throw completion is already pending. */
export const emitIteratorClose = (ctx: EmitContext, lines: string[], operation: IteratorCloseOperation): void => {
  lines.push(...iteratorCloseWhileOpenStatements(ctx, operation.iterator, operation.onlyIfOpen))
}

/**
 * Whether this iterator's IteratorClose suspends in place: a `for await` in a
 * coroutine frame closing an async generator, or a hand-written async iterator
 * whose `return()` answers a promise (7.4.13 AsyncIteratorClose awaits it).
 * Such a close can live in neither a scope guard's lambda nor a `catch`
 * handler -- C++ admits a `co_await` in neither -- so its region renders
 * through `renderSuspendingIteratorCloseRegion` instead.
 */
const closeSuspends = (ctx: EmitContext, iterator: IteratorCloseOperation['iterator']): boolean => {
  if (!suspendsInPlace(ctx)) return false
  const representation = iterator.representation
  if (representation.kind === 'async-generator') return true
  if (representation.kind !== 'record' && representation.kind !== 'native-record-ref') return false
  const returnField = iteratorRecordFieldsOf(ctx, representation)?.find((field) => field.key === 'return')
  const returnAccessor = iteratorRecordAccessorsOf(ctx, representation)?.find((accessor) => accessor.key === 'return')
  const declared = returnField?.value ?? (returnAccessor?.getter ? ctx.abiOfCallable(returnAccessor.getter)?.result : null)
  const callable = declared?.kind === 'optional' ? declared.payload : declared
  return callable?.kind === 'function-value-dispatch' && callable.abi.result.kind === 'promise'
}

/**
 * `renderIteratorCloseRegion` for a close that suspends (`closeSuspends`).
 *
 * The same three completions, each closing at a point a `co_await` may sit:
 *
 * - a jump out of the region that is not the loop's own continuation or
 *   exhaustion -- `break`, a labelled `continue` of an outer loop -- and every
 *   `return` close BEFORE the terminator runs, so the generator's `finally`
 *   (and its awaits) has finished when the loop's completion continues;
 * - a throw out of the body is caught, the handler only records it, and the
 *   close runs AFTER the handler has ended -- its own failure discarded
 *   (7.4.13 step 4) -- before the original is rethrown. A throw out of the
 *   step itself closes nothing, as in the synchronous region. The enclosing
 *   generator's own `return(v)`, arriving at a `yield` in the body, resumes
 *   as a synthetic `return` terminator (`emit.ts`'s `emitYield`) and closes
 *   through this region's `return` case like a written one.
 *
 * `armed` is what the scope guard's `dismiss()` is there: the continuation and
 * exhaustion edges disarm it, and each close disarms it first so no path
 * closes twice. Like the guard, it is re-initialized on every pass because the
 * continuation edge jumps to the region's label, outside this scope.
 *
 * A `switch` whose case leaves the region directly has no single point to
 * close before, and is refused by name rather than left unclosed.
 */
const renderSuspendingIteratorCloseRegion = (
  ctx: EmitContext,
  lines: string[],
  body: IrBody,
  region: IrIteratorCloseRegion,
  rendering: IteratorCloseRegionRendering,
  order: readonly IrBlockId[],
  guard: string
): readonly IrBlockId[] => {
  const kind = region.iterator.representation.kind
  if (region.onlyIfOpen) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${kind}`,
      'closes a finite pattern over an iterator whose close suspends; only `for await` closes one, and it never has a finite pattern'
    )
  }
  const selected = new Set(region.blocks)
  const nestedConsumed = new Set<IrBlockId>()
  const armed = `${guard}_armed`
  const thrown = `${guard}_thrown`
  const close = iteratorCloseStatements(ctx, region.iterator).join(' ')
  const closeNow = `if (${armed}) { ${armed} = false; ${close} }`
  const splitEntry =
    region.bodyEntry !== null &&
    region.bodyEntry !== region.entry &&
    order.includes(region.bodyEntry) &&
    !rendering.regionByTryEntry.has(region.bodyEntry) &&
    !rendering.iteratorCloseRegionByEntry.has(region.bodyEntry)
      ? region.bodyEntry
      : null
  const closingFlag = splitEntry === null ? null : `${guard}_in_body`
  lines.push(`${rendering.labelOf(rendering.labels, region.entry)}:`)
  lines.push('{')
  lines.push(`bool ${armed} = true;`)
  lines.push(`std::exception_ptr ${thrown};`)
  lines.push(`bool ${guard}_returning = false;`)
  if (closingFlag !== null) lines.push(`bool ${closingFlag} = false;`)
  lines.push('try {')
  const leaves = (target: IrBlockId): boolean => !selected.has(target) && !region.dismissTargets.includes(target)
  const scopedRendering: IteratorCloseRegionRendering = {
    ...rendering,
    emitTerminator: (inner, targetLines, labels, isSingleBlock, terminator) => {
      switch (terminator.kind) {
        case 'jump':
          if (region.dismissTargets.includes(terminator.target)) targetLines.push(`${armed} = false;`)
          else if (leaves(terminator.target)) targetLines.push(closeNow)
          break
        case 'branch': {
          const condition = operandText(inner, terminator.condition)
          if (region.dismissTargets.includes(terminator.whenTrue)) targetLines.push(`if (${condition}) ${armed} = false;`)
          else if (leaves(terminator.whenTrue)) targetLines.push(`if (${condition}) { ${closeNow} }`)
          if (region.dismissTargets.includes(terminator.whenFalse)) targetLines.push(`if (!${condition}) ${armed} = false;`)
          else if (leaves(terminator.whenFalse)) targetLines.push(`if (!${condition}) { ${closeNow} }`)
          break
        }
        case 'return':
          targetLines.push(closeNow)
          break
        case 'switch':
          if ([terminator.defaultTarget, ...terminator.cases.map((entry) => entry.target)].some(leaves)) {
            throw createCppEmitBlockedError(
              `runtime-helper:protocol:iterator:close:${kind}`,
              'leaves a `for await` loop straight out of a switch case, which has no single point to await the close before'
            )
          }
          break
        case 'throw':
          break
      }
      rendering.emitTerminator(inner, targetLines, labels, isSingleBlock, terminator)
    }
  }
  for (const id of order) {
    if (nestedConsumed.has(id)) continue
    const block = body.blocks.get(id)
    if (!block) throw createCppEmitBlockedError(`runtime-helper:protocol:iterator:close:${kind}`, `names missing body block ${id}`)
    const nested = id === region.entry ? undefined : rendering.regionByTryEntry.get(id)
    const nestedIterator = id === region.entry ? undefined : rendering.iteratorCloseRegionByEntry.get(id)
    if (nestedIterator) {
      const consumed = renderIteratorCloseRegion(ctx, lines, body, nestedIterator, scopedRendering)
      for (const consumedId of consumed) nestedConsumed.add(consumedId)
      continue
    }
    if (nested) {
      const consumed = renderTryRegion(ctx, lines, body, nested, scopedRendering)
      for (const consumedId of consumed) nestedConsumed.add(consumedId)
      continue
    }
    if (id !== region.entry) lines.push(`${rendering.labelOf(rendering.labels, id)}:`)
    if (closingFlag !== null && id === splitEntry) lines.push(`${closingFlag} = true;`)
    for (const operation of block.operations)
      rendering.emitOperation(ctx, lines, operation, (targetLines, terminator) =>
        scopedRendering.emitTerminator(ctx, targetLines, rendering.labels, rendering.isSingleBlock, terminator)
      )
    for (const write of rendering.mergeWrites.get(id) ?? []) lines.push(`${write.name} = ${operandText(ctx, write.value)};`)
    scopedRendering.emitTerminator(ctx, lines, rendering.labels, rendering.isSingleBlock, block.terminator)
  }
  // A program throw keeps its completion over the close's own failure
  // (7.4.13 step 4). Anything else leaving the body under an unwind is not a
  // throw completion -- a suspending finally's rethrow of a parked one, say --
  // and its close does report its failure (step 5): the same split the
  // synchronous region's scope guard makes.
  const returning = `${guard}_returning`
  lines.push(
    `} catch (const gea::Value&) { ${thrown} = std::current_exception(); } ` +
      `catch (...) { ${thrown} = std::current_exception(); ${returning} = true; }`
  )
  // Reached only through a handler: every block above ends in a terminator.
  const closing = `if (${armed}) { ${armed} = false; if (${returning}) { ${close} } else { try { ${close} } catch (const gea::Value&) {} } }`
  lines.push(closingFlag === null ? closing : `if (${closingFlag}) { ${closing} }`)
  lines.push(`std::rethrow_exception(${thrown});`)
  lines.push('}')
  return order
}

/**
 * Renders one general for-of iteration or finite destructuring sequence as a
 * real C++ protected scope. The catch closes before rethrowing while
 * preserving the original throw completion; the scope guard handles normal
 * finite completion and return/break/goto, where a throwing `return()` does
 * replace a pending non-throw completion. Loop continuation and exhaustion
 * targets dismiss it; finite patterns instead keep it armed through the end
 * and let the `onlyIfOpen` exhaustion test decide whether closure is needed.
 */
export const renderIteratorCloseRegion = (
  ctx: EmitContext,
  lines: string[],
  body: IrBody,
  region: IrIteratorCloseRegion,
  rendering: IteratorCloseRegionRendering
): readonly IrBlockId[] => {
  const guard = `__gea_iterator_close_${ctx.nextValueOrdinal++}`
  const selected = new Set(region.blocks)
  const nestedConsumed = new Set<IrBlockId>()
  const listed = body.blockOrder.filter((id) => selected.has(id) && id !== region.entry)
  if (!selected.has(region.entry))
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:iterator:close:${region.iterator.representation.kind}`,
      `does not include its declared body entry ${region.entry}`
    )
  // C++ enters the protected region by fallthrough after this label, so the
  // entry must render first even when block-order placed another reachable
  // body arm earlier for a separate CFG reason.
  const order: readonly IrBlockId[] = [region.entry, ...listed]
  if (closeSuspends(ctx, region.iterator)) return renderSuspendingIteratorCloseRegion(ctx, lines, body, region, rendering, order, guard)
  lines.push(`${rendering.labelOf(rendering.labels, region.entry)}:`)
  lines.push('{')
  const close = iteratorCloseWhileOpenStatements(ctx, region.iterator, region.onlyIfOpen)
  lines.push(`gea::runtime::iterator::CompletionGuard ${guard}{[&]() { ${close.join(' ')} }};`)
  // Which half of the region a throw came from. 14.7.5.7 closes for a throw
  // out of the BODY and not for one out of the step -- see
  // `IrIteratorCloseRegion.bodyEntry` -- and the two cannot be separate `try`
  // blocks because the head test's branch jumps into the body. One flag, set
  // where the body starts, lets the single handler tell them apart. It needs no
  // reset on the back edge: the continuation edge jumps to the region's LABEL,
  // which sits outside this scope, so coming round again re-enters the block
  // and re-runs both the guard's construction and this initializer.
  //
  // The flag is emitted only when the body's entry is a block this loop will
  // actually render. A finite pattern has no body, and a body entry consumed
  // by a nested region is rendered by that region's own recursion, so neither
  // gets the split and both keep closing exactly as before.
  const splitEntry =
    region.bodyEntry !== null &&
    region.bodyEntry !== region.entry &&
    order.includes(region.bodyEntry) &&
    !rendering.regionByTryEntry.has(region.bodyEntry) &&
    !rendering.iteratorCloseRegionByEntry.has(region.bodyEntry)
      ? region.bodyEntry
      : null
  const closingFlag = splitEntry === null ? null : `${guard}_in_body`
  if (closingFlag !== null) lines.push(`bool ${closingFlag} = false;`)
  lines.push('try {')
  const scopedRendering: IteratorCloseRegionRendering = {
    ...rendering,
    emitTerminator: (inner, targetLines, labels, isSingleBlock, terminator) => {
      if (terminator.kind === 'jump' && region.dismissTargets.includes(terminator.target)) targetLines.push(`${guard}.dismiss();`)
      if (terminator.kind === 'branch') {
        if (region.dismissTargets.includes(terminator.whenTrue))
          targetLines.push(`if (${operandText(inner, terminator.condition)}) ${guard}.dismiss();`)
        if (region.dismissTargets.includes(terminator.whenFalse))
          targetLines.push(`if (!${operandText(inner, terminator.condition)}) ${guard}.dismiss();`)
      }
      rendering.emitTerminator(inner, targetLines, labels, isSingleBlock, terminator)
    }
  }
  for (const id of order) {
    if (nestedConsumed.has(id)) continue
    const block = body.blocks.get(id)
    if (!block)
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:iterator:close:${region.iterator.representation.kind}`,
        `names missing body block ${id}`
      )
    const nested = id === region.entry ? undefined : rendering.regionByTryEntry.get(id)
    const nestedIterator = id === region.entry ? undefined : rendering.iteratorCloseRegionByEntry.get(id)
    if (nestedIterator) {
      const consumed = renderIteratorCloseRegion(ctx, lines, body, nestedIterator, scopedRendering)
      for (const consumedId of consumed) nestedConsumed.add(consumedId)
      continue
    }
    if (nested) {
      const consumed = renderTryRegion(ctx, lines, body, nested, scopedRendering)
      for (const consumedId of consumed) nestedConsumed.add(consumedId)
      continue
    }
    if (id !== region.entry) lines.push(`${rendering.labelOf(rendering.labels, id)}:`)
    if (closingFlag !== null && id === splitEntry) lines.push(`${closingFlag} = true;`)
    for (const operation of block.operations)
      rendering.emitOperation(ctx, lines, operation, (targetLines, terminator) =>
        scopedRendering.emitTerminator(ctx, targetLines, rendering.labels, rendering.isSingleBlock, terminator)
      )
    for (const write of rendering.mergeWrites.get(id) ?? []) lines.push(`${write.name} = ${operandText(ctx, write.value)};`)
    scopedRendering.emitTerminator(ctx, lines, rendering.labels, rendering.isSingleBlock, block.terminator)
  }
  lines.push('} catch (const gea::Value&) {')
  if (closingFlag === null) lines.push(`try { ${guard}.close(); } catch (const gea::Value&) {}`)
  else lines.push(`if (${closingFlag}) { try { ${guard}.close(); } catch (const gea::Value&) {} } else { ${guard}.dismiss(); }`)
  lines.push('throw;')
  lines.push('}')
  lines.push('}')
  return order
}

/**
 * The `protocol:enumerate:get-iterator:*` rows this file renders, stated here
 * rather than in `manifest.ts` so the claim and the rendering are one
 * authority -- the same discipline `emit-in.ts`'s `hasPropertyHelperClaims`
 * follows for `k in o`. `record`/`record-with-index`/`class-ref` are the
 * compiler's own struct kinds; `native-record-ref` is claimed too, even
 * though `emitStaticEnumerateIterator` refuses the one sub-shape of it
 * (a host-named struct) that has no field dispatcher to call, because a
 * refusal INSIDE an implemented capability is exactly what preflight's
 * carrier-suffixed obligation keys cannot see coming (they key on the
 * receiver's REPRESENTATION kind, not on the declaration behind it) -- the
 * same posture `nativeSidecarReceiver`'s own ownership refusal takes in
 * `emit-dynamic-properties.ts`. `dynamic` is the genuinely dynamic sibling:
 * a real runtime walk, not a claim over a boxed guess.
 *
 * The native cursor override (`representation/publish.ts`'s
 * `nativeCursorIteratorOf`) publishes `iterator(string)`, whose paired
 * `next` is the shared `protocol:enumerate:next:iterator` row in the
 * manifest. Enumeration never carries the general iterator protocol's
 * synthetic `{ next }` record, so there is deliberately no
 * `protocol:enumerate:next:record` claim here.
 *
 * `native-handle` (`Math`, `Array.prototype`, ...) is claimed for the reason
 * `representation/publish.ts`'s own comment on the identical addition gives:
 * ECMA-262 declares every own property of a host intrinsic non-enumerable, so
 * `emitNativeHandleEnumerateIterator` below builds the cursor from an empty
 * key vector rather than reading any table -- there is no table to read.
 */
export const enumerateHelperClaims: readonly string[] = [
  'protocol:enumerate:get-iterator:native-sum',
  'protocol:enumerate:get-iterator:undefined',
  'protocol:enumerate:get-iterator:null',
  'protocol:enumerate:get-iterator:record',
  'protocol:enumerate:get-iterator:record-with-index',
  'protocol:enumerate:get-iterator:class-ref',
  'protocol:enumerate:get-iterator:native-record-ref',
  'protocol:enumerate:get-iterator:dynamic',
  'protocol:enumerate:get-iterator:native-handle',
  'protocol:enumerate:get-iterator:function-value-dispatch',
  // `for`-`in` over an array -- `emitArrayEnumerateIterator` above. Claimed
  // only for the shared-refcount ownership that branch requires: an array's
  // expando half is keyed on the object's own identity, which a by-value
  // carrier does not have, and the branch falls through without it.
  'protocol:enumerate:get-iterator:array-object'
]

/**
 * The general `for`-`of`/`Symbol.iterator` protocol's own rows -- a class
 * instance or a plain object whose `[Symbol.iterator]()` is a real,
 * program-written method, stated here for the same one-authority reason
 * `enumerateHelperClaims` is, even though two of the five steps this claims
 * render through machinery this file does not own:
 *
 * - `get-method` lowers as an ordinary `[[Get]]` (`ir/lower-protocol.ts`'s
 *   `get-method` case reuses `ctx.builder.get`, exactly as an object-pattern
 *   property read does), rendered by `emit-properties.ts`'s own `emitGet` --
 *   `classMemberText` for `class-ref`, the plain struct-field fallback for
 *   `record`. The claim is stated here anyway, next to the producer
 *   (`producers/protocol.ts`) that resolves WHICH member to read: an ordinary
 *   source-level `obj.method` read carries no `runtime-helper` obligation at
 *   all (`preflight/runtime-helper-key.ts`'s `runtimeHelperKey` has no case
 *   for the property family), so this key exists only because THIS producer
 *   mints a `protocol`-family step for it, and the file that mints the step
 *   is the more honest place to answer for it than the file that happens to
 *   render whatever `[[Get]]` shape any receiver resolves to.
 * - `get-iterator` and `next` are rendered by `emitDynamicGetIterator` and
 *   `emitDynamicIteratorNext`/`emitIteratorDone` above.
 *
 * `class-ref` and `record` only -- never the bare `record` a program-defined
 * tuple also carries: `preflight/runtime-helper-key.ts`'s
 * `iteratorMethodCarrierKind` refines a "record" receiver with no
 * discoverable `@@iterator` FIELD (an open tuple, whose iterator is
 * `Array.prototype`'s own) to the deliberately unclaimed
 * `record(no-iterator-method)` sibling, so this claim never has to cover a
 * shape `emitDynamicGetIterator`'s struct-field read cannot find. The same
 * refinement applies to `get-method`, over the identical receiver operand.
 *
 * `next:record` is not scoped by receiver kind: `next`'s own carrier is the
 * iterator-record `get-iterator` published, which for BOTH `class-ref` and
 * `record` receivers is normally the identical synthetic
 * `{ next(): { value, done } }` shape `iteratorMethodAndRecordTypes`
 * (`producers/protocol.ts`) builds -- so one claim covers the step regardless
 * of which receiver produced it.
 *
 * `next:iterator` is that same step's other possible carrier: the resolved
 * `[Symbol.iterator]` was itself a GENERATOR method, so
 * `generatorRecordTypeOf` (`producers/protocol.ts`) published the real
 * `Generator<T>` structural type in place of the synthetic record, and
 * `representation/derive.ts`'s own `GeneratorDeclarationPolicy` carries that
 * as the native `gea::Iterator<T>` cursor -- `emitIteratorNext`/
 * `emitIteratorDone`'s existing "iterator" branches read it, unchanged.
 */
const generalIteratorHelperShapes: readonly string[] = [
  'get-method:class-ref',
  'get-method:record',
  // A NAMED shape declaring `[Symbol.iterator]()` reaches the identical
  // struct-field read a structural record's does -- `emitDynamicGetIterator`
  // never looks at the receiver's kind, only at the resolved method operand --
  // and `runtime-helper-key.ts`'s `iteratorMethodCarrierKind` applies the same
  // fail-closed refinement to it, so a named shape WITHOUT the member is
  // refused by name rather than certified here.
  'get-method:native-record-ref',
  'get-iterator:class-ref',
  'get-iterator:record',
  'get-iterator:native-record-ref',
  'next:record',
  // Same step, named receiver: `emitIteratorNext` resolves a named layout
  // through the identical field read, so the claim follows the emitter rather
  // than stopping at the structural half of one carrier pair.
  'next:native-record-ref',
  'next:iterator'
]

/**
 * The dynamic-source rows are intentionally separate from the structural
 * method rows above.  Only a source the program declared `any`/`unknown`
 * reaches these; `runtime::iterator` performs GetIterator/IteratorNext over
 * its `Value` without converting any statically typed iterable to a box.
 */
const dynamicValueIteratorHelperShapes: readonly string[] = ['get-iterator:dynamic', 'next:dynamic', 'close:dynamic']

/**
 * The general protocol's claims, for BOTH iteration protocols over the same
 * six receiver shapes.
 *
 * `async-iterator` renders through the same code, and the claim says so rather
 * than leaving the async rows silently unclaimed: `emitGetIterator` branches
 * only on `enumerate`, and the `[[Get]]` of the well-known symbol and the call
 * are the same. What differs is inside the steps, not the claim: a record's
 * `next()` answering a promise is `co_await`ed in a coroutine frame
 * (`settledPromiseText`), and a sync cursor's value under `for await` is
 * awaited after the step (`emitAsyncFromSyncNext`).
 *
 * Derived from one list rather than written twice, so a shape added for one
 * protocol cannot be forgotten for the other.
 */
export const dynamicIteratorHelperClaims: readonly string[] = [
  ...generalIteratorHelperShapes.map((shape) => `protocol:iterator:${shape}`),
  ...generalIteratorHelperShapes.map((shape) => `protocol:async-iterator:${shape}`),
  ...dynamicValueIteratorHelperShapes.map((shape) => `protocol:iterator:${shape}`),
  'protocol:iterator:close:record',
  'protocol:iterator:close:native-record-ref',
  'protocol:iterator:close:iterator'
]

/**
 * `for`-`of` over a fixed-arity tuple, which is not a "dynamic" protocol row
 * at all despite sitting next to them: no `@@iterator` is fetched and no
 * method is called, because the position count is a compile-time fact and
 * `emitStaticTupleIterator` above unrolls it.
 *
 * `record(tuple-values)` is `preflight/runtime-helper-key.ts`'s refinement of
 * a positional "record" receiver whose positions all share one carrier -- the
 * sibling of the deliberately unclaimed `record(no-iterator-method)` a
 * heterogeneous tuple keeps, which refuses at preflight rather than reaching
 * an emitter with one `gea::Iterator<E>` to build and two different `E`s.
 *
 * There is no `get-method` row: the producer takes this source down the native
 * fast path (`producers/shared.ts`'s `hasNativeIterationCursor`), which mints
 * no `get-method` step to answer for. `next` needs no row either, for the
 * reason `enumerateHelperClaims` states about its own: the cursor this
 * publishes is an `iterator`, so its paired step resolves the already-claimed
 * `protocol:iterator:next:iterator`.
 */
export const staticTupleIteratorHelperClaims: readonly string[] = ['protocol:iterator:get-iterator:record(tuple-values)']
