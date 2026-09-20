import { nativePrototypeObjectText } from './native-prototype.js'
import type { CallableAbi, Representation } from '../../../representation/model.js'
import { abiKey, representationKey } from '../../../representation/model.js'
import { abiOfCallee } from '../../../projection/callee.js'
import type { GetOperation, IrOperand } from '../../../ir/model.js'
import type { DeclarationId, FunctionId } from '../../../identity/ids.js'
import { runtimeClassLayoutsOf, type ClassLayout } from '../../../projection/classes.js'
import { classMethodOverrideOf, classPrototypeMethodMutableOf } from '../../../projection/fields.js'
import {
  bindingReference,
  captureFieldText,
  cppEnvironmentStructName,
  cppThunkName,
  createCppEmitBlockedError,
  operandText,
  type EmitContext,
  type ReactiveRevisionOrigin
} from '../emit-context.js'
import {
  classFamilyOverridesOf,
  classMemberOf,
  dispatchesStatically,
  reachableClassMethodsOf,
  classStaticFieldStorageOf,
  classStaticMemberOf,
  type ClassStaticFieldStorage
} from '../class-layout.js'
import { cppVirtualMemberName, virtualDispatchKey } from '../virtual-methods.js'
import {
  cppAbiParameterType,
  cppBodyName,
  cppCallableDeclarationTagName,
  cppClassName,
  cppConstructName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppResultTypeOf,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedIn
} from '../types.js'
import { alignedValueText, receiverBoundFieldText } from '../emit-narrowing.js'
import { computedOverriddenMethodValueText } from './computed-method-value.js'
import { nativePrototypeMethodFallbackText } from './native-prototype.js'
import { classMethodValueArmsOf, classPrototypeMethodKeysOf, classPrototypeMethodValueArmsOf } from '../../../projection/dispatch.js'

/**
 * Reading a class's own members as VALUES: an instance's methods and
 * accessors (`classMemberText`), and a class value's own static methods and
 * accessors (`classConstructorStaticMemberText`) -- `emit-properties.ts`'s
 * twin pair for the one receiver kind whose `[[Get]]` needs a class layout to
 * answer at all.
 *
 * Split out of `emit-properties.ts` (2026-09-03) to keep that file under the
 * architecture gate's per-file line cap -- a directory split, not a design
 * change: `emitGet` still dispatches here for a `class-ref`/`constructor-
 * family` receiver exactly as it dispatched to these same two functions when
 * they lived inline.
 */

/**
 * The `environment` half of the `CallableObject{invoke, environment}` a method
 * READ produces.
 *
 * `emitAllocateCallable` builds this for a closure literal; a method reached
 * through `[[Get]]` needs the identical thing and used to hard-code `nullptr`
 * for it. That is only correct when the method's body captures nothing. When
 * it does capture -- a class declared inside a function, whose method reads
 * that function's local -- the thunk casts the `void*` it is handed to the
 * body's environment struct and dereferences it unconditionally
 * (`translation-unit.ts` writes that cast), so a `nullptr` there is a null
 * dereference at the first captured read. It was reached, certified clean and
 * segfaulted: `.scratch/probe/capture` compiles, clang accepts it, and
 * `make(41)` dies on `gea_e->c0`. The environment is not optional information
 * this can default; it is the frame the body will read.
 *
 * The fields are read with `bindingReference` in the frame performing the
 * READ, which is the same rule `emitAllocateCallable` uses in the frame
 * performing the allocation -- and it is what makes this fail closed rather
 * than guess: a read from a frame that cannot name the captured cell raises
 * `bindingReference`'s own "a cell owned by another callable frame" refusal
 * instead of producing a pointer to nothing.
 *
 * Two shapes are refused outright rather than rendered, because this returns
 * an EXPRESSION and neither can be expressed without emitting a statement
 * first:
 *
 * - a BOXED slot, whose box `emitAllocateCallable` declares with
 *   `ensureBoxedSlotDeclared` ahead of the environment build;
 * - a captured RECEIVER, whose field is this frame's own `gea_this` -- which
 *   exists only if the reading frame has a receiver at all, a fact this
 *   expression-level path has no way to establish.
 */
const methodEnvironmentText = (ctx: EmitContext, callable: FunctionId, what: string): string => {
  const admission = ctx.captures.of(callable)
  if (admission.kind === 'none') return 'nullptr'
  if (admission.kind === 'refused') {
    throw createCppEmitBlockedError('capture:refused', `${what} reads a method whose environment cannot be built: ${admission.reason}`)
  }
  if (admission.layout.slots.some((slot) => slot.boxed)) {
    throw createCppEmitBlockedError(
      'capture:boxed',
      `${what} reads a method that captures a cell shared by aliasing; its box is declared by a statement, and a method read renders as an expression`
    )
  }
  if (admission.layout.receiver !== null) {
    throw createCppEmitBlockedError(
      'capture:receiver',
      `${what} reads a method that captures an enclosing frame's receiver; the environment would name this frame's own "this", which a method read cannot prove it has`
    )
  }
  const fields = admission.layout.slots.map((slot) => {
    const text = bindingReference(ctx, slot.declaration, `a capture of ${callable}`).name
    return slot.boxed ? text : captureFieldText(ctx, slot.declaration, slot.representation, text)
  })
  // Packed by the same authority the allocation path uses, so a method read
  // and a closure allocation of the same function agree on where the captured
  // state lives; `emitAllocateCallable` states the reasoning.
  return `gea::packEnvironment(${cppEnvironmentStructName(callable)}{${fields.join(', ')}})`
}

/**
 * The representation a materialized instance-method VALUE actually needs --
 * as opposed to `operation.result.representation`, which is what
 * `representation/derive.ts`'s `deriveSignature` publishes for it.
 *
 * `deriveSignature` derives a method's value representation purely from its
 * TS call signature, correctly: a method's declared TYPE never states an
 * implicit receiver parameter, so the `CallableAbi` it builds always has
 * `receiver: null`. But the C++ thunk this value actually points at
 * (`cppThunkName(site.method.callable)`, built by `translation-unit.ts`'s
 * `thunkOf`/`formalsOf`) gives every receiver-bearing body an EXPLICIT
 * leading receiver formal whenever `abi.receiver !== null` -- `cppAbiType`
 * (`types.ts`) documents the identical rule for spelling the type: "the
 * receiver (if any) as the first formal". A materialized value that keeps
 * the TS-derived, receiver-less type disagrees with the thunk it is built
 * from: the declared arity is missing the one argument the thunk requires,
 * and the one argument every caller that reaches it through `.call(receiver)`
 * -- `emit-iterator.ts`'s `emitDynamicGetIterator` is the caller that surfaced
 * this, calling exactly `${method}.call(${receiverText})` on the documented
 * assumption that `classMemberText` built the callable to expect it -- already
 * supplies.
 *
 * This has no effect on the common `obj.method()` case: that never
 * materializes this operation's value as a standalone `CallableObject` at
 * all (`emit-callable.ts`'s direct-call path calls the body by name once it
 * sees `ctx.directCallees`, without ever reading this text). It matters only
 * when a method is read as a first-class value and called separately from
 * where it was read -- rare in application code, but exactly the shape the
 * general iterator protocol mints (`get-method` and `get-iterator` are two
 * separate operations; `producers/protocol.ts`'s `mintIteratorSteps`) and,
 * per the `constructor-family`/`function-value-dispatch` split `cppTypeOf`
 * already documents, exactly as sound for a plain callback reference.
 *
 * A static member (`classConstructorStaticMemberText`, this file's twin) has
 * no receiver and needs no correction -- this helper is only ever called from
 * the instance-member path below.
 */
const boundMethodValueRepresentation = (operation: GetOperation): Representation => {
  const representation = operation.result.representation
  if (representation.kind !== 'function-value-dispatch') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(representation)}`,
      `reads a method as a value carried as "${representationKey(representation)}", not "function-value-dispatch"; ` +
        'this backend only knows how to bind a receiver onto that one carrier'
    )
  }
  // Some method-value representations already carry a receiver -- measured on
  // the real app corpus, which regressed (3 programs, `c++` 0/clang `-`)
  // under an earlier version of this fix that threw here instead. Whatever
  // published that receiver already agrees with the real thunk (those
  // programs were clang-clean before this function existed), so this only
  // fills the gap `deriveSignature`'s receiver-less TS-signature derivation
  // leaves; a value that already names one is left exactly as published.
  if (representation.abi.receiver !== null) return representation
  return { ...representation, abi: { ...representation.abi, receiver: operation.receiver.representation } }
}

/**
 * `classMemberText`'s result: the initializer expression, plus the DECLARED
 * type `emitGet` must give the value when it differs from
 * `operation.result.representation` -- non-null exactly when
 * `boundMethodValueRepresentation` corrected the receiver-less method-value
 * representation, so the declaration and the initializer agree on one type
 * instead of the declaration silently keeping the wrong one.
 */
export interface ClassMemberValue {
  readonly text: string
  readonly spelling: string | null
}

/**
 * `computedClassPrototypeMethodText`'s result: `ClassMemberValue` plus the
 * CARRIER its arms were materialised at.
 *
 * That text is never the whole read. `nativeSidecarGetText`
 * (`emit-dynamic-properties.ts`) puts it behind an OWN-property test -- 10.1.8.1
 * runs `OrdinaryGetOwnProperty` before the prototype walk -- so the read the
 * body finally prints is a ternary whose other arm is the expando/field
 * lookup, and a `?:` has one type. The prototype arm's carrier is not always
 * `operation.result.representation`: `boundMethodValueRepresentation` corrects
 * a method VALUE whose TS-derived signature declares no receiver onto the
 * convention its thunk really has, receiver first. Handing back only the
 * rendered text left the sidecar arm and the slot to be spelled from the
 * UNCORRECTED representation, and the three disagreed at once -- the arms
 * would not reconcile, and the call that consumed the value passed the
 * receiver `classMethodValueReceiverClaim` had already committed it to
 * (`v10.call(b1)` against a `CallableObject<Promise<std::string>()>`).
 *
 * So the carrier travels with the text, and the one authority that corrected
 * it is the one every consumer of the read reads it from.
 */
export interface ComputedPrototypeMethodValue extends ClassMemberValue {
  readonly carrier: Representation
}

/**
 * One prototype method materialised at the callable convention a particular
 * property read publishes.
 *
 * Kept beside `classMemberText` because a constant `object.method` read and a
 * computed `object[key]` read must build the identical function object.  The
 * latter merely chooses between several such objects at run time; it does not
 * get a second opinion about thunk ABIs, receiver binding or captured state.
 */
export const classMethodValueText = (
  ctx: EmitContext,
  operation: GetOperation,
  key: string,
  method: ClassLayout['methods'][number],
  // The carrier the read publishes: a bound-method convention for a typed
  // read, or the read's own `dynamic` carrier for a computed key the census
  // could not type (`d[String(k)]()`), which boxes the method with
  // `receivesThis` so the call's `callWithReceiver` hands the instance back.
  valueRepresentation: Representation = boundMethodValueRepresentation(operation),
  receiverText: string = operandText(ctx, operation.receiver),
  receiverRepresentation: Representation = operation.receiver.representation
): { readonly text: string; readonly type: string; readonly environment: string } => {
  if (!method.callable) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(operation.receiver.representation)}:get:false`,
      `method "${key}" names no body to take a function object of`
    )
  }
  const environment = methodEnvironmentText(ctx, method.callable, `a "get" of "${key}"`)
  const valueType = cppTypeOf(valueRepresentation)
  const bodyAbi = ctx.abiOfCallable(method.callable)
  if (bodyAbi === null) throw createCppEmitBlockedError('call-abi:class-method', `method "${key}" body has no callable convention`)
  const bodyRepresentation: Representation = { kind: 'function-value-dispatch', abi: bodyAbi }
  const owner = [...ctx.classes.values()].find((layout) =>
    layout.methods.some((entry) => entry.callable === method.callable && entry.key === key)
  )
  if (owner === undefined) throw createCppEmitBlockedError('call-abi:class-method-owner', `method "${key}" has no declaring prototype`)
  const payload = `${cppTypeOf(bodyRepresentation)}{&${cppThunkName(method.callable)}, ${environment}}`
  const override =
    receiverRepresentation.kind === 'class-ref' && !dispatchesStatically(ctx, operation.receiver)
      ? classMethodOverrideOf(ctx.classes, receiverRepresentation.declaration, key)
      : null
  const heldReceiver = override === null ? receiverText : 'gea_method_receiver'
  const state = `${heldReceiver}->gea_method_state`
  const bodyValue = `gea::nativeClassMethodValue<${cppClassName(owner.declaration)}, &${cppCallableDeclarationTagName(method.callable)}>(${state}, ${payload})`
  const materialized =
    alignedValueText(ctx, 'class-properties/emit-class-properties.ts:212', bodyRepresentation, valueRepresentation, bodyValue) ??
    // The published value declares no receiver while the body's convention
    // leads with one, so the receiver has to travel WITH the value
    // (`gea_runtime.h`'s `CallableObject::bindReceiver`). This is the arm half
    // of hono's `Router<T>.match`: the interface declares `match` a method and
    // `RegExpRouter` stores a `this`-typed FUNCTION under that name, so the
    // union's read publishes a receiver-less callable that every arm -- the
    // field one and the two genuine methods -- has to be able to produce. A
    // method arm cannot produce it any other way.
    //
    // Reached only where emission refused outright a line below, so nothing
    // that compiles today moves. It is not the detached-method case
    // `receiverBoundCallableText` guards with `readsReceiver`: that one is a
    // value handed on to a slot, where the language would supply no receiver
    // at all. What is NOT proven here is that this value is only ever called
    // as a method -- a program that detaches it (`const f = r.match; f(a, b)`,
    // which TypeScript admits through a method-declared member) would see the
    // read's receiver where the language gives `undefined`. hono writes the
    // two shapes that are exact: the call, and `router.match.bind(router)`.
    receiverBoundFieldText(ctx, bodyRepresentation, valueRepresentation, bodyValue, receiverRepresentation, heldReceiver)
  if (materialized === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(bodyRepresentation)}->${representationKey(valueRepresentation)}`,
      `method "${key}" body convention cannot fill its published bound-method convention`
    )
  }
  const publicAbi = abiOfCallee(valueRepresentation)
  const originalValue =
    publicAbi !== null && abiKey(publicAbi) !== abiKey(bodyAbi)
      ? `gea::nativeClassAdaptedMethodValue<${cppClassName(owner.declaration)}, &${cppCallableDeclarationTagName(method.callable)}, ${valueType}>(${state}, [&]() { return ${materialized}; })`
      : materialized
  const fallback = nativePrototypeMethodFallbackText(
    ctx,
    receiverRepresentation,
    key,
    owner,
    valueRepresentation,
    heldReceiver,
    originalValue,
    dispatchesStatically(ctx, operation.receiver)
  )
  if (override === null) return { text: fallback, type: valueType, environment }
  const ownedStorage = `${heldReceiver}->${cppRecordFieldName(key)}`
  const owned =
    alignedValueText(ctx, 'class-properties/emit-class-properties.ts:own-method', override.value, valueRepresentation, ownedStorage) ??
    // The own slot carries the METHOD's storage convention -- receiver first,
    // because that is the convention every writer into it was adapted to --
    // while this read publishes a receiver-less callable. Same conversion the
    // prototype half above needs, and for the same reason.
    receiverBoundFieldText(ctx, override.value, valueRepresentation, ownedStorage, receiverRepresentation, heldReceiver)
  if (owned === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(override.value)}->${representationKey(valueRepresentation)}`,
      `own method "${key}" storage cannot fill its published method-read convention`
    )
  }
  // Own function properties shadow the prototype without changing the
  // prototype's identity. Snapshot the receiver once, including detached reads.
  const text =
    `([&]() -> ${valueType} { const auto& ${heldReceiver} = ${receiverText}; ` +
    `if (${heldReceiver}->${cppRecordFieldPresenceName(key)}) return ${owned}; return ${fallback}; })()`
  return { text, type: valueType, environment }
}

const classDescendsFrom = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId, base: DeclarationId): boolean => {
  const seen = new Set<DeclarationId>()
  for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
    if (current === base) return true
    seen.add(current)
    current = classes.get(current)?.base ?? null
  }
  return false
}

const dynamicConstructorActualText = (ctx: EmitContext, target: CallableAbi, actual: CallableAbi, position: number): string => {
  const parameter = actual.parameters[position]
  if (parameter === undefined) {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `a dynamic constructor candidate has no parameter at position ${position}`
    )
  }
  const targetRest = target.restFrom
  if (targetRest !== null && position >= targetRest) {
    const packed = target.parameters[targetRest]
    if (packed === undefined || packed.value.kind !== 'array-object') {
      throw createCppEmitBlockedError(
        'call-abi:dynamic-constructor',
        `a dynamic constructor read publishes rest slot ${targetRest} without an array-object carrier`
      )
    }
    const packedName = `gea_constructor_arg_${targetRest}`
    const packedIndex = position - targetRest
    const absent = cppUndefinedIn(packed.value.element)
    if (absent === null) {
      throw createCppEmitBlockedError(
        `conversion:undefined->${representationKey(packed.value.element)}`,
        `a dynamic constructor rest array carries "${representationKey(packed.value.element)}", which cannot state an omitted argument`
      )
    }
    const source = `(${packedName} && ${packedName}->hasElementAtIndex(${packedIndex}) ? ${packedName}->elementAtIndex(${packedIndex}) : ${absent})`
    const converted = alignedValueText(ctx, 'class-properties/emit-class-properties.ts:259', packed.value.element, parameter.value, source)
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(packed.value.element)}->${representationKey(parameter.value)}`,
      `a dynamic constructor rest element carried as "${representationKey(packed.value.element)}" cannot fill candidate parameter ${position} carried as "${representationKey(parameter.value)}"`
    )
  }
  const source = target.parameters[position]
  if (source !== undefined) {
    const converted = alignedValueText(
      ctx,
      'class-properties/emit-class-properties.ts:268',
      source.value,
      parameter.value,
      `gea_constructor_arg_${position}`
    )
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source.value)}->${representationKey(parameter.value)}`,
      `dynamic constructor parameter ${position} is carried as "${representationKey(source.value)}", while the selected class expects "${representationKey(parameter.value)}"`
    )
  }
  const omitted = cppUndefinedIn(parameter.value)
  if (omitted !== null) return omitted
  throw createCppEmitBlockedError(
    `conversion:undefined->${representationKey(parameter.value)}`,
    `a dynamic constructor can omit candidate parameter ${position}, whose "${representationKey(parameter.value)}" carrier cannot hold undefined`
  )
}

const dynamicConstructorCandidateText = (ctx: EmitContext, target: CallableAbi, declaration: DeclarationId, state: string): string => {
  const layout = ctx.classes.get(declaration)
  const actual = layout?.construct
  const instance = layout?.instance
  if (actual == null || instance == null || instance.kind !== 'class-ref') {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `runtime class ${declaration} can inhabit this receiver but publishes no class construction convention`
    )
  }
  if (actual.receiver !== null) {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `runtime class ${declaration}'s construct convention unexpectedly declares a receiver`
    )
  }
  if (actual.restFrom !== null && actual.restFrom !== target.restFrom) {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `runtime class ${declaration}'s rest slot ${actual.restFrom} cannot be adapted from dynamic constructor rest slot ${String(target.restFrom)}`
    )
  }
  const actuals = actual.parameters.map((parameter, position) => {
    if (actual.restFrom !== position) return dynamicConstructorActualText(ctx, target, actual, position)
    const source = target.parameters[position]
    if (source === undefined) {
      if (parameter.value.kind !== 'array-object') {
        throw createCppEmitBlockedError('call-abi:dynamic-constructor', `runtime class ${declaration}'s rest slot is not an array-object`)
      }
      return `gea::makeRef<gea::ArrayObject<${cppTypeOf(parameter.value.element)}>>()`
    }
    const converted = alignedValueText(
      ctx,
      'class-properties/emit-class-properties.ts:308',
      source.value,
      parameter.value,
      `gea_constructor_arg_${position}`
    )
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source.value)}->${representationKey(parameter.value)}`,
      `runtime class ${declaration}'s rest carrier "${representationKey(parameter.value)}" cannot be filled from "${representationKey(source.value)}"`
    )
  })
  const invocation = `${cppConstructName(declaration)}(${['static_cast<gea::NativeClassMethodState*>(gea_environment)', ...actuals].join(', ')})`
  const result = alignedValueText(ctx, 'class-properties/emit-class-properties.ts:316', instance, target.result, invocation)
  if (result === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(instance)}->${representationKey(target.result)}`,
      `runtime class ${declaration}'s instance carrier "${representationKey(instance)}" cannot satisfy dynamic constructor result "${representationKey(target.result)}"`
    )
  }
  const formals = target.parameters.map((parameter, position) => `${cppAbiParameterType(parameter)} gea_constructor_arg_${position}`)
  const thunk = `+[](void* gea_environment${formals.length === 0 ? '' : `, ${formals.join(', ')}`}) -> ${cppResultTypeOf(target.result)} { return ${result}; }`
  return `${cppTypeOf({ kind: 'constructor-value-dispatch', abi: target })}{${thunk}, gea::nativeClassMethodEnvironment(${state})}`
}

const dynamicClassConstructorText = (ctx: EmitContext, operation: GetOperation): ClassMemberValue => {
  const receiver = operation.receiver.representation
  const result = operation.result.representation
  if (receiver.kind !== 'class-ref') {
    throw createCppEmitBlockedError('call-abi:dynamic-constructor', 'a dynamic class constructor read has no class-ref receiver')
  }
  if (result.kind !== 'constructor-value-dispatch') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(result)}`,
      `"constructor" of class ${receiver.declaration} is carried as "${representationKey(result)}", not a dispatching constructor`
    )
  }
  if (result.abi.receiver !== null) {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `"constructor" of class ${receiver.declaration} publishes a construct receiver`
    )
  }
  if (result.abi.result.kind === 'dynamic') {
    throw createCppEmitBlockedError(
      'call-abi:dynamic-constructor',
      `"constructor" of typed class ${receiver.declaration} publishes a dynamic constructed result, which would box the native instance`
    )
  }
  const candidates = runtimeClassLayoutsOf(ctx.classes)
    .map((layout) => layout.declaration)
    .filter((declaration) => classDescendsFrom(ctx.classes, declaration, receiver.declaration))
    .sort((left, right) => String(left).localeCompare(String(right)))
  if (candidates.length === 0) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver)}:get:false`,
      `"constructor" of class ${receiver.declaration} has no runtime class candidates`
    )
  }
  const receiverText = operandText(ctx, operation.receiver)
  const carrier = cppTypeOf(result)
  const branches = candidates.map(
    (declaration) =>
      `if (gea::host::hasNativeClassLayoutRef<${cppClassName(declaration)}>(${receiverText})) return ${dynamicConstructorCandidateText(ctx, result.abi, declaration, `${receiverText}->gea_method_state`)};`
  )
  const failure =
    `std::fprintf(stderr, "gea: constructor read found an unregistered runtime class for ${String(receiver.declaration)}\\n"); ` +
    'std::abort();'
  return { text: `[&]() -> ${carrier} { ${branches.join(' ')} ${failure} }()`, spelling: carrier }
}

/**
 * The body an instance-method read can invoke directly, or `null` when the
 * callable carrier is part of the semantics of the read.
 *
 * This is deliberately asked before rendering by dead-value analysis as well
 * as by `classMemberText`: once a call names the body, its callee operand is
 * not a read of the materialized `CallableObject`. Keeping the two decisions
 * on this one query prevents a devirtualized call from leaving a dead carrier
 * construction in every hot invocation.
 */
export const directClassMethodBody = (ctx: EmitContext, operation: GetOperation, key: string | null): FunctionId | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref' || key === null) return null
  const site = classMemberOf(ctx.classes, receiver.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  const isSuperAccess = dispatchesStatically(ctx, operation.receiver)
  if (classPrototypeMethodMutableOf(ctx.classes, receiver.declaration, key)) return null
  if (!isSuperAccess && classMethodOverrideOf(ctx.classes, receiver.declaration, key) !== null) return null
  if (classFamilyOverridesOf(ctx.classes, receiver.declaration, key).length > 0 && !isSuperAccess) return null
  return ctx.captures.of(site.method.callable).kind === 'none' ? site.method.callable : null
}

/**
 * A class receiver's key, resolved against what the class and everything it
 * inherits actually have.
 *
 * A field is instance storage and loads with `->`; a method is not stored on
 * the instance at all -- it lives on the prototype -- so loading it as a member
 * reads a struct field that does not exist. `[[Get]]` of a method yields the
 * function object itself, which for a class whose family is closed is the one
 * pointer pair that implements it.
 *
 * An inherited member needs nothing special once the lookup finds it: the
 * emitted struct really derives from its base's (`records.ts`), so an inherited
 * field is the same `->` on the same object, and an inherited method's body
 * takes the base's receiver type, which a `shared_ptr` to the derived class
 * converts to on its own. What the lookup must not do is find a member whose
 * storage nothing initializes -- which is why the base's construction has to
 * run before this path exists at all, not after.
 */
/**
 * What a reactive class-field read obliges a consumer to do, decided from the
 * projected class layout alone.
 *
 * Lifted out of `classMemberText` so this fact has ONE authority with two
 * callers -- the walk that records it before the body renders
 * (`reactive-dependencies.ts`) and the JSX consumer that reads it back. It was
 * a side effect of whichever resolver happened to spell the access, which is
 * how a fact goes missing: an access answered by an earlier rung of the ladder
 * recorded nothing, and the consumer silently sampled instead of subscribing.
 *
 * `revision` and `cell` are the same fact told two ways. A field whose C++
 * carrier CAN be a cell is subscribed through that cell; one whose cannot --
 * an array -- is subscribed through the companion revision cell, which is also
 * what a write reached through the value has to tick. Which of the two a field
 * fell into is `records.ts`'s answer during struct rendering
 * (`representationCanCell`), which no plugin-time fact can state, so it is
 * asked of `revisions` here rather than re-derived.
 *
 * Gated on `operation.reactive`, filled at lowering from the plugin's own
 * table having walked this exact inheritance chain once, rather than asking
 * "is this field reactive at all" a second time.
 */
export interface ReactiveClassFieldRead {
  readonly kind: 'revision' | 'cell'
  readonly origin: ReactiveRevisionOrigin
}

export const reactiveClassFieldClaim = (ctx: EmitContext, operation: GetOperation): ReactiveClassFieldRead | null => {
  if (operation.reactive !== true) return null
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return null
  const site = classMemberOf(ctx.classes, receiver.declaration, key)
  if (!site || site.kind !== 'field') return null
  const struct = cppClassName(site.owner)
  return {
    kind: ctx.hosts.reactive.revisions.get(struct)?.has(key) === true ? 'revision' : 'cell',
    origin: { struct, key, receiver: operation.receiver }
  }
}

export const classMemberText = (ctx: EmitContext, operation: GetOperation): ClassMemberValue | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  // A key only known at runtime names no member of the layout -- the layout is
  // keyed by source spelling -- so this path declines rather than refusing,
  // and the walk reaches the dynamic-property sidecar. Declining is the whole
  // difference between "this compiler cannot compile `(this as any)[key]`" and
  // "that access is answered by the object's own sidecar": the class layout is
  // simply not the authority for a key it cannot see.
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return null
  const site = classMemberOf(ctx.classes, receiver.declaration, key)
  if (!site) {
    // A base-typed handle can carry a descendant whose generated field
    // dispatcher does answer this key, and a statically typed intersection can
    // add an own property that lives in the native expando table. Both are the
    // dynamic-property sidecar case, not a reason to box the receiver. Decline
    // here so `nativeSidecarGetText` performs the actual runtime field/expando
    // lookup and tag-checks the result against this read's published carrier.
    // `constructor` is the one prototype intrinsic that is not an own field or
    // expando. Its value is selected from the receiver's allocation identity,
    // because a base-typed handle may hold a subclass and polymorphic clone
    // methods must allocate that subclass again.
    if (key !== 'constructor') return null
    return dynamicClassConstructorText(ctx, operation)
  }
  if (site.kind === 'unknown-class') {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver)}:get:false`,
      `a "get" of "${key}" reaches class ${site.owner}, whose members no class evaluation published`
    )
  }
  if (site.kind === 'field') {
    // A celled field renders its read exactly as any other field does -- the
    // cell converts to `const T&` -- so this declines and lets the ordinary
    // member access below produce the line. The note a JSX consumer needs to
    // subscribe rather than sample is not decided here: it is a question about
    // the projected class layout, settled for the whole body before a line is
    // printed (`reactiveClassFieldClaim`, walked by `reactive-dependencies.ts`).
    return null
  }
  // The class's family has to be CLOSED at this key for a direct bind to be
  // right. Both branches below name one body -- the accessor's getter, or the
  // method's callable -- and a receiver annotated as a base can hold anything
  // derived from it, so a key some subclass redeclares reaches the wrong body
  // for every instance of that subclass. Nothing about that shows up later: it
  // compiles, it links, and it runs the base's implementation. gea3d-cube's
  // scene walk is the worked case -- `Object3D.collectSelf` is empty and
  // `Mesh`/`Light` override it, so a bound base body collected zero meshes and
  // drew an empty frame with no diagnostic anywhere.
  //
  // `virtual-methods.ts` puts a dispatch member on such a family's root struct,
  // and `ctx.virtualDispatch` names every one it really emitted. A key it did
  // not -- an accessor, or a family whose implementations disagree on their
  // convention -- is refused rather than bound: a named refusal is a report
  // somebody can act on, and the direct bind is not.
  const overriding = classFamilyOverridesOf(ctx.classes, receiver.declaration, key)
  // `super.m()` is the one member access the language binds STATICALLY: 13.3.7
  // resolves it against the home object's prototype, not against the object,
  // and dispatching it would re-enter the override that wrote it -- `Camera`'s
  // `updateMatrixWorld` calling `super.updateMatrixWorld(force)` recursed until
  // the stack ran out. The receiver tells them apart on its own: `ir/lower.ts`
  // mints a `receiver` operation for `this` at the frame's own class and for
  // `super` at the BASE's, so a receiver-defined value carrying any other class
  // than this frame's receiver is a super access and nothing else.
  const isSuperAccess = dispatchesStatically(ctx, operation.receiver)
  const role = site.kind === 'accessor' ? 'get' : 'call'
  const dispatchAbi = ctx.virtualDispatch.get(virtualDispatchKey(receiver.declaration, key, role))
  const dispatchable = dispatchAbi !== undefined
  if (overriding.length > 0 && !isSuperAccess && !dispatchable) {
    throw createCppEmitBlockedError(
      `property-access:${representationKey(receiver)}:get:false`,
      `"${key}" of class ${site.owner} is redeclared by ${overriding.join(', ')}, so a receiver typed as ${receiver.declaration} needs dynamic dispatch, which this unit emitted no member for; binding one body would run ${site.owner}'s for every instance of a subclass`
    )
  }
  // An accessor-backed member is read by *calling* its getter, not by taking a
  // function object of it: `box.value` is the number the getter returns. The
  // call is direct rather than through a callable carrier because the class's
  // family is closed here -- the layout names exactly one body -- and going
  // through a carrier would allocate a pointer pair only to invoke it at once.
  if (site.kind === 'accessor') {
    // An overridden getter is dispatched through the object, exactly as an
    // overridden method is: `escalation.label` on a receiver typed `Rule` must
    // reach `EscalationRule`'s getter. The member is declared on the family's
    // root, so any `Ref` to the root or below names it without a cast.
    if (overriding.length > 0 && !isSuperAccess && dispatchable) {
      return { text: `${operandText(ctx, operation.receiver)}->${cppVirtualMemberName(key, 'get')}()`, spelling: null }
    }
    if (!site.accessor.getter) {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(receiver)}:get:false`,
        `accessor "${key}" of class ${site.owner} declares only a setter, so reading it has no body to call`
      )
    }
    return { text: `${cppBodyName(site.accessor.getter)}(${operandText(ctx, operation.receiver)})`, spelling: null }
  }
  if (overriding.length > 0 && !isSuperAccess && !ctx.virtualCallees.has(operation.result.id)) {
    const selected = computedOverriddenMethodValueText(ctx, operation, key, (method) => classMethodValueText(ctx, operation, key, method))
    return { text: selected.text, spelling: selected.type }
  }
  // An ABSTRACT declaration roots the family and owns no body, so there is no
  // function object to materialise: the only thing this read can publish is
  // the dispatch itself. `emit.ts` already refuses any virtual callee that is
  // not consumed as a callee, so a program that took this value rather than
  // calling it is named there rather than handed a base body it has none of.
  if (overriding.length > 0 && !isSuperAccess && site.method.callable === null) {
    // Asked, not re-derived: `virtualCalleeClaim` settled which reads dispatch
    // before this body rendered, and a read this branch reached that it did not
    // claim is one whose dispatch member this unit never emitted.
    if (!ctx.virtualCallees.has(operation.result.id)) {
      throw createCppEmitBlockedError('call-abi:virtual-dispatch', `virtual dispatch ABI for "${key}" was not retained`)
    }
    // The receiver is recorded by `emit.ts`'s prepass, which asked
    // `classMethodValueReceiverClaim` -- the same layout question this branch
    // reached by resolving the member.
    return { text: '', spelling: null }
  }
  // An ABSTRACT declaration NOTHING in this program implements: no body of its
  // own (the branch above already took every family that has one to dispatch
  // to), so there is neither a function object to materialise nor a dispatch
  // to publish. hono's `FetchEventLike` (`types.ts`) is the shape -- an
  // abstract class declaring only abstract members, extended by nothing,
  // constructed nowhere, written purely to TYPE the service-worker event
  // `hono-base.ts`'s `fire` reads `respondWith` off.
  //
  // That read cannot execute. A `class-ref` to a class with no concrete
  // descendant names a struct this unit never constructs, so no value of it
  // exists to read a member from -- which is why a trap is the honest
  // lowering and not a shortcut: it states the fact rather than inventing a
  // body, keeps the read at its published callable carrier (nothing is
  // boxed), and fails loudly in the impossible case instead of running some
  // other class's implementation. It is the same answer, spelled the same
  // way, that `dynamicClassConstructorText` above gives a `constructor` read
  // whose receiver matches no runtime class.
  //
  // `super.m()` is excluded: that spelling binds statically (13.3.7) and an
  // abstract base really has nothing for it, which stays a refusal.
  if (site.method.callable === null && !isSuperAccess) {
    const carrier = cppTypeOf(boundMethodValueRepresentation(operation))
    const failure =
      `std::fprintf(stderr, "gea: \\"${key}\\" of class ${String(site.owner)} is abstract and no class in this program implements it\\n"); ` +
      'std::abort();'
    return { text: `[]() -> ${carrier} { ${failure} }()`, spelling: carrier }
  }
  const materialized = classMethodValueText(ctx, operation, key, site.method)
  // Keep the receiver beside the exact method value this property read
  // publishes. An immediate `object.method()` call can need it even when the
  // method is not eligible for the body-by-name optimization below: the
  // materialized callable's physical convention includes its leading class
  // receiver, while the semantic method signature does not. A detached read
  // (`const method = object.method; method()`) reaches the call through a
  // different SSA value, so this does not bind `this` where the language does
  // not. `emit-callable.ts` consults it only for the identical callee value.
  // It is recorded by `emit.ts`'s prepass -- see `classMethodValueReceiverClaim`.
  // An overridden method goes through the object instead: the callee is
  // recorded for `emit-callable.ts` to render as `receiver->member(args)`, and
  // deliberately NOT as a direct callee -- a second, name-bound path to the
  // same value is exactly the drift that would reinstate the base's body.
  // `virtualCalleesUsed` is what proves every one of them was really called.
  if (overriding.length > 0 && !isSuperAccess) {
    // Asked, not re-derived: `virtualCalleeClaim` settled which reads dispatch
    // before this body rendered, and a read this branch reached that it did not
    // claim is one whose dispatch member this unit never emitted.
    if (!ctx.virtualCallees.has(operation.result.id)) {
      throw createCppEmitBlockedError('call-abi:virtual-dispatch', `virtual dispatch ABI for "${key}" was not retained`)
    }
    return { text: materialized.text, spelling: materialized.type }
  }
  // A method that captures nothing IS its own body: a call through this
  // value can name it rather than reach it through the carrier. That NAME is
  // registered up front now, by `emitBody`'s walk of `CallOperation.target`
  // (`ir/call-dispatch.ts`, which asks the identical `directClassMethodBody`
  // question) -- nothing is left for this read to register itself.
  return { text: materialized.text, spelling: materialized.type }
}

/**
 * The member and convention an overridden method read has to be DISPATCHED
 * through, or `null` for every read that is not one.
 *
 * A direct bind is only right while nothing below the receiver's class
 * redeclares the key; where something does, the call has to go through the
 * object. That is the same family-closure question `classMemberText` resolves
 * to choose its own spelling, and it is decided entirely from the projected
 * layouts and the dispatch table this unit emitted -- so it is stated here and
 * recorded by `emit.ts`'s prepass, rather than as a side effect of the two
 * branches that happen to spell such a read.
 *
 * `super.m()` is excluded for the reason 13.3.7 gives: the language binds it
 * statically, and dispatching it re-enters the override that wrote it.
 */
export const virtualCalleeClaim = (
  ctx: EmitContext,
  operation: GetOperation
): { readonly member: string; readonly abi: CallableAbi } | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) return null
  if (classMemberOf(ctx.classes, receiver.declaration, key)?.kind !== 'method') return null
  if (classFamilyOverridesOf(ctx.classes, receiver.declaration, key).length === 0) return null
  if (dispatchesStatically(ctx, operation.receiver)) return null
  if (classPrototypeMethodMutableOf(ctx.classes, receiver.declaration, key)) return null
  if (classMethodOverrideOf(ctx.classes, receiver.declaration, key) !== null) return null
  const abi = ctx.virtualDispatch.get(virtualDispatchKey(receiver.declaration, key, 'call'))
  return abi === undefined ? null : { member: cppVirtualMemberName(key), abi }
}

/**
 * Whether a `[[Get]]` on a class receiver publishes a METHOD VALUE, and the
 * receiver it went through -- `null` for every other read.
 *
 * A method value carries its body's own physical convention, receiver first,
 * while the language's view of the value declares no receiver; the call that
 * consumes it therefore has to be handed the object the read went through
 * (`EmitContext.directCallReceivers`, and `emit-callable.ts`'s use of it).
 * That is a property of the READ, decided from the projected class layout, so
 * it is stated here once and recorded by `emit.ts`'s prepass -- the resolvers
 * below simply spell the value the layout already committed them to.
 *
 * Both shapes the class path publishes a method value through are here,
 * because both hand the same receiver to the same consumer: the ordinary
 * `object.method` read, and `computedClassPrototypeMethodText`'s finite
 * `object[key]` dispatch.
 */
export const classMethodValueReceiverClaim = (ctx: EmitContext, operation: GetOperation): IrOperand | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key === undefined) {
    const result = operation.result.representation
    if (result.kind !== 'function-value-dispatch' && result.kind !== 'dynamic') return null
    if (operation.key.representation.kind !== 'string') return null
    for (const { method } of reachableClassMethodsOf(ctx.classes, receiver.declaration)) {
      if (method !== null && ctx.abiOfCallable(method.callable) !== null) return operation.receiver
    }
    return null
  }
  return classMemberOf(ctx.classes, receiver.declaration, key)?.kind === 'method' ? operation.receiver : null
}

/**
 * A computed class-method read such as Hono's `raw[key]()` where `key` is a
 * finite `keyof` set whose literal arms share one callable convention.
 *
 * String-literal unions intentionally collapse to the native `std::string`
 * carrier, so the C++ emitter cannot branch on the key's representation.  It
 * can, however, ask the already-projected class layout for every prototype
 * method whose body converts to the read's one published callable type.  Each
 * arm is built by `classMethodValueText`, the same authority used by a static
 * `.method` read.  A key absent from that finite set falls through to the
 * ordinary missing-property failure at the caller.
 *
 * Overridden families select the exact prototype implementation from the
 * receiver allocation at READ time. A later call keeps that implementation.
 * Own fields and expando shadowing are handled by
 * `nativeSidecarGetText` before it chooses this prototype result.
 */
export const computedClassPrototypeMethodText = (ctx: EmitContext, operation: GetOperation): ComputedPrototypeMethodValue | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  const result = operation.result.representation
  if (result.kind === 'dynamic') {
    if (staticKey === undefined && operation.key.representation.kind !== 'string') return null
    const keys = staticKey === undefined ? classPrototypeMethodKeysOf(ctx.classes, receiver.declaration) : [staticKey]
    const type = cppTypeOf(result)
    const object = operandText(ctx, operation.receiver)
    const branches: string[] = []
    for (const key of keys) {
      const arms = classPrototypeMethodValueArmsOf(ctx.classes, receiver.declaration, key)
      if (arms === null || !arms.some((arm) => arm.method !== null)) continue
      // A base-typed native reference can have a method only on some exact
      // allocations. Preserve undefined for the others and choose the method
      // at READ time, before a later call supplies a possibly new receiver.
      const selections = arms.map(({ allocation, method }) => {
        const value = method === null ? 'gea::Value()' : classMethodValueText(ctx, operation, key, method, result).text
        return `if (gea::host::hasNativeClassLayoutRef<${cppClassName(allocation)}>(${object})) return ${value};`
      })
      const selection = `${selections.join(' ')} return gea::Value();`
      branches.push(staticKey === undefined ? `if (gea_method_key == ${cppStringLiteral(key)}) { ${selection} }` : selection)
    }
    if (branches.length === 0) return null
    const keyBinding = staticKey === undefined ? `const std::string& gea_method_key = ${operandText(ctx, operation.key)}; ` : ''
    return { text: `([&]() -> ${type} { ${keyBinding}${branches.join(' ')} return gea::Value(); })()`, spelling: type, carrier: result }
  }
  if (staticKey !== undefined) return null
  if (result.kind !== 'function-value-dispatch') return null
  // The arms compare the key as a `std::string`; a numeric runtime key would
  // need the canonical-string comparison `gea::PropertyKey` does, and no
  // caller has asked for one yet.
  if (operation.key.representation.kind !== 'string') return null
  const target = boundMethodValueRepresentation(operation)

  // Which of the class's methods this read can actually YIELD: the ones whose
  // body convention fills the carrier the read publishes. That carrier is the
  // census's answer for the key -- `readBodyWithFastPath`'s `request[method]()`
  // (@hono/node-server's `request.ts`) publishes the join of `text`,
  // `arrayBuffer` and `blob` because `DirectBodyReadMethod` is exactly those
  // three literals -- so a method outside it is a key this read cannot take,
  // and skipping it is how this walk narrows to the proven domain.
  const fillsTarget = (callable: FunctionId): boolean => {
    const bodyAbi = ctx.abiOfCallable(callable)
    if (bodyAbi === null) return false
    const bodyRepresentation: Representation = { kind: 'function-value-dispatch', abi: bodyAbi }
    return (
      alignedValueText(
        ctx,
        'class-properties/emit-class-properties.ts:611',
        bodyRepresentation,
        target,
        `${cppTypeOf(bodyRepresentation)}{}`
      ) !== null
    )
  }
  const methods: { readonly key: string; readonly method: ClassLayout['methods'][number] }[] = []
  const overriddenKeys: string[] = []
  for (const { key: methodKey, method } of reachableClassMethodsOf(ctx.classes, receiver.declaration)) {
    if (method === null) {
      overriddenKeys.push(methodKey)
      continue
    }
    if (fillsTarget(method.callable)) methods.push({ key: methodKey, method })
  }
  const materialized = methods.map(({ key, method }) => ({ key, ...classMethodValueText(ctx, operation, key, method, target) }))
  for (const key of overriddenKeys) {
    // The SAME question, asked of an overridden key's every arm. Left
    // unasked, a key outside the read's domain reached
    // `classMethodValueText` anyway and refused the whole program on a
    // conversion it was never going to need: the node-server shim's
    // `LightRequest extends Request` overrides `json`, whose
    // `() -> promise(dynamic)` cannot fill a read that publishes
    // `text|arrayBuffer|blob` -- and `json` is not one of the three keys the
    // read can take. Every arm must fill it, because the arm is chosen at run
    // time from the receiver's allocation and any one of them can be the
    // value this read yields.
    const arms = classMethodValueArmsOf(ctx.classes, receiver.declaration, key)
    if (arms === null || !arms.every((arm) => fillsTarget(arm.method.callable))) continue
    materialized.push({
      key,
      environment: 'nullptr',
      ...computedOverriddenMethodValueText(ctx, operation, key, (method) => classMethodValueText(ctx, operation, key, method, target))
    })
  }
  const valueType = materialized[0]?.type
  if (valueType === undefined || materialized.some((candidate) => candidate.type !== valueType)) return null
  const keyText = operandText(ctx, operation.key)
  const branches = materialized.map((candidate) => `if (gea_method_key == ${cppStringLiteral(candidate.key)}) return ${candidate.text};`)
  // What a key matching NO arm evaluates to. Over a proven-finite domain that
  // is unreachable and saying so lets the optimizer drop the tail; over an open
  // one it is the ordinary "this object has no such member", whose answer is
  // `undefined` and whose error belongs to the CALL, not to the read.
  const missText = `gea::host::unreachableValue<${valueType}>()`
  return {
    text: `([&]() -> ${valueType} { const std::string& gea_method_key = ${keyText}; ${branches.join(' ')} ` + `return ${missText}; })()`,
    spelling: valueType,
    carrier: target
  }
}

/**
 * The emitted global one `ClassName.KEY` names, or `null` when the
 * whole-program census claimed no storage for it.
 *
 * The census (`class-layout.ts`'s `censusClassStaticFieldStorage`, published
 * by `translation-unit.ts` before any body renders) is the ONLY authority
 * here -- this re-derives nothing. It records only the assignment-only idiom
 * (a key no `static` member declares) and refuses a key two writes carried
 * differently, so a name it answers for is a location whose carrier every
 * write in the program already agreed on, and a name it declines falls
 * through to whatever refusal the caller already had.
 *
 * Shared by both directions: a read (`classConstructorStaticMemberText`) and
 * a store (`emit-properties.ts`'s `emitFieldStoreLines`) must resolve the
 * same key to the same global, and two lookups written separately are how
 * they would eventually stop doing so.
 */
export const classConstructorStaticFieldStorage = (
  ctx: EmitContext,
  receiver: Representation,
  key: string
): ClassStaticFieldStorage | null => {
  if (receiver.kind !== 'constructor-family') return null
  // Along the base chain, as `classStaticMemberOf` walks it: `Derived.x`
  // after `class Base { static x = 1 }` resolves through `Derived`'s
  // `[[Prototype]]`, the base constructor, and the storage the census gave
  // `Base.x` is the one cell both spellings name. Stopping at the receiver's
  // own class found no storage, fell through to the member scan, and refused
  // the inherited field as "no emitted storage yet".
  const walked = new Set<DeclarationId>()
  for (const member of receiver.members) {
    let declaration: DeclarationId | null = member
    while (declaration !== null && !walked.has(declaration)) {
      walked.add(declaration)
      const stored = classStaticFieldStorageOf(ctx.classes, declaration, key)
      if (stored) return stored
      declaration = ctx.classes.get(declaration)?.base ?? null
    }
  }
  return null
}

export const classConstructorStaticFieldName = (ctx: EmitContext, receiver: Representation, key: string): string | null =>
  classConstructorStaticFieldStorage(ctx, receiver, key)?.name ?? null

/**
 * `classMemberText`'s twin for the constructor side: `Quaternion.fromEuler`,
 * a static method or get-only accessor read off the class value itself
 * rather than off an instance.
 *
 * `constructor-family.members` is a list in the model (`representation/
 * model.ts`) but `deriveClassConstructor` (`representation/derive.ts`) never
 * produces more than one entry, so every member is tried and the first site
 * found wins -- the same tolerance `projectClasses` already gives a heritage
 * value naming several classes, just applied to the read instead of the base
 * link.
 *
 * A key the whole-program static-field census claimed
 * (`class-layout.ts`'s `censusClassStaticFieldStorage`, published by
 * `translation-unit.ts` before any body renders) reads its own emitted
 * global. That census records only the assignment-only idiom -- a key no
 * `static` member of the class declares -- so it can never disagree with the
 * `classStaticMemberOf` site below about which storage a key names, and it
 * is asked FIRST for exactly that reason: the site scan has no answer for a
 * key nothing declares, and would otherwise fall through to this function's
 * closing refusal.
 *
 * A DECLARED static field (`site.kind === 'field'`) is still refused by
 * name: the census skips those, so no storage was emitted for one, and
 * reading it would be a lookup path answering before its storage exists.
 */
export const classConstructorStaticMemberTextFor = (
  ctx: EmitContext,
  receiver: Representation,
  key: string,
  result: Representation,
  // Asked for only by the members that need an object: `prototype` and an
  // accessor whose getter takes a receiver. A static FIELD is a global and a
  // static METHOD is a direct call, so neither needs one -- and a generic
  // class instantiated at several layouts HAS no single class object to
  // render (`emit-bindings.ts`'s `classObjectReadsOf`), so computing this
  // eagerly refused `Box.count` for a class whose static cell was sitting
  // right there.
  receiverText: () => string
): string | null => {
  if (receiver.kind !== 'constructor-family') return null
  if (key === 'prototype') {
    return nativePrototypeObjectText(ctx, receiver, result, receiverText(), (owner, method, state) => {
      if (method.callable === null)
        throw createCppEmitBlockedError('property-access:class-prototype:abstract-method', 'abstract method has no function object')
      const abi = ctx.abiOfCallable(method.callable)
      if (abi === null)
        throw createCppEmitBlockedError('property-access:class-prototype:method-abi', 'prototype method has no native convention')
      const representation: Representation = { kind: 'function-value-dispatch', abi }
      const environment = methodEnvironmentText(ctx, method.callable, `prototype method ${method.key}`)
      const payload = `${cppTypeOf(representation)}{&${cppThunkName(method.callable)}, ${environment}}`
      return {
        representation,
        text: `gea::nativeClassMethodValue<${cppClassName(owner.declaration)}, &${cppCallableDeclarationTagName(method.callable)}>(${state}, ${payload})`
      }
    })
  }
  const censused = classConstructorStaticFieldStorage(ctx, receiver, key)
  if (censused !== null) {
    const converted = alignedValueText(ctx, 'class-properties/emit-class-properties.ts:713', censused.representation, result, censused.name)
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(censused.representation)}->${representationKey(result)}`,
      `static field "${key}" is stored as "${representationKey(censused.representation)}" and this read publishes ` +
        `"${representationKey(result)}"; no conversion is installed between them`
    )
  }
  for (const declaration of receiver.members) {
    const site = classStaticMemberOf(ctx.classes, declaration, key)
    if (!site) continue
    if (site.kind === 'unknown-class') {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(receiver)}:get:false`,
        `a "get" of static "${key}" reaches class ${site.owner}, whose static members no class evaluation published -- ` +
          'likely an ambient "declare class" this compiler does not census'
      )
    }
    if (site.kind === 'field') {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(receiver)}:get:false`,
        `static field "${key}" of class ${declaration} has no emitted storage yet; only static methods and get-only accessors are rendered`
      )
    }
    if (site.kind === 'accessor') {
      if (!site.accessor.getter) {
        throw createCppEmitBlockedError(
          `property-access:${representationKey(receiver)}:get:false`,
          `static accessor "${key}" of class ${site.owner} declares only a setter, so reading it has no body to call`
        )
      }
      // A static getter's body reads `this` as the class constructor object,
      // and its convention declares that receiver exactly when it does (see
      // `structural-receiver.ts`'s static branch); `C.method` is the call
      // `getter(C)`, the same shape the instance read above renders.
      const getterAbi = ctx.abiOfCallable(site.accessor.getter)
      const called = `${cppBodyName(site.accessor.getter)}(${getterAbi?.receiver ? receiverText() : ''})`
      // The call yields the getter's OWN result carrier; a site publishing a
      // different one (a computed read boxes to `dynamic`) converts from it
      // rather than pretending the call already produced the published type.
      const converted =
        getterAbi === null
          ? called
          : alignedValueText(ctx, 'class-properties/emit-class-properties.ts:753', getterAbi.result, result, called)
      if (converted !== null) return converted
      throw createCppEmitBlockedError(
        `conversion:${representationKey(getterAbi?.result ?? result)}->${representationKey(result)}`,
        `static accessor "${key}" yields "${representationKey(getterAbi?.result ?? result)}" and this read publishes ` +
          `"${representationKey(result)}"; no conversion is installed between them`
      )
    }
    if (!site.method.callable) {
      throw createCppEmitBlockedError(
        `property-access:${representationKey(receiver)}:get:false`,
        `static method "${key}" of class ${site.owner} names no body to take a function object of`
      )
    }
    // The function object is spelled in the method's own dispatch carrier and
    // converted to what the site publishes, as `classMethodValueText` does for
    // an instance method: spelling it directly in the published type wrote
    // `gea::Value{&thunk, env}` for a computed read, which is not a boxed
    // callable at all.
    const methodAbi = ctx.abiOfCallable(site.method.callable)
    const object = `{&${cppThunkName(site.method.callable)}, ${methodEnvironmentText(ctx, site.method.callable, `a "get" of static "${key}"`)}}`
    if (methodAbi === null) return `${cppTypeOf(result)}${object}`
    const methodRepresentation: Representation = { kind: 'function-value-dispatch', abi: methodAbi }
    const converted = alignedValueText(
      ctx,
      'class-properties/emit-class-properties.ts:776',
      methodRepresentation,
      result,
      `${cppTypeOf(methodRepresentation)}${object}`
    )
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      `conversion:${representationKey(methodRepresentation)}->${representationKey(result)}`,
      `static method "${key}" is a "${representationKey(methodRepresentation)}" and this read publishes "${representationKey(result)}"; ` +
        'no conversion is installed between them'
    )
  }
  // `C.name` with no static member shadowing it is the class's `[[Name]]`, a
  // fact the constructor-object allocation stated and the layout carries
  // (`projection/classes.ts`'s `name`) -- asked last, after every declared
  // static member, because a `static name()` is the language's own shadow.
  if (key === 'name') {
    const named = receiver.members.map((declaration) => ctx.classes.get(declaration)?.name ?? null).find((name) => name !== null)
    if (named !== undefined && named !== null) {
      const converted = alignedValueText(
        ctx,
        'class-properties/emit-class-properties.ts:791',
        { kind: 'string' },
        result,
        `std::string(${cppStringLiteral(named)})`
      )
      if (converted !== null) return converted
      throw createCppEmitBlockedError(
        `conversion:string->${representationKey(result)}`,
        `"name" reads as "string" and this receiver's result is stored as "${representationKey(result)}"; no conversion is installed between them`
      )
    }
  }
  if (key === 'length') {
    const length = receiver.members.map((declaration) => ctx.classes.get(declaration)?.length ?? null).find((value) => value !== null)
    if (length !== undefined && length !== null) {
      const converted = alignedValueText(
        ctx,
        'class-properties/emit-class-properties.ts:802',
        { kind: 'scalar', domain: 'number' },
        result,
        `static_cast<double>(${length})`
      )
      if (converted !== null) return converted
      throw createCppEmitBlockedError(
        `conversion:${representationKey({ kind: 'scalar', domain: 'number' })}->${representationKey(result)}`,
        `"length" reads as "number" and this receiver's result is stored as "${representationKey(result)}"; no conversion is installed between them`
      )
    }
  }
  throw createCppEmitBlockedError(
    `property-access:${representationKey(receiver)}:get:false`,
    `"${key}" is not a static field, accessor or method of class ${receiver.members.join('|')} or of any class it extends`
  )
}

export const classConstructorStaticMemberText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'constructor-family') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  // A key only known at runtime is a dispatch over every static member the
  // class declares, rendered by `emit-dynamic-properties.ts`'s
  // `constructorFamilyComputedGetText` from this file's per-key renderer.
  if (key === undefined) return null
  return classConstructorStaticMemberTextFor(ctx, receiver, key, operation.result.representation, () =>
    operandText(ctx, operation.receiver)
  )
}
