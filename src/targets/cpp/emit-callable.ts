import { receivableArguments } from '../../ir/call-entry.js'
import { stableBorrowEntryAccepts } from './borrowed-call-entry.js'
import { callableMemberSlot } from '../../ir/callable-member-candidates.js'
import { transferOf } from '../../ir/transfer.js'
import { boxedValueText } from './emit-dynamic-properties.js'
import { functionConstructorArgumentKindOf } from '../../representation/function-constructor.js'
import { nativeSumWidenable } from './emit-sum-widening.js'
import type {
  AllocateCallableOperation,
  AllocateConstructorOperation,
  BindCallableOperation,
  CallOperation,
  ConstructOperation,
  IrOperand,
  SuperInitializeOperation
} from '../../ir/model.js'
import type { DeclarationId, FunctionId } from '../../identity/ids.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import type { StructuralTypeId } from '../../identity/ids.js'
import { abiKey, representationKey } from '../../representation/model.js'
import { alignedValueText, bindsReceiver, callableObjectAbi, movedValueText, unboxedLoadText } from './emit-narrowing.js'
import { memberAccessOperator, reactiveRevisionText } from './emit-carrier-members.js'
import { structuralRecordViewText } from './emit-record-view.js'
import { emitDateConstruct, isDateCarrier } from './prototype/emit-prototype-date.js'
import {
  unwrapPresentValue,
  bindingReference,
  cppConstructedThunkName,
  cppConstructThunkName,
  cppEnvironmentStructName,
  cppReceiverName,
  cppThunkName,
  createCppEmitBlockedError,
  declareCell,
  defineValue,
  defineValueAlias,
  isCppEmitBlockedError,
  isIntegerStorageValue,
  operandText,
  paddedArguments,
  type CaptureAdmission,
  type CaptureSlot,
  type EmitContext,
  captureFieldText
} from './emit-context.js'
import { classMemberOf, classStaticMemberOf, cppFieldInitializerStatements, lazyArrowFieldPlanOf } from './class-layout.js'
import { declaredRecordFieldOf } from './records.js'
import { hostArityCallLines, hostResultText } from './host/emit-host-arity.js'
import { hostMemberOf } from './host/host-members.js'
import { hostCallText, nativeHandleInvocationText } from './host/emit-host-invoke.js'
import { nativeReflectCallText } from './host/emit-host-reflect.js'
import { jsonStringifyFillLines } from './emit-json.js'
import { withheldCellOf } from './deferral-safety.js'
import { prototypeMethodCallText } from './prototype/emit-prototype-invoke.js'
import { mutatingArrayMembers } from './prototype/emit-prototype-array.js'
import { regexpRoleOf, regExpConstructionFromObject } from './prototype/emit-prototype-regexp.js'
import { cppConstructPatternEntry, cppRegExpNativeTypes } from './regexp-types.js'
import { cppErrorNativeType } from './error-types.js'
import { isNativeErrorBaseRefusal, nativeErrorBaseInitializeStatements } from './native-error-base.js'
import {
  emitArrayBufferConstruct,
  emitSharedArrayBufferConstruct,
  emitTextCodecConstruct,
  emitDataViewConstruct,
  emitTypedArrayBufferConstruct,
  typedArrayTargetSpelling
} from './emit-buffers.js'
import { armAt, armIs } from './emit-union-properties.js'
import {
  cppAbiType,
  cppBodyName,
  cppBoxedType,
  cppCallableDeclarationTagName,
  cppClassName,
  cppConstructName,
  cppInitializeName,
  cppRecordFieldName,
  cppRefcountedReceiver,
  cppTypeOf,
  cppUndefinedValue
} from './types.js'

/** `Function.prototype.bind` preserves the native call ABI and captures only evaluated prefix values. */
export const emitBindCallable = (ctx: EmitContext, lines: string[], operation: BindCallableOperation): void => {
  if (operation.result.representation.kind !== 'function-value-dispatch') {
    throw createCppEmitBlockedError(
      'call-abi:bind-callable',
      'a bound Function result is not carried as an evaluated function-value dispatch'
    )
  }
  if (operation.detached) {
    // See `BindCallableOperation.detached`: the language calls a detached
    // method with no receiver, so a body that reads `this` would be answered
    // where the program would have thrown.
    if (operation.sourceFunctionId !== null && ctx.captures.readsReceiver(operation.sourceFunctionId)) {
      throw createCppEmitBlockedError(
        'call-abi:bind-callable',
        `passes method ${operation.sourceFunctionId} on as a value, and its body reads \`this\`: the language calls a detached method ` +
          'with no receiver, so binding the object it was read from would answer where the program would have thrown'
      )
    }
    if (operation.receiver === null)
      throw createCppEmitBlockedError('call-abi:bind-callable', 'a detached method bind names no receiver to bind')
    const bound = alignedText(ctx, operation.sourceAbi.receiver ?? undefined, operation.receiver, 'detached method receiver')
    const type = cppTypeOf(operation.result.representation)
    lines.push(`${defineValue(ctx, operation.result)} = ${type}::bindReceiver(${operandText(ctx, operation.source)}, ${bound});`)
    return
  }
  const receiver = operation.receiver
    ? [alignedText(ctx, operation.sourceAbi.receiver ?? undefined, operation.receiver, 'Function.prototype.bind receiver')]
    : []
  const bound = operation.bound.map((value, index) =>
    alignedText(ctx, operation.sourceAbi.parameters[index]?.value, value, 'Function.prototype.bind argument')
  )
  // A dynamic-fallback callable is boxed only for its mutable Function-object
  // properties. Its declaration-owned ABI survives on the operation, so
  // recover that callable through the authenticated Function adapter before
  // capturing the prefix; passing a Value to bindCallable would erase both
  // the call frame and the target's own-property identity.
  let source: string | null = operandText(ctx, operation.source)
  if (operation.source.representation.kind === 'dynamic') {
    if (operation.sourceFunctionId === null) {
      throw createCppEmitBlockedError(
        'call-abi:bind-callable',
        'a dynamic Function source carries no checker-authenticated declaration identity'
      )
    }
    const authenticated = ctx.abiOfCallable(operation.sourceFunctionId)
    if (authenticated === null || abiKey(authenticated) !== abiKey(operation.sourceAbi)) {
      throw createCppEmitBlockedError(
        'call-abi:bind-callable',
        `dynamic Function source ${operation.sourceFunctionId} does not publish the exact ABI carried by its bind operation`
      )
    }
    source = unboxedLoadText({ kind: 'function', functionId: operation.sourceFunctionId, abi: authenticated }, source)
  }
  if (source === null) {
    throw createCppEmitBlockedError('call-abi:bind-callable', 'a dynamic Function source has no authenticated native ABI adapter')
  }
  const prefix = [...receiver, ...bound]
  lines.push(
    `${defineValue(ctx, operation.result)} = gea::bindCallable<${cppAbiType(operation.result.representation.abi)}, ${operation.bound.length}>(${[
      source,
      ...prefix
    ].join(', ')});`
  )
}

/**
 * Rendering the callable family: calling, constructing, super-initializing, and
 * allocating the two carriers that make a function or a class a first-class
 * value.
 *
 * They belong together because they are four views of one convention. A call
 * and a construction both go through a carrier's own pointer; an allocation is
 * what fills that carrier in; and `super(...)` is the one member that is
 * neither -- initialization against a receiver that already exists -- which is
 * exactly why it is easiest to get wrong when it sits among unrelated code.
 */
/**
 * A host object written where one of its own base types is declared.
 *
 * The same rule as the class case below, for a hierarchy this compiler did not
 * lay out: an `NSStackView` IS an `NSView`, the generated bridge gives the
 * wrapper structs that same inheritance, and the upcast is the language's own
 * derived-to-base rule with no text of its own. What this cannot be is
 * inferred -- two opaque handles are unrelated to the checker whatever the
 * host's class hierarchy says -- so it is read from what the host stated
 * (`PluginCapabilities.nativeBases`), off the carrier, which is where that
 * statement now travels (`Representation`'s `native-handle` arm).
 *
 * Read from the carrier rather than from this emitter's own host tables so
 * that the conversion census -- which is pure carrier-to-carrier and has no
 * emit context to consult -- answers this pair the same way the printer does.
 * While the fact reached only here, the census minted a `never` node for every
 * host upcast and the certificate refused programs this function was perfectly
 * able to render.
 *
 * A handle with no stated carrier is compared by nothing: a host that named no
 * C++ type for a protocol has said nothing about that protocol's place in a
 * hierarchy either, and treating the protocol name as a carrier would compare
 * two different key spaces. `bases` is empty for such a handle, so the
 * membership test below already says so.
 */
const hostHandleDerivesFrom = (
  source: Extract<Representation, { readonly kind: 'native-handle' }>,
  target: Extract<Representation, { readonly kind: 'native-handle' }>
): boolean => target.native !== null && source.bases.includes(target.native)

/**
 * An instance of a class written where one of its base classes is declared.
 *
 * `records.ts` emits a derived class as `struct D : B`, so `shared_ptr<D>`
 * converts to `shared_ptr<B>` by the language's own derived-to-base rule and
 * the value needs no text of its own. `convertedValueText` cannot answer this:
 * two `class-ref`s differ in a `DeclarationId`, and which classes extend which
 * is a projection fact, not something a carrier carries.
 *
 * The chain is walked rather than the immediate base checked, because
 * `class C extends B extends A` really does make a `C` an `A`. Both sides must
 * agree on ownership: the conversion is on the pointer, and a by-value `B`
 * built from a `D` would slice off exactly the fields that made it a `D`.
 */
const derivesFrom = (ctx: EmitContext, source: Representation, target: Representation): boolean => {
  if (source.kind === 'native-handle' && target.kind === 'native-handle') return hostHandleDerivesFrom(source, target)
  if (source.kind !== 'class-ref' || target.kind !== 'class-ref') return false
  if (source.ownership !== target.ownership || source.ownership !== 'shared-refcount') return false
  const seen = new Set<DeclarationId>()
  let current = ctx.classes.get(source.declaration)?.base ?? null
  while (current !== null && !seen.has(current)) {
    if (current === target.declaration) return true
    seen.add(current)
    current = ctx.classes.get(current)?.base ?? null
  }
  return false
}

/**
 * A class instance written where a structurally-compatible DECLARED SHAPE is
 * the slot -- the interface view TypeScript's own assignability already
 * granted, materialized.
 *
 * hono's `createResponseInstance(_res.body, _res)` (context.ts) hands a
 * `Response` INSTANCE to a parameter declared `ResponseInit`. The checker
 * accepts it structurally: `ResponseInit`'s three optional members --
 * `status`, `statusText`, `headers` -- are all present on the class. C++ has
 * no such rule. `gea::Ref<gea_class_...>` and `gea::Ref<gea_record_...>` are
 * unrelated types, `derivesFrom` above answers only the nominal hierarchy the
 * program actually wrote, and `convertedValueText` has no way to reach a
 * class's members: a `class-ref` carries a declaration and a shape id, never a
 * field list. This is the one place both layouts are in hand.
 *
 * The rebuild is `recastedRecordText`'s (emit-narrowing.ts), one carrier kind
 * further out: read each of the TARGET's fields off the source and construct
 * the target's struct. Both field lists come from `recordFieldsOfShape`, the
 * same authority `records.ts` builds every struct body from, so the members
 * read here are exactly the members that exist.
 *
 * What this is NOT is an alias. The result is a fresh record holding a
 * snapshot of the instance's fields, so a callee that ASSIGNS one of them
 * writes to the copy and the instance never sees it -- the same limit the
 * record-to-record recast already carries, one carrier kind wider. That makes
 * this sound for a slot the declaration shapes as a read-only bag (an options
 * record, which is what every such interface in practice is) and wrong for one
 * declared to be written through. A field whose own carrier is refcounted --
 * `Response.headers`, a `Headers` instance -- still aliases, because the copy
 * copies the reference.
 *
 * Fail-closed on everything it cannot account for: a target with accessors or
 * a dynamic-property sidecar has members this aggregate cannot fill, a
 * host-named struct is the engine's own type with a layout this compiler did
 * not choose, and a target field with no source member of its own is a real
 * hole -- unless the field is optional, which is the declaration's own word
 * that absence is a value it accepts.
 */
/** The lambda's own names, kept out of every body-local namespace a view can be spliced into. */
/**
 * One argument in the carrier the frame it is being written into declares.
 *
 * An argument arrives in the carrier of the expression that produced it, which
 * is not always the slot's: `setSupportedOrientations('landscape')` hands a
 * `std::string` to a parameter declared `OrientationLock | OrientationLock[]`,
 * a real `gea::TaggedUnion`. Writing it through unconverted is a frame
 * mismatch, and C++ rejects it -- correctly -- at the call.
 *
 * This is deliberately in the emitter and not in the lowering. Only three of
 * this file's renderings build a frame at all: a host member and a
 * String/Array.prototype method are both spelled through a text template that
 * never sees the declared convention (`emit-host-invoke.ts`,
 * `emit-prototype-invoke.ts`), so an argument reaching one of those must stay
 * exactly as its own carrier spells it -- `substring`'s optional `end` is a C++
 * OVERLOAD there, not a `gea::Optional<double>` parameter. Which rendering a
 * call gets is decided here, once, a few lines above; a lowering that decided
 * it a second time would be a second authority over the same question.
 *
 * A slot the convention does not declare is left alone: ECMAScript lets a call
 * pass more arguments than a signature names, and an argument past the last
 * slot has no declared carrier to be reconciled against. So is the rest slot,
 * which `ir/lower-operands.ts`'s `packRestArguments` has already built in
 * exactly the carrier the convention states.
 */
export const alignedText = (ctx: EmitContext, slot: Representation | undefined, argument: IrOperand, what = 'call'): string => {
  const text = operandText(ctx, argument)
  if (!slot) return text
  if (derivesFrom(ctx, argument.representation, slot)) return text
  // Native sum widening owns its source. Preserve a proven dying input's
  // value category through that conversion, rather than copying before the
  // outer argument move gets a chance to see the different carrier.
  const sourceText = nativeSumWidenable(argument.representation, slot) ? movedValueText(ctx, argument, argument.representation, text) : text
  const converted = alignedValueText(ctx, `emit-callable.ts:503:${what}`, argument.representation, slot, sourceText)
  if (converted !== null) return converted
  // Last, and only here: the structural interface view above needs both
  // layouts, which is a fact of this emitter's context rather than of the two
  // carriers, so `convertedValueText` cannot be asked it. Tried after that
  // function has refused so a pair with a real conversion never reaches a
  // rebuild it does not need.
  const view = structuralRecordViewText(ctx, argument.representation, slot, text)
  if (view !== null) return view
  // A storage-free argument in a slot that declares a real carrier is not a
  // missing conversion: `undefined`/`void` is also `never`'s carrier
  // (`representation/primitives.ts`), so this call sits on a branch flow
  // analysis proved unreachable and there is nothing to convert. Rendered as
  // the throw rather than refused -- mongodb's `execute_operation.ts:198`
  // narrows a generic by `instanceof` to a class its own monomorphized copy
  // cannot be, 28 copies over, and every one of them blocked emission for code
  // that cannot run.
  if (argument.representation.kind === 'undefined' || argument.representation.kind === 'void') {
    return `gea::host::unreachableValue<${cppTypeOf(slot)}>()`
  }
  const bound = receiverBoundCallableText(ctx, argument, slot, text)
  if (bound !== null) return bound
  throw createCppEmitBlockedError(
    `conversion:${representationKey(argument.representation)}->${representationKey(slot)}`,
    `passes a ${representationKey(argument.representation)} argument into a parameter slot carrying ` +
      `${representationKey(slot)}, and no installed load performs that conversion`
  )
}

/**
 * A method read as a value, handed on into a slot that declares no receiver
 * -- tsc's `formatGeneratedName(..., IdentifierNameMap.toKey)`, or
 * `apply(fmt.upper, s)`.
 *
 * `classMethodValueText` materializes a method value in the method's own
 * physical convention, receiver first, and leaves the receiver to be filled
 * by the call (`emitCall`'s `directCallReceivers`), which is right for the
 * one call a property read feeds directly and wrong for a value that
 * escapes: the slot it lands in states the language's own view of the
 * value, `(name: string) => string`, and nothing at THAT site knows which
 * object the read went through. The read does: `propertyReadOrigins` keeps
 * every property read by its result, so the receiver is recovered here from
 * the read itself and packed in with the value (`gea_runtime.h`'s
 * `CallableObject::bindReceiver`).
 *
 * ECMAScript calls a detached method with `this` undefined. Packing the
 * receiver in is the same call exactly when the body never reads it, and
 * that is checked -- directly, and through every closure the body allocates
 * (`captures.ts`'s `readsReceiver`) -- before anything is rendered; a body
 * that does read `this` is refused by name, since the language would have
 * thrown (or, in sloppy code, read the global) where this would have handed
 * it the object. Measured on tsc's `transformers/utilities.ts`: every method
 * passed as a value there is receiver-free.
 *
 * `null` for a pair this is not about, or a read this cannot see: the caller
 * refuses in its own words, exactly as before.
 */
/**
 * The body a `receiver.key` read names, for a class instance or for the class
 * object itself -- the same two member sets `emit-class-properties.ts`
 * materializes a method value out of, asked through the same two functions so
 * a value this binds a receiver into is the one that read published.
 */
const methodBodyRead = (ctx: EmitContext, receiver: Representation, key: string): FunctionId | null => {
  const isStatic = receiver.kind === 'constructor-family'
  const declarations = receiver.kind === 'class-ref' ? [receiver.declaration] : isStatic ? receiver.members : []
  for (const declaration of declarations) {
    const site = isStatic ? classStaticMemberOf(ctx.classes, declaration, key) : classMemberOf(ctx.classes, declaration, key)
    if (site?.kind === 'method' && site.method.callable) return site.method.callable
  }
  return null
}

export const receiverBoundCallableText = (ctx: EmitContext, operand: IrOperand, target: Representation, text: string): string | null => {
  const source = operand.representation
  if (!bindsReceiver(source, target)) return null
  const origin = ctx.propertyReadOrigins.get(operand.value)
  if (origin === undefined) return null
  const abi = callableObjectAbi(source)
  if (abi === null || abi.receiver === null) return null
  const key = ctx.staticKeyTexts.get(origin.key.value)
  const method = key === undefined ? null : methodBodyRead(ctx, origin.receiver.representation, key)
  if (method === null) return null
  if (ctx.captures.readsReceiver(method)) {
    throw createCppEmitBlockedError(
      'call-abi:bind-callable',
      `passes method "${key}" on as a value, and its body reads \`this\`: the language calls a detached method with no receiver, ` +
        'so binding the object it was read from would answer where the program would have thrown'
    )
  }
  const receiver = alignedValueText(
    ctx,
    'emit-callable.ts:593',
    origin.receiver.representation,
    abi.receiver,
    operandText(ctx, origin.receiver)
  )
  if (receiver === null) return null
  return `${cppTypeOf(target)}::bindReceiver(${text}, ${receiver})`
}

const argumentText = (ctx: EmitContext, abi: CallableAbi, position: number, argument: IrOperand, what = 'call'): string => {
  const slot = abi.restFrom !== null && position >= abi.restFrom ? undefined : abi.parameters[position]?.value
  const text = alignedText(ctx, slot, argument, what)
  // A dying refcounted argument MOVES (`buildDyingArgumentIndex`, captures.ts):
  // the cell it reads is never looked at again, so the increment on the way in
  // and the release on the way out are both pure cost. Only a carrier that
  // OWNS a count can move -- and only into a slot carrying exactly what the
  // argument already holds, since any conversion (`derivesFrom`'s upcast
  // included: `Ref` has no converting MOVE constructor) has already produced a
  // temporary of its own, and moving that is no cheaper than leaving it.
  return movedValueText(ctx, argument, slot ?? null, text)
}

/**
 * The receiver occupies the frame's first formal, and reconciles against the
 * slot the convention declares for it exactly as any other argument does.
 *
 * One extra obligation, and only for a refcounted receiver a body takes BY
 * REFERENCE (`cppRefcountedReceiver`, translation-unit.ts): the argument must
 * be something that survives the call. A local, a formal and a temporary all
 * do -- a `const&` parameter extends a temporary's lifetime past the call that
 * made it -- but a WITHHELD cell read renders as the cell's own storage, and a
 * callee that assigns that cell drops the last count and destroys the object
 * its own receiver names. So a withheld read is given its temporary back: the
 * same copy passing by value would have made, in the one shape where the
 * reference has nothing behind it.
 */
export const receiverArgumentText = (ctx: EmitContext, abi: CallableAbi, receiver: IrOperand): string => {
  const slot = abi.receiver ?? receiver.representation
  // A receiver the callee never names, whose construction was therefore deleted
  // (`ir/instantiation.ts`). The frame still declares the formal, so something
  // has to be passed -- and the one thing that is certainly safe is a
  // default-constructed value of the slot's own type, since no body reads it.
  // Spelling the deleted value's name instead would name a variable that was
  // never declared.
  if (ctx.deadValues.has(receiver.value)) return `${cppTypeOf(slot)}{}`
  const text = alignedText(ctx, abi.receiver ?? undefined, receiver, 'receiver')
  // `withheldCellOf` rather than a private pair of lookups: this is one of the
  // three sites where an emitter observes a withheld read somewhere the
  // deferral census never placed it, and they share that question even though
  // the cure here -- give the read its temporary back -- is this site's alone.
  // See `deferral-safety.ts`.
  const withheldCellRead = withheldCellOf(ctx, receiver.value) !== null
  return withheldCellRead && cppRefcountedReceiver(slot) ? `${cppTypeOf(slot)}{${text}}` : text
}

/**
 * A call through the callable carrier's own invoke pointer.
 *
 * This is the generic path, and it is the only one emitted: `open` is a
 * complete answer, and the plan already narrowed the *convention* to one exact
 * ABI, so an indirect call here costs one pointer load and loses no proof. A
 * direct call to a known symbol is a devirtualization to attach later, on top
 * of this, not instead of it.
 */
const emitNullishInvocation = (ctx: EmitContext, lines: string[], operation: CallOperation | ConstructOperation): boolean => {
  const kind = operation.callee.representation.kind
  if (kind !== 'undefined' && kind !== 'null' && kind !== 'void') return false
  // Argument expressions have already evaluated in the IR. There is no call
  // frame or parameter conversion for a value with no [[Call]]/[[Construct]].
  const result = operation.result
  const target = result && result.representation.kind !== 'void' ? cppTypeOf(result.representation) : 'void'
  const call = `gea::host::throwNullishInvocation<${target}>("${kind === 'null' ? 'null' : 'undefined'}", "${operation.kind === 'construct' ? 'constructor' : 'function'}")`
  lines.push(result && target !== 'void' ? `${defineValue(ctx, result)} = ${call};` : `${call};`)
  if (result?.representation.kind === 'void') defineValueAlias(ctx, result, '(void)0')
  return true
}

const emitUnionMethodCall = (ctx: EmitContext, lines: string[], operation: CallOperation): boolean => {
  const read = ctx.unionMethodReads.get(operation.callee.value)
  if (read === undefined) return false
  const arms = read.arms
  if (arms.length === 0)
    throw createCppEmitBlockedError('call-abi:tagged-union-method', 'a deferred tagged-union method read has no class arms')
  ctx.unionMethodReadsUsed.add(operation.callee.value)
  // The union's own spelling, taken HERE rather than at the read: the arm
  // paths the claim recorded are indices into the carrier, and `armAt`/`armIs`
  // turn them into text against a receiver that has a name by now.
  const receiverText = operandText(ctx, read.receiver)
  const branches = arms.map((arm, index) => {
    const tests: string[] = []
    let armText = receiverText
    for (const step of arm.path) {
      tests.push(armIs(armText, step))
      armText = armAt(armText, step)
    }
    const armTest = tests.length === 0 ? 'true' : tests.join(' && ')
    const abi = ctx.abiOfCallable(arm.callable)
    if (abi === null || abi.receiver === null) {
      throw createCppEmitBlockedError(
        'call-abi:tagged-union-method',
        'a deferred tagged-union method body has no receiver-bearing convention'
      )
    }
    const receiver = alignedValueText(ctx, 'emit-callable.ts:705', arm.receiverRepresentation, abi.receiver, armText)
    if (receiver === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(arm.receiverRepresentation)}->${representationKey(abi.receiver)}`,
        `a deferred tagged-union method receiver cannot convert from ${representationKey(arm.receiverRepresentation)} to ${representationKey(abi.receiver)}`
      )
    }
    const supplied = receivableArguments(abi, operation.arguments).map((argument, position) => argumentText(ctx, abi, position, argument))
    const invocation = `${cppBodyName(arm.callable)}(${paddedArguments(abi, [receiver, ...supplied], 'union method call').join(', ')})`
    let body: string
    if (operation.result === null || operation.result.representation.kind === 'void') {
      body = `${invocation}; return;`
    } else if (abi.result.kind === 'void') {
      const converted = alignedValueText(
        ctx,
        'emit-callable.ts:718',
        { kind: 'undefined' },
        operation.result.representation,
        cppUndefinedValue
      )
      if (converted === null) {
        throw createCppEmitBlockedError(
          `conversion:undefined->${representationKey(operation.result.representation)}`,
          'a void tagged-union method result has no installed conversion to its published result'
        )
      }
      body = `${invocation}; return ${converted};`
    } else {
      const converted = alignedValueText(ctx, 'emit-callable.ts:724', abi.result, operation.result.representation, invocation)
      if (converted === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(abi.result)}->${representationKey(operation.result.representation)}`,
          `a tagged-union method result cannot convert from ${representationKey(abi.result)} to ${representationKey(operation.result.representation)}`
        )
      }
      body = `return ${converted};`
    }
    return index === arms.length - 1 ? body : `if (${armTest}) { ${body} }`
  })
  const resultType =
    operation.result === null || operation.result.representation.kind === 'void' ? 'void' : cppTypeOf(operation.result.representation)
  const invocation = `[&]() -> ${resultType} { ${branches.join(' ')} }()`
  if (operation.result === null) lines.push(`${invocation};`)
  else if (operation.result.representation.kind === 'void') {
    lines.push(`${invocation};`)
    defineValueAlias(ctx, operation.result, '(void)0')
  } else lines.push(`${defineValue(ctx, operation.result)} = ${invocation};`)
  return true
}

/**
 * A DIRECT call on a lazy arrow class field (`class-layout.ts`'s
 * `censusLazyArrowFields`/`LazyArrowFieldPlan`): `c.json(...)` invokes the
 * arrow's own body directly, with the receiver as its own leading argument,
 * while the field's storage is still the zero-initialized `CallableObject`
 * (`invoke == nullptr`) -- exactly the read this field's whole design exists
 * to avoid materializing.
 *
 * A REASSIGNED field (`c.json = other; c.json(...)`) must still call
 * `other`, so this cannot simply always call the body: the field's guard is
 * read at the call site, same as `class-layout.ts`'s `lazyMaterializedFieldText`,
 * and the branch not taken is exactly the ordinary `.call()` this whole
 * feature otherwise renders. Both arms share ONE evaluation of the receiver
 * and ONE evaluation of each argument -- the branches are mutually exclusive
 * at runtime (an `if`/`else` inside one IIFE, the same shape
 * `emitUnionMethodCall`'s arms already rely on above), so duplicating an
 * argument's TEXT across them never duplicates its evaluation.
 *
 * Keyed off `ctx.propertyReadOrigins`, exactly as the existing
 * "callable member candidate" lookup just above is (`memberRead`/`memberKey`)
 * -- both ask "where did this call's callee value come from", just of two
 * different answers (a method slot there, a class field here). Fails closed
 * to `false` -- today's materializing text -- for anything this cannot prove:
 * a receiver that is not statically a class (or subclass) instance, a key
 * this compile never gave lazy-field storage, an unresolved body ABI, or a
 * callee reached through `unwrapPresentValue` (`c.json?.()`) rather than the
 * read itself, none of which this fusion has been asked to handle.
 */
const emitLazyArrowFieldCall = (ctx: EmitContext, lines: string[], operation: CallOperation): boolean => {
  const memberRead = ctx.propertyReadOrigins.get(operation.callee.value)
  if (memberRead === undefined) return false
  const receiverRepresentation = memberRead.receiver.representation
  if (receiverRepresentation.kind !== 'class-ref') return false
  const fieldName = ctx.staticKeyTexts.get(memberRead.key.value)
  if (fieldName === undefined) return false
  // `classMemberOf` walks the receiver's OWN class up through its bases, so a
  // subclass instance resolves to the same declaring owner a base instance
  // would -- the identical walk `emit-properties.ts`'s `emitGet` already
  // trusts for this same field, and the reason an inherited qualifying field
  // is published under the DECLARING class rather than every receiver that
  // might read it (`class-layout.ts`'s own comment on `lazyArrowFieldPlanOf`).
  const site = classMemberOf(ctx.classes, receiverRepresentation.declaration, fieldName)
  if (site === null || site.kind !== 'field') return false
  const plan = lazyArrowFieldPlanOf(ctx.classes, site.owner, fieldName)
  if (plan === null) return false
  // The callee's own representation is the field's STORED CallableObject
  // convention -- what `.call()` below already invokes through, unchanged.
  const callee = operation.callee.representation
  if (callee.kind !== 'function' && callee.kind !== 'function-value-dispatch' && callee.kind !== 'function-family') return false
  // A `function`-kind read names a SPECIFIC function identity, which is not
  // always the census's own arrow: a generic field instantiates a fresh,
  // per-call-site copy of its body (hono's `LightRequest#cached` --
  // `test/runtime/pending-promise-payload-narrowed-at-call.ts` -- reads back
  // `promise(string)` at one call and `promise(scalar(number))` at another,
  // from the SAME field), and a flow fact narrowing the field to a specific
  // reassigned value is the same shape. Either way, `plan.body`'s own ABI has
  // no reason to agree with THIS read's, so direct-call fusion only fires when
  // the read confirms it is looking at the very arrow the census found --
  // anything else keeps today's materializing text, which is always correct.
  if (callee.kind === 'function' && callee.functionId !== plan.body) return false
  // The stored branch calls whatever the FIELD physically holds, so its result
  // is the field's own declared result, not this read's: a generic field
  // (`cached = <K extends keyof R>(key: K): Promise<R[K]> => ...`) is stored
  // as ONE `CallableObject` whose result is the union of every payload, while
  // the read at `this.cached('text')` is instantiated to `promise(string)`.
  // Taking the read's ABI here declared the `.call()` result already narrowed
  // and emitted `return field.call("text")` into a `Promise<std::string>`
  // lambda -- a C++ type error, not a refusal
  // (`test/runtime/pending-promise-payload-narrowed-at-call.ts`). The
  // conversion below then adapts the stored result to the read's, or refuses
  // and declines the fusion.
  const storedField = ctx.classes.get(site.owner)?.fields.find((field) => field.key === fieldName)?.representation ?? null
  const storedAbi =
    storedField !== null &&
    (storedField.kind === 'function' || storedField.kind === 'function-family' || storedField.kind === 'function-value-dispatch')
      ? storedField.abi
      : callee.abi
  const bodyAbi = ctx.abiOfCallable(plan.body)
  if (bodyAbi === null) return false

  // Every check above is exactly what `class-layout.ts`'s `lazyCalleeReadsOf`
  // proves BEFORE admitting a GET to `ctx.lazyCalleeReads` -- so a callee this
  // set names is guaranteed to have reached this point, and `emit-properties.ts`'s
  // `emitGet` has already rendered it as a RAW, unmaterialized copy rather than
  // through `lazyMaterializedFieldText`'s guard-and-store text. That copy's own
  // name -- not a fresh read of the field -- is this call's one evaluation of
  // the callee reference, taken (by `emitGet`, at ITS point in program order)
  // BEFORE any of this call's own arguments could reassign the field: exactly
  // the ECMA-262 order `c.json(c.json = other)` needs and the field-time guard
  // read below, on its own, does not give.
  const snapshot = ctx.lazyCalleeReads.has(operation.callee.value) ? operandText(ctx, operation.callee) : null

  // A GENERIC field whose `function-value-dispatch` read carries a per-call
  // instantiated result (`test/runtime/pending-promise-payload-narrowed-at-call.ts`'s
  // `cached`: `promise(string)` at one call site, `promise(scalar(number))`
  // at another, from the identical field) has no `functionId` for the guard
  // above to catch -- the census's canonical `plan.body` names the GENERIC
  // declaration, whose own result need not agree with THIS call's. Rather
  // than special-case every shape that can disagree, this tries the direct
  // branch's conversions and DECLINES the fusion (falls back to today's
  // always-correct materializing text) the moment one refuses, the same
  // "prove it before committing" fail-closed answer `receiver whose
  // representation is not the declaring class/subclass` above already gives.
  // `isCppEmitBlockedError` is this file's own distinguishing test for exactly
  // that kind of refusal; anything else escapes as the genuine defect it is.
  try {
    const receiverText = operandText(ctx, memberRead.receiver)
    const fieldMember = cppRecordFieldName(fieldName)
    const accessor = memberAccessOperator(receiverRepresentation.ownership)

    // An arrow's OWN abi never states a receiver (13.2.4: no `this` binding of
    // its own) -- `plan.bodyReceiverRepresentation` is the ONE place that
    // captured receiver is recorded, so a body with neither is genuinely
    // receiver-free (`censusLazyArrowFields`'s `{kind: 'none'}` admission).
    const bodyReceiver = bodyAbi.receiver ?? plan.bodyReceiverRepresentation
    // `physicalFrame` states whether the receiver occupies the frame's first
    // formal for `paddedArguments`'/`receivableArguments`' own arithmetic --
    // the identical adjustment the ordinary direct-callee path makes for a
    // method value whose semantic ABI declares no receiver of its own (this
    // file's own `physicalFrame`, further below, and `EmitContext.
    // directCallReceivers`'s doc).
    const physicalFrame: CallableAbi = { ...bodyAbi, receiver: bodyReceiver }

    const result = operation.result
    const voidResult = result === null || result.representation.kind === 'void'
    const resultType = voidResult ? 'void' : cppTypeOf(result.representation)

    // The receiver is bound ONCE, by `gea_lazy_receiver` below -- passed here
    // as that plain local name, not re-derived through `receiverArgumentText`,
    // exactly as `class-layout.ts`'s `lazyMaterializedFieldText` already
    // passes it to `initializer` unconverted: a subclass instance's `Ref`
    // converts to the declaring class's `Ref` implicitly, the same conversion
    // struct member access on that same local already relies on for
    // `fieldMember` below.
    const directArgs = [
      ...(bodyReceiver !== null ? ['gea_lazy_receiver'] : []),
      ...receivableArguments(physicalFrame, operation.arguments).map((argument, position) =>
        argumentText(ctx, physicalFrame, position, argument)
      )
    ]
    const directPadded = paddedArguments(physicalFrame, directArgs, 'lazy field direct call')
    const directInvocation = `${cppBodyName(plan.body)}(${[...(plan.bodyHasEnvironment ? ['nullptr'] : []), ...directPadded].join(', ')})`

    const storedArgs = receivableArguments(storedAbi, operation.arguments).map((argument, position) =>
      argumentText(ctx, storedAbi, position, argument)
    )
    const storedPadded = paddedArguments(storedAbi, storedArgs, 'lazy field stored call')
    // `snapshot` names the copy `emitGet` already rendered, read once at the
    // callee's own evaluation point; the field-time `auto&` alias is the copy's
    // stand-in ONLY where no snapshot exists.
    const storedInvocation = `${snapshot ?? 'gea_lazy_field'}.call(${storedPadded.join(', ')})`

    const branchText = (abi: CallableAbi, invocation: string): string => {
      if (voidResult) return `${invocation}; return;`
      if (abi.result.kind === 'void') {
        const converted = alignedValueText(
          ctx,
          'emit-callable.ts:lazy-field-call',
          { kind: 'undefined' },
          result.representation,
          cppUndefinedValue
        )
        if (converted === null) {
          throw createCppEmitBlockedError(
            `conversion:undefined->${representationKey(result.representation)}`,
            'a void lazy arrow field call result has no installed conversion to its published result'
          )
        }
        return `${invocation}; return ${converted};`
      }
      const converted = alignedValueText(ctx, 'emit-callable.ts:lazy-field-call', abi.result, result.representation, invocation)
      if (converted === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(abi.result)}->${representationKey(result.representation)}`,
          `a lazy arrow field call result cannot convert from ${representationKey(abi.result)} to ${representationKey(result.representation)}`
        )
      }
      return `return ${converted};`
    }

    // Both branches' text is built -- including the RESULT conversion, the one
    // most likely to refuse for a generic field -- before anything is pushed
    // to `lines`, so a refusal caught below has emitted nothing for this
    // function to undo.
    const storedBranch = branchText(storedAbi, storedInvocation)
    // The direct branch may refuse where the stored one does not: a generic
    // field's body is emitted ONCE, for one instantiation's result
    // (`Promise<std::string>` for `cached`), so a call instantiated to another
    // payload (`this.cached('count')`) has no conversion from the body's result
    // while the stored callable -- whose result is the union of every payload
    // -- converts through its arm. That call is not lost: the field is
    // materialized first (the same initializer `lazyMaterializedFieldText`
    // calls) and the stored branch alone is taken, which is exactly the
    // pre-fusion text with the result conversion the ordinary `.call()` path
    // below cannot add (it declares the result in the READ's type and would
    // hand clang a `Promise<union>` for a `Promise<double>`).
    const directBranch = ((): string | null => {
      try {
        return branchText(bodyAbi, directInvocation)
      } catch (error) {
        if (!isCppEmitBlockedError(error)) throw error
        return null
      }
    })()

    // A snapshot needs no `auto& gea_lazy_field` alias into the field at all --
    // that alias is precisely the re-read the snapshot exists to avoid, since
    // an argument between the original read and this call may have reassigned
    // the field to something the snapshot never saw.
    const fieldText = `gea_lazy_receiver${accessor}${fieldMember}`
    const materialize =
      snapshot !== null
        ? `if (${snapshot}.invoke == nullptr) { ${snapshot} = ${cppBodyName(plan.initializer)}(gea_lazy_receiver); ` +
          `if (${fieldText}.invoke == nullptr) { ${fieldText} = ${snapshot}; } } `
        : `auto& gea_lazy_field = ${fieldText}; if (gea_lazy_field.invoke == nullptr) { gea_lazy_field = ${cppBodyName(plan.initializer)}(gea_lazy_receiver); } `
    const invocation =
      directBranch === null
        ? `[&]() -> ${resultType} { const auto& gea_lazy_receiver = ${receiverText}; ${materialize}${storedBranch} }()`
        : snapshot !== null
          ? `[&]() -> ${resultType} { const auto& gea_lazy_receiver = ${receiverText}; ` +
            `if (${snapshot}.invoke == nullptr) { ${directBranch} } else { ${storedBranch} } }()`
          : `[&]() -> ${resultType} { const auto& gea_lazy_receiver = ${receiverText}; auto& gea_lazy_field = ${fieldText}; ` +
            `if (gea_lazy_field.invoke == nullptr) { ${directBranch} } else { ${storedBranch} } }()`

    if (result === null) lines.push(`${invocation};`)
    else if (result.representation.kind === 'void') {
      lines.push(`${invocation};`)
      defineValueAlias(ctx, result, '(void)0')
    } else lines.push(`${defineValue(ctx, result)} = ${invocation};`)
    return true
  } catch (error) {
    if (!isCppEmitBlockedError(error)) throw error
    // The ordinary `.call()` path declares its result in the READ's type. That
    // is only the stored callable's own result when the two agree physically;
    // a stored branch that refused to convert between them has just proved
    // they do not, and declining would emit C++ clang rejects (or, with a
    // reinterpreting carrier, silently misreads). Refuse by name instead.
    if (representationKey(storedAbi.result) !== representationKey(callee.abi.result)) throw error
    if (snapshot === null) return false
    // A snapshot the census admitted must NEVER reach the ordinary `.call()`
    // path below unmaterialized: `emitGet` rendered it as the field's RAW
    // storage, with no guarantee `invoke` is non-null. This is the one refusal
    // `lazyCalleeReadsOf` could not predict structurally (a generic field's
    // per-call-site result, `test/runtime/pending-promise-payload-narrowed-at-call.ts`'s
    // `cached`) -- so, rather than decline to a `.call()` this copy cannot
    // safely make, materialize the copy itself (the SAME initializer thunk
    // `class-layout.ts`'s `lazyMaterializedFieldText` calls) and publish it
    // into the field ONLY if the field is still unmaterialized -- an argument
    // between the read and this call may already have written a real value
    // there, which this must not clobber. Never re-reads the field into the
    // local: that would pick up exactly the reassignment the snapshot exists
    // to see past. The ordinary call path below then reads `snapshot` back
    // through `operandText`, now guaranteed materialized either way.
    const receiverText = operandText(ctx, memberRead.receiver)
    const accessor = memberAccessOperator(receiverRepresentation.ownership)
    const fieldText = `${receiverText}${accessor}${cppRecordFieldName(fieldName)}`
    lines.push(
      `if (${snapshot}.invoke == nullptr) { ${snapshot} = ${cppBodyName(plan.initializer)}(${receiverText}); ` +
        `if (${fieldText}.invoke == nullptr) { ${fieldText} = ${snapshot}; } }`
    )
    return false
  }
}

const functionConstructorArgumentTexts = (
  ctx: EmitContext,
  arguments_: readonly IrOperand[],
  internalMethod: 'call' | 'construct'
): readonly string[] =>
  arguments_.map((argument) => {
    if (functionConstructorArgumentKindOf(argument.representation) === null) {
      throw createCppEmitBlockedError(
        `call-abi:function-constructor:${internalMethod}`,
        'Function construction requires string or dynamic source arguments'
      )
    }
    return `gea::Eval::functionArgument(${operandText(ctx, argument)})`
  })

export const emitCall = (ctx: EmitContext, lines: string[], operation: CallOperation): void => {
  if (ctx.numericCalls.get(operation) === 'imul') {
    const args = operation.arguments.map((argument) => {
      const text = operandText(ctx, argument)
      // A proven integer can still live in a double global/captured cell.
      // Convert through the exact signed carrier before taking its low bits:
      // casting a negative double directly to uint32_t is undefined in C++.
      return isIntegerStorageValue(ctx, argument.value)
        ? `static_cast<std::uint32_t>(static_cast<long long>(${text}))`
        : `gea::toUint32(${text})`
    })
    const expression = `gea::integerImul(${args.join(', ')})`
    if (operation.result && !ctx.unreadValues.has(operation.result.id)) lines.push(`${defineValue(ctx, operation.result)} = ${expression};`)
    else lines.push(`${expression};`)
    return
  }
  if (operation.result !== null && ctx.unreadValues.has(operation.result.id)) {
    emitCall(ctx, lines, { ...operation, result: null })
    return
  }
  if (emitNullishInvocation(ctx, lines, operation)) return
  if (operation.callee.representation.kind === 'native-handle' && operation.callee.representation.protocol === 'FunctionConstructor') {
    if (!ctx.deriver.dynamicFallback)
      throw createCppEmitBlockedError('call-abi:function-constructor', 'Function construction requires --dynamic-fallback')
    const args = functionConstructorArgumentTexts(ctx, operation.arguments, 'call')
    const expression = `gea::Eval::constructFunction({${args.join(', ')}})`
    if (operation.result) lines.push(`${defineValue(ctx, operation.result)} = ${expression};`)
    else lines.push(`${expression};`)
    return
  }
  const functionSourceText = ctx.functionSourceReads.get(operation.callee.value)
  if (functionSourceText) {
    const text = functionSourceText
    if (operation.result?.representation.kind === 'void') {
      lines.push(`${text};`)
      defineValueAlias(ctx, operation.result, '(void)0')
    } else if (operation.result) {
      const converted = alignedValueText(ctx, 'emit-callable.ts:794', { kind: 'string' }, operation.result.representation, text)
      if (converted === null)
        throw createCppEmitBlockedError(
          `conversion:string->${representationKey(operation.result.representation)}`,
          'Function.toString result has no string conversion'
        )
      lines.push(`${defineValue(ctx, operation.result)} = ${converted};`)
    }
    return
  }
  // Before every dispatch path below, because this one renders STATEMENTS
  // rather than an expression a single assignment consumes: `JSON.stringify`
  // serialized straight into the cell that receives it. See
  // `emit-json.ts`'s `jsonStringifyFillLines`.
  const jsonFill = jsonStringifyFillLines(ctx, operation)
  if (jsonFill !== null) {
    lines.push(...jsonFill)
    return
  }
  // Both host paths -- a host method reached through a receiver, and a host
  // handle used as the callee itself -- render a qualified C++ expression
  // rather than a call through a callable carrier (see `emit-host-invoke.ts`).
  const hostCall = hostCallText(ctx, operation)
  if (hostCall !== null) {
    // A member the host states is REALLY `void` -- `OscillatorNode.connect`'s
    // ambient declaration says `AudioDestinationNode` for the Web Audio
    // chaining convention, `gea::host::OscillatorNode::connect` is `void` --
    // is rendered as a bare statement regardless of `operation.result`: the
    // checker's ABI minted a result carrier from the declared type, and
    // assigning that carrier from a void C++ expression is what "no viable
    // overloaded '='" was, at the one place upstream that knows the real
    // signature (`HostSpellings.voidResults`, host-members.ts). Discarding
    // here is sound exactly when the discarded value is never read: if some
    // later operation still names `operation.result.id` as an operand, that
    // read throws `nameOfValue`'s own "read before it is defined" error
    // rather than silently compiling a wrong value -- fail closed, not fail
    // quiet.
    const read = ctx.hostMemberReads.get(operation.callee.value)
    const forcedVoid = read !== undefined && ctx.hosts.voidResults.has(`${read.protocol}.${read.member}`)
    if (!operation.result) {
      lines.push(`${hostCall};`)
      return
    }
    if (operation.result.representation.kind === 'void') {
      lines.push(`${hostCall};`)
      defineValueAlias(ctx, operation.result, '(void)0')
      return
    }
    if (forcedVoid) {
      lines.push(`${hostCall};`)
      return
    }
    // As with a host data member: what the host's C++ returns and what the
    // program holds are not always one carrier -- see `hostResultText`.
    const hostMember = read === undefined ? undefined : hostMemberOf(ctx.hosts.members, read.protocol, read.member)
    const dynamicHostResult = hostMember?.kind === 'method' && hostMember.result === 'dynamic'
    const spelling = dynamicHostResult ? { kind: 'path' as const, text: hostCall, result: 'dynamic' as const } : undefined
    lines.push(`${defineValue(ctx, operation.result)} = ${hostResultText(operation.result.representation, hostCall, spelling)};`)
    return
  }
  // A String/Array.prototype method read defers the same way a host member's
  // does (see `emit-prototype-invoke.ts`'s header) -- checked here, before the
  // generic callable-carrier dispatch below, for the identical reason: this
  // callee was never materialized as a real `CallableObject`.
  const prototypeCall = prototypeMethodCallText(ctx, operation)
  if (prototypeCall !== null) {
    const expression = typeof prototypeCall === 'string' ? prototypeCall : prototypeCall.expression
    const resultStorage = typeof prototypeCall === 'string' ? undefined : prototypeCall.resultStorage
    if (!operation.result) lines.push(`${expression};`)
    else if (operation.result.representation.kind === 'void') {
      lines.push(`${expression};`)
      defineValueAlias(ctx, operation.result, '(void)0')
    } else lines.push(`${defineValue(ctx, operation.result, resultStorage)} = ${expression};`)
    // A call that CHANGED a reactive array's contents ticks its revision cell,
    // so a list rendered from it rebuilds. `push`/`splice`/`sort` mutate;
    // `slice`/`concat`/`map` build a new array and owe nothing.
    const mutated = ctx.reactiveOrigins.get(operation.callee.value)
    const member = ctx.prototypeMethodReads.get(operation.callee.value)?.member
    if (mutated !== undefined && member !== undefined && mutatingArrayMembers.has(member))
      lines.push(`${reactiveRevisionText(ctx, mutated)}.notify();`)
    return
  }
  if (emitUnionMethodCall(ctx, lines, operation)) return
  if (emitLazyArrowFieldCall(ctx, lines, operation)) return
  // `f?.(x)` proves its callee present and then calls it, so the operand's
  // declared type is the callable while the value flowing in is still the
  // `Optional<callable>` the plan gave the read -- the same carrier gap a
  // present receiver has, answered by the same helper. It is unwrapped here
  // rather than at the top of this function so a host or prototype call, which
  // returns above without ever loading a callable, does not emit a dereference
  // nothing reads.
  const calleeOperand = unwrapPresentValue(ctx, lines, operation.callee)
  const callee = calleeOperand.representation
  // A CHOICE of generic functions: the callee is the index of the member the
  // cell holds, and `operation.family` names the copy each member runs at
  // this call. Every arm is a direct call by name, padded to its own
  // convention -- the arguments were packed against none
  // (`ir/lower-invocation.ts`), exactly as a callable union's arms are.
  if (callee.kind === 'generic-function-set') {
    if (!operation.family)
      throw createCppEmitBlockedError('call-abi:generic-function-set', 'a call through a generic function set names no instantiated family')
    if (operation.receiver !== null)
      throw createCppEmitBlockedError(
        'call-abi:generic-function-set',
        'a generic function set call carries a receiver its members declare none of'
      )
    const family = operation.family
    const voidResult = operation.result?.representation.kind === 'void'
    const branches = callee.members.map((member, index) => {
      const target = family.find((entry) => entry.member === member)
      if (!target)
        throw createCppEmitBlockedError(
          'call-abi:generic-function-set',
          `generic function set member ${member} has no instantiated copy at this call`
        )
      const abi = ctx.abiOfCallable(target.functionId)
      if (!abi || abi.receiver !== null || abi.restFrom !== null) {
        throw createCppEmitBlockedError(
          'call-abi:generic-function-set',
          `generic function set member ${member} needs a fixed, receiver-free calling convention`
        )
      }
      const args = receivableArguments(abi, operation.arguments).map((argument, position) => argumentText(ctx, abi, position, argument))
      const invocation = `${cppBodyName(target.functionId)}(${paddedArguments(abi, args, 'generic set call').join(', ')})`
      let body = `${invocation}; return;`
      if (operation.result && !voidResult) {
        const source = abi.result.kind === 'void' ? { kind: 'undefined' as const } : abi.result
        const text = abi.result.kind === 'void' ? cppUndefinedValue : invocation
        const converted = alignedValueText(ctx, 'emit-callable.ts:909', source, operation.result.representation, text)
        if (converted === null) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(abi.result)}->${representationKey(operation.result.representation)}`,
            `generic function set member ${member} returns ${representationKey(abi.result)}, which cannot fill ${representationKey(operation.result.representation)}`
          )
        }
        body = `${abi.result.kind === 'void' ? `${invocation}; ` : ''}return ${converted};`
      }
      return `case ${index}: { ${body} }`
    })
    const resultType = !operation.result || voidResult ? 'void' : cppTypeOf(operation.result.representation)
    const invocation =
      `[&]() -> ${resultType} { switch (${operandText(ctx, calleeOperand)}) { ${branches.join(' ')} ` +
      `default: gea::detail::refuseTaggedUnionArmMismatch("a generic function set tag naming no member"); } }()`
    if (!operation.result) lines.push(`${invocation};`)
    else if (voidResult) {
      lines.push(`${invocation};`)
      defineValueAlias(ctx, operation.result, '(void)0')
    } else lines.push(`${defineValue(ctx, operation.result)} = ${invocation};`)
    return
  }
  // A sum of native callables keeps each frame intact. Dispatching on its
  // tag invokes that frame directly; boxing the sum would erase information
  // already present in every arm. Rest/receiver frames need their own packing
  // and are deliberately refused until that per-arm operation is installed.
  if (callee.kind === 'tagged-union') {
    if (operation.receiver !== null || callee.arms.length === 0) {
      throw createCppEmitBlockedError('call-abi:tagged-union-call', 'a native callable union needs nonempty, receiver-free alternatives')
    }
    const voidResult = operation.result?.representation.kind === 'void'
    const branches = callee.arms.map((arm, index) => {
      const selected = `gea_union_callee.get<${index}>()`
      // A bare `Function` arm genuinely has no static frame. Keep that arm's
      // dynamic invocation local to the union branch while fixed native arms
      // retain their direct convention. Hono's middleware selection is the
      // representative shape: `Function | Next`, narrowed present before the
      // call. Boxing the whole sum would erase Next's known ABI; refusing the
      // dynamic arm would reject a call the runtime already knows how to make.
      if (arm.value.kind === 'dynamic') {
        const boxed = operation.arguments.map((argument) => alignedText(ctx, arm.value, argument, 'boxed-arm'))
        const invocation = `${selected}.callAsFunction({${boxed.join(', ')}})`
        let body = `${invocation}; return;`
        if (operation.result && !voidResult) {
          const held = operation.result.representation
          const converted =
            held.kind === 'dynamic' ? invocation : alignedValueText(ctx, 'emit-callable.ts:954', arm.value, held, invocation)
          if (converted === null) {
            throw createCppEmitBlockedError(
              `conversion:${representationKey(arm.value)}->${representationKey(held)}`,
              `a dynamic callable-union arm's result is read as ${representationKey(held)}, and no installed load performs that conversion`
            )
          }
          body = `return ${converted};`
        }
        return index === callee.arms.length - 1 ? body : `if (gea_union_callee.is<${index}>()) { ${body} }`
      }
      const abi = callableObjectAbi(arm.value)
      if (!abi || abi.receiver !== null || abi.restFrom !== null) {
        throw createCppEmitBlockedError(
          'call-abi:tagged-union-call',
          'a native callable union arm needs a fixed, receiver-free calling convention'
        )
      }
      const args = receivableArguments(abi, operation.arguments).map((argument, position) => argumentText(ctx, abi, position, argument))
      const invocation = `${selected}.call(${paddedArguments(abi, args, 'union call').join(', ')})`
      let body = `${invocation}; return;`
      if (operation.result && !voidResult) {
        const source = abi.result.kind === 'void' ? { kind: 'undefined' as const } : abi.result
        const text = abi.result.kind === 'void' ? cppUndefinedValue : invocation
        const converted = alignedValueText(ctx, 'emit-callable.ts:975', source, operation.result.representation, text)
        if (converted === null)
          throw createCppEmitBlockedError(
            `conversion:${representationKey(source)}->${representationKey(operation.result.representation)}`,
            'a native callable union result has no installed conversion'
          )
        body = `${abi.result.kind === 'void' ? `${invocation}; ` : ''}return ${converted};`
      }
      return index === callee.arms.length - 1 ? body : `if (gea_union_callee.is<${index}>()) { ${body} }`
    })
    const resultType = !operation.result || voidResult ? 'void' : cppTypeOf(operation.result.representation)
    const invocation = `[&]() -> ${resultType} { const auto& gea_union_callee = ${operandText(ctx, calleeOperand)}; ${branches.join(' ')} }()`
    if (!operation.result) lines.push(`${invocation};`)
    else if (voidResult) {
      lines.push(`${invocation};`)
      defineValueAlias(ctx, operation.result, '(void)0')
    } else lines.push(`${defineValue(ctx, operation.result)} = ${invocation};`)
    return
  }
  // A callee the program never gave a type: `const fn: any = handlers[i];
  // fn(event)`. There is no convention to build a frame against, so the
  // arguments cross as boxes and the callable's own declared parameters are
  // recovered by the thunk `gea::Value::box` recorded
  // (`gea::Value::callAsFunction`, gea_runtime.h). Rendered before the
  // callable-carrier dispatch below for the same reason the host paths are:
  // this callee was never materialised as a `CallableObject` the emitter can
  // see the ABI of.
  if (callee.kind === 'dynamic') {
    // The dynamic call adapter transports this separately from positional
    // arguments; the actual callable decides whether its ABI consumes it.
    const boxed = operation.arguments.map((argument) => alignedText(ctx, callee, argument, 'boxed-callee'))
    const receiver = operation.receiver ? boxedValueText(ctx, operation.receiver, 'dynamic call receiver') : 'gea::Value()'
    const text = `${operandText(ctx, calleeOperand)}.callWithReceiver(${receiver}, {${boxed.join(', ')}})`
    if (!operation.result) {
      lines.push(`${text};`)
      return
    }
    if (operation.result.representation.kind === 'void') {
      lines.push(`${text};`)
      defineValueAlias(ctx, operation.result, '(void)0')
      return
    }
    // The call answers a box; what the program holds may be narrower -- `const
    // ok: boolean = fn()` is the checker's answer to a call whose callee is
    // `any`, and the box has to be read back into it.
    const held = operation.result.representation
    const converted = held.kind === 'dynamic' ? text : alignedValueText(ctx, 'emit-callable.ts:1017', callee, held, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(callee)}->${representationKey(held)}`,
        `a dynamic call's result is read as ${representationKey(held)}, and no installed load performs that conversion`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${converted};`)
    return
  }
  if (
    callee.kind !== 'function' &&
    callee.kind !== 'function-value-dispatch' &&
    callee.kind !== 'function-family' &&
    callee.kind !== 'function-and-constructor'
  ) {
    throw createCppEmitBlockedError(
      `call-abi:no-invoke-path:${callee.kind}`,
      `a callee carried as "${callee.kind}" has no invoke path; this emitter calls only through a callable carrier`
    )
  }
  // The convention a *call* site selects, which for a value that is also a
  // constructor is its `[[Call]]` half and never its `[[Construct]]` one.
  const abi = callee.kind === 'function-and-constructor' ? callee.call : callee.abi
  // A directly-bound class method records the receiver at the property read.
  // Usually IR carries that same receiver on the call. A materialized method
  // value can instead publish the receiver-bearing physical convention while
  // the semantic call still has the receiver-less method-value convention;
  // in that case the authenticated property-read receiver fills the ABI slot.
  // Keep this tied to the exact callee value and direct body: a detached
  // function value has no receiver to recover, and must still refuse below.
  const direct = calleeOperand.value === operation.callee.value ? ctx.directCallees.get(operation.callee.value) : undefined
  // A direct call's C++ target IS the concrete body, whose declared parameter
  // carriers can be narrower than the semantic ABI at the read that reached
  // it -- the same erasure the RESULT conversion below already reconciles
  // through `ctx.directCalleeAbis` (see the comment at its use, further down).
  // Argument conversion has to go through that identical physical ABI: a
  // generic method's one C++ body declares a concrete carrier (e.g.
  // `Optional<Ref<TypedArray<uint8_t>>>` for a `ReadableStream<Uint8Array>`
  // method) while the semantic read that named it can still carry the wider
  // erased carrier (`gea::Value`) of the unspecialized declaration. Building
  // arguments from the semantic `abi` in that case hands the physical body a
  // `gea::Value` for a slot it never declared, with no conversion rendered.
  //
  // WHETHER A RECEIVER TRAVELS is the one thing that stays on the semantic
  // `abi`, because that is a fact about the CALL -- a method's convention
  // states a receiver its receiver-less view does not, and reading that off the
  // physical ABI dropped the receiver of an interface-typed call whose direct
  // callee was a class method, sliding the first real argument into the
  // receiver's place (`test/runtime/direct-interface-method-receiver.ts`).
  //
  // ARITY AND THE RECEIVER'S CARRIER do NOT. They used to, and that was only
  // ever true while every body a direct bind could name repeated its
  // declaration's parameter list. An OVERRIDE need not: method parameters are
  // bivariant, so `ServerResponse.write(chunk: string | Uint8Array)` overrides
  // `Writable.write(chunk: unknown, encoding?: unknown, callback?: unknown)`,
  // and a call reaching that body through `(outgoing as Writable).write(value)`
  // built the base's three-argument list -- padded with `undefined`, with the
  // argument boxed into the base's `unknown` slot -- around the override's
  // one-parameter body, and passed it a `Ref<Writable>` for a
  // `const Ref<ServerResponse>&`. `@hono/node-server`'s `listener.ts` writes
  // exactly that (`test/runtime/virtual-call-through-a-base-whose-override-narrows-unknown.ts`).
  // The surplus arguments are not lost: 10.2.1 binds only the parameters the
  // body declares and discards the rest, which is what dropping them here
  // spells.
  const directAbi = direct === undefined ? abi : (ctx.directCalleeAbis.get(operation.callee.value) ?? abi)
  // The frame the PHYSICAL call fills: the body's parameter list, under the
  // call's own answer to whether a receiver occupies the first formal.
  const physicalFrame: CallableAbi =
    directAbi === abi ? abi : { ...directAbi, receiver: abi.receiver === null ? null : (directAbi.receiver ?? abi.receiver) }
  const boundReceiverOperand = operation.receiver === null ? ctx.directCallReceivers.get(operation.callee.value) : undefined
  const declaredReceiverOperand = operation.receiver ?? (abi.receiver !== null ? (boundReceiverOperand ?? null) : null)
  // The receiver is the first physical argument when the convention declares
  // one, and it must be present exactly when it does: a call that passes a
  // receiver to a convention with none, or omits one where the convention
  // expects it, is a frame mismatch and not something to paper over. A direct
  // class method's recorded receiver above is part of that convention, not a
  // manufactured value.
  if ((abi.receiver === null) !== (declaredReceiverOperand === null)) {
    const propertyOrigin = ctx.propertyReadOrigins.get(operation.callee.value)
    const originText =
      propertyOrigin === undefined
        ? 'no property-read origin'
        : `property-read origin ${representationKey(propertyOrigin.receiver.representation)}.${ctx.staticKeyTexts.get(propertyOrigin.key.value) ?? '<computed>'}`
    throw createCppEmitBlockedError(
      'call-abi:receiver-mismatch',
      declaredReceiverOperand
        ? 'passes a receiver to a callee whose convention declares none'
        : `omits the receiver its callee's convention declares (callee ${operation.callee.value} is ${representationKey(callee)}; ${originText}; ` +
            `${boundReceiverOperand === undefined ? 'no recorded method receiver' : 'recorded method receiver present'})`
    )
  }
  // A host's own free function is called as a function, not through a
  // callable carrier: the read that reached it rendered nothing and recorded
  // the host's spelling instead (`emit-bindings.ts`), because there is no
  // object of that name to load. Asked for as an operand it refuses, which is
  // why the callee text is only taken on the carrier path.
  const hostFunction = ctx.hostFunctionReads.get(operation.callee.value)
  // A host's parameter that the program may omit is declared with a C++
  // default, which is filled in at the call site and not by passing an
  // absence. So a host call with a trailing run of optional arguments is
  // emitted once per arity rather than handed a `gea::Optional` the host's
  // `double` cannot accept -- see `emit-host-arity.ts`.
  if (hostFunction !== undefined) {
    // A host that answers in a `gea::Value` hands the crossing back a carrier
    // to REBUILD, and a `native-record-ref` names its layout by shape instead
    // of carrying it (`representation/model.ts`) -- so the materializer, which
    // reads fields off the representation it is given, saw no fields and fell
    // back to asking the box to already hold that exact struct. It never does:
    // `Reflect.getOwnPropertyDescriptor` returns an object the RUNTIME built.
    // The two are physically one C++ type (`obligations-graph.ts` says so
    // where it skips the conversion entirely), so this resolves the shape
    // through the deriver at the one boundary that needs the fields, rather
    // than threading a deriver through every unbox in the backend.
    const resolvedRecordRefs = (representation: Representation): Representation => {
      if (representation.kind === 'optional') {
        const payload = resolvedRecordRefs(representation.payload)
        return payload === representation.payload ? representation : { ...representation, payload }
      }
      if (representation.kind !== 'native-record-ref' || representation.native !== null) return representation
      const derived = ctx.deriver.layoutOf(representation.shapeId as StructuralTypeId)
      return derived.kind === 'record' ? derived : representation
    }
    const reflection = nativeReflectCallText(ctx, operation, hostFunction.kind === 'path' ? hostFunction.text : hostFunction.emit)
    if (reflection !== null) {
      lines.push(operation.result ? `${defineValue(ctx, operation.result)} = ${reflection};` : `${reflection};`)
      return
    }
    // Host overloads consume the actual native value. Do not mint a larger
    // union just to dispatch it immediately: that instantiates unreachable
    // host overloads, and an optional wrapper can disagree with the actual
    // arity. Retain real conversions (e.g. callback ABI adaptation); only a
    // widening into an identical payload is unnecessary at this boundary.
    const slotOf = (position: number, fallback: Representation): Representation =>
      (abi.restFrom !== null && position >= abi.restFrom ? undefined : abi.parameters[position]?.value) ?? fallback
    const passed = [
      ...(operation.receiver
        ? [{ text: receiverArgumentText(ctx, abi, operation.receiver), representation: abi.receiver ?? operation.receiver.representation }]
        : []),
      ...receivableArguments(abi, operation.arguments).map((argument, position) => {
        if (hostFunction.arguments === 'dynamic')
          return {
            text: boxedValueText(ctx, argument, 'dynamic host argument'),
            representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } as Representation
          }
        const slot = slotOf(position, argument.representation)
        const preserve = hostPayloadIdentity(argument.representation, slot)
        return {
          text: preserve ? operandText(ctx, argument) : argumentText(ctx, abi, position, argument),
          representation: preserve ? argument.representation : slot
        }
      })
    ]
    const optionals = trailingOptionalCount(passed)
    const voidResult = operation.result?.representation.kind === 'void'
    lines.push(
      ...hostArityCallLines({
        spelling:
          hostFunction.kind === 'path' && ctx.hosts.nativeArrayFunctions?.has(hostFunction.text)
            ? { ...hostFunction, arrayArguments: 'native' }
            : hostFunction.kind === 'path' && ctx.hosts.arraySnapshotFunctions?.has(hostFunction.text)
              ? { ...hostFunction, arrayArguments: 'snapshot' }
              : hostFunction,
        fixed: passed.slice(0, passed.length - optionals),
        optionals: passed.slice(passed.length - optionals),
        result:
          operation.result && !voidResult
            ? {
                name: defineValue(ctx, operation.result),
                representation:
                  hostFunction.result === 'dynamic' ? resolvedRecordRefs(operation.result.representation) : operation.result.representation
              }
            : null
      })
    )
    if (operation.result && voidResult) defineValueAlias(ctx, operation.result, '(void)0')
    return
  }
  const args = [
    ...(declaredReceiverOperand ? [receiverArgumentText(ctx, physicalFrame, declaredReceiverOperand)] : []),
    ...receivableArguments(physicalFrame, operation.arguments).map((argument, position) => argumentText(ctx, directAbi, position, argument))
  ]
  // A callee whose environment is `nullptr` is called by name. The carrier is
  // still built wherever the program stores one -- this only decides how THIS
  // call reaches the body, and an unread `CallableObject` the C++ compiler then
  // drops costs nothing. Guarded on the operand being the callee itself: `f?.()`
  // unwraps an `Optional` first, and what was proved present is a different
  // value from the one the record was keyed by.
  // A method the program overrides is reached through the OBJECT, not by name:
  // `virtual-methods.ts` put a dispatch member on the family's root struct, and
  // the receiver -- always the first padded argument, since a method's
  // convention states one -- selects the implementation. Binding the body the
  // member lookup found instead would run the base's for every instance of a
  // subclass, which compiles and links and is silently wrong.
  const dispatched = calleeOperand.value === operation.callee.value ? ctx.virtualCallees.get(operation.callee.value) : undefined
  if (dispatched !== undefined) ctx.virtualCalleesUsed.add(operation.callee.value)
  // The receiver a direct bind needs and this call's own convention does not
  // declare -- see `EmitContext.directCallReceivers`. Prepended to the
  // PHYSICAL argument list only, so the convention, the plan and every arity
  // check above stay exactly as they are: this is the one place the emitted
  // frame and the declared one legitimately differ, because the body being
  // named is a method and the value being called is its receiver-less view.
  const boundReceiver = abi.receiver === null && boundReceiverOperand !== undefined ? operandText(ctx, boundReceiverOperand) : undefined
  const padded = [...(boundReceiver === undefined ? [] : [boundReceiver]), ...paddedArguments(physicalFrame, args, 'call')]
  // The callable value is typed at the access site, but the C++ virtual member
  // is declared with the family root's reconciled ABI. Convert the receiver
  // and arguments into that ABI before invoking the member; using `args`
  // directly is only valid when every override repeats the root signature.
  const virtualArgs =
    dispatched === undefined
      ? []
      : [
          ...(operation.receiver ? [receiverArgumentText(ctx, dispatched.abi, operation.receiver)] : []),
          ...receivableArguments(dispatched.abi, operation.arguments).map((argument, position) =>
            argumentText(ctx, dispatched.abi, position, argument)
          )
        ]
  const virtualPadded = dispatched === undefined ? [] : paddedArguments(dispatched.abi, virtualArgs, 'virtual call')
  const memberRead = ctx.propertyReadOrigins.get(operation.callee.value)
  const memberKey = memberRead === undefined ? undefined : ctx.staticKeyTexts.get(memberRead.key.value)
  const candidate =
    memberRead === undefined || memberKey === undefined || calleeOperand.value !== operation.callee.value
      ? undefined
      : ctx.callableMemberCandidates.get(callableMemberSlot(memberRead.receiver.representation, memberKey))

  const stableCandidate = ctx.stableBorrowEntries.get(direct ?? (candidate === undefined ? '' : cppBodyName(candidate)))
  const potentiallyMovingArguments = new Set(
    operation.arguments
      .filter((argument) => transferOf(ctx.dyingArguments, ctx.ownedValues, ctx.ownedDyingValues, argument.value) === 'move')
      .map((argument) => argument.value)
  )
  const stableEntry =
    stableCandidate !== undefined &&
    stableBorrowEntryAccepts(stableCandidate, operation.arguments, ctx.stableBorrowActuals, potentiallyMovingArguments)
      ? stableCandidate
      : undefined
  const callMember =
    candidate === undefined
      ? 'call'
      : stableEntry !== undefined
        ? `callKnownBorrowed<&${cppThunkName(candidate)}, &${stableEntry.name}>`
        : ctx.borrowableMemberBodies.has(candidate)
          ? `callKnownBorrowed<&${cppThunkName(candidate)}, &${cppBodyName(candidate)}>`
          : `callKnown<&${cppThunkName(candidate)}>`

  const invocation =
    dispatched !== undefined
      ? `${virtualPadded[0]}->${dispatched.member}(${virtualPadded.slice(1).join(', ')})`
      : direct !== undefined
        ? `${stableEntry?.name ?? direct}(${padded.join(', ')})`
        : `${operandText(ctx, calleeOperand)}.${callMember}(${padded.join(', ')})`
  if (!operation.result) {
    lines.push(`${invocation};`)
    return
  }
  // A call whose expression is explicitly converted to `void` still runs the
  // callee, but there is no C++ result object to declare. Publish a real void
  // expression for the SSA result so a following discard can name it without
  // fabricating storage.
  if (operation.result.representation.kind === 'void') {
    lines.push(`${invocation};`)
    defineValueAlias(ctx, operation.result, '(void)0')
    return
  }
  const name = defineValue(ctx, operation.result)
  // A convention whose result is `void` returns nothing at all in C++, so its
  // call is a statement and never the right-hand side of an assignment. The
  // language still gives the *expression* a value -- `undefined` -- and an
  // optional call is where that value becomes real: `d?.toggle()` has to merge
  // the call's answer with the absent branch's, so the result is materialized
  // even though a bare `d.toggle()` would discard it. Written as the literal it
  // is, rather than assigned from a void call, which is exactly the "no viable
  // overloaded '='" the host path's own `forcedVoid` above already avoids.
  if (abi.result.kind === 'void') {
    // Fail closed on any other carrier: a `void` convention can only ever have
    // produced `undefined`, so a plan that asked for something else is a
    // disagreement to fix rather than a value to invent here.
    if (operation.result.representation.kind !== 'undefined') {
      throw createCppEmitBlockedError(
        `conversion:void->${representationKey(operation.result.representation)}`,
        `a callee whose convention returns void was asked for a "${operation.result.representation.kind}" result`
      )
    }
    lines.push(`${invocation};`)
    lines.push(`${name} = ${cppUndefinedValue};`)
    return
  }
  // The CONVENTION states what the call produces; the plan states what the
  // cell holds, and the two are not always the same carrier. A callable read
  // out of a union arm carries the arm's own convention -- hono's handler
  // slot declares `gea::Value(Context, Next)` because that arm's return type
  // is unstated -- while the call's published result is the type the checker
  // gave the call expression, `Response | Promise<Response>`. Assigning the
  // convention's result straight into the cell is the "no viable overloaded
  // '='" clang reports, and there is no defensible identity to claim between
  // the two: the box has to be read back out.
  //
  // Reconciled through the one conversion authority rather than a local
  // widening, and refused by name when it has no answer, so a disagreement
  // between the two is a defect to fix rather than a cast invented here.
  // A virtual call is physically declared with the family root's ABI, even
  // when the callable value and the call expression retain a covariant
  // descendant result. Reconcile from the carrier the invocation actually
  // returns; using the semantic callable ABI here makes that conversion look
  // like identity and emits `Ref<Derived> = Ref<Base>` at the assignment.
  // `convertedValueText` performs the checked class narrowing using the
  // target's ancestry, while non-virtual calls keep their ordinary ABI.
  const physicalResult = dispatched?.abi.result ?? ctx.directCalleeAbis.get(operation.callee.value)?.result ?? abi.result
  const produced = alignedValueText(ctx, 'emit-callable.ts:1285', physicalResult, operation.result.representation, callResultName)
  if (produced === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(physicalResult)}->${representationKey(operation.result.representation)}`,
      `a callee whose convention returns "${physicalResult.kind}" cannot fill a "${operation.result.representation.kind}" result`
    )
  }
  // Identity needs no local at all. When a real conversion was rendered it
  // may read its source more than once (the unbox-into-a-union chain tests
  // the tag before loading the payload), so the call is evaluated ONCE into a
  // local and the conversion reads that -- an IIFE rather than two statements
  // because a declaration between two of this body's `goto` labels would let
  // a jump bypass its initialization.
  if (produced === callResultName) {
    lines.push(`${name} = ${invocation};`)
    return
  }
  const target = cppTypeOf(operation.result.representation)
  lines.push(`${name} = ([&]() -> ${target} { auto ${callResultName} = ${invocation}; return ${produced}; }());`)
}

/** The local a call's own result is read into when its carrier has to be reconciled with the cell's. */
const callResultName = 'gea_call_result'

/** How many of a call's arguments trail it as optionals -- the run at the end, and only the run at the end. */
const hostPayloadIdentity = (source: Representation, target: Representation): boolean => {
  if (representationKey(source) === representationKey(target)) return true
  if (target.kind === 'optional') return hostPayloadIdentity(source, target.payload)
  if (target.kind === 'tagged-union') return target.arms.some((arm) => hostPayloadIdentity(source, arm.value))
  return false
}

const trailingOptionalCount = (args: readonly { readonly representation: Representation }[]): number => {
  let count = 0
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index]?.representation.kind !== 'optional') break
    count += 1
  }
  return count
}

/**
 * `super(...)`: the base's initialization against the object under
 * construction, then this class's own field initializers.
 *
 * Both halves are the language's, in the language's order. `super()` runs the
 * base chain -- its field initializers and its constructor body -- against the
 * receiver the derived construction already allocated, which is why it calls
 * the base's *initialize* half rather than its construct: constructing would
 * allocate a second object of the base's own type and throw the derived one
 * away. Immediately after it returns, and before the next statement of this
 * constructor, the derived class's own field initializers run; that is why they
 * are here and not in `constructDefinitionsOf`, which cannot see where in the
 * body they belong.
 *
 * Which class this is, is read from the projection rather than from the frame:
 * the body's own receiver carrier names the class the *receiver* has, which for
 * a derived constructor is the derived class either way, but only
 * `ClassLayout.constructor` states that this body is that class's constructor
 * at all -- a `super()` reached from a nested arrow is a different frame and is
 * refused here rather than silently initializing the enclosing class.
 */
export const emitSuperInitialize = (ctx: EmitContext, lines: string[], operation: SuperInitializeOperation): void => {
  const owning = [...ctx.classes.values()].find((layout) => layout.constructor === ctx.owner)
  if (!owning) {
    throw createCppEmitBlockedError(
      'call-abi:super-initialize',
      `runs in ${ctx.owner}, which no class publishes as its constructor body, so there is no base to initialize`
    )
  }
  if (owning.base === null && owning.nativeBase === null) {
    throw createCppEmitBlockedError('call-abi:super-initialize', `class ${owning.declaration} states no base class to initialize`)
  }
  if (ctx.abi?.receiver?.kind !== 'class-ref') {
    throw createCppEmitBlockedError(
      'call-abi:super-initialize',
      `the constructor of class ${owning.declaration} declares no class receiver to initialize the base against`
    )
  }
  if (owning.nativeBase !== null) {
    if (owning.nativeBase.instance.native !== cppErrorNativeType) {
      throw createCppEmitBlockedError(
        'call-abi:super-initialize',
        `native base ${owning.nativeBase.protocol} uses "${owning.nativeBase.instance.native ?? 'no native layout'}"; only the intrinsic Error layout has an existing-receiver initializer`
      )
    }
    const baseStatements = nativeErrorBaseInitializeStatements(
      ctx.deriver,
      cppReceiverName,
      operation.arguments.slice(0, 2).map((argument) => ({ representation: argument.representation, text: operandText(ctx, argument) }))
    )
    if (isNativeErrorBaseRefusal(baseStatements)) {
      throw baseStatements.refusal === 'conversion'
        ? createCppEmitBlockedError(`conversion:${baseStatements.conversion}`, baseStatements.reason)
        : createCppEmitBlockedError('call-abi:super-initialize', baseStatements.reason)
    }
    for (const statement of baseStatements) lines.push(statement)
    const fieldInitializers = cppFieldInitializerStatements(ctx, owning.declaration, owning.fields, cppReceiverName, (field) =>
      owning.instance === null ? null : declaredRecordFieldOf(ctx.deriver, owning.instance, field.key, ctx.classes)
    )
    if (typeof fieldInitializers === 'string') throw createCppEmitBlockedError('conversion:class-property-initializer', fieldInitializers)
    for (const statement of fieldInitializers) lines.push(statement)
    return
  }
  const baseDeclaration = owning.base
  if (baseDeclaration === null) {
    throw createCppEmitBlockedError(
      'call-abi:super-initialize',
      `class ${owning.declaration} has neither a native nor a program class base`
    )
  }
  // A `super()` that omits a trailing argument the base gives a default is the
  // same omission as any other call's, and is padded the same way -- against
  // the BASE's construct convention, which is the one `constructDefinitionsOf`
  // spells the initializer's formals from. Joining the arguments raw instead
  // emitted `gea_initialize_Base(this)` against a two-parameter initializer:
  // `class IncomingMessage extends EventEmitter` calls `super()` while
  // `EventEmitter(options: EventEmitterOptions = {})` declares one parameter,
  // and the C++ compiler is where that landed rather than here.
  const baseConstruct = ctx.classes.get(baseDeclaration)?.construct ?? null
  if (baseConstruct === null) {
    throw createCppEmitBlockedError(
      'call-abi:super-initialize',
      `base class ${baseDeclaration} published no construct convention, so \`super(...)\` has no frame to fill`
    )
  }
  const received = receivableArguments(baseConstruct, operation.arguments)
  const args = paddedArguments(
    baseConstruct,
    received.map((argument, position) => argumentText(ctx, baseConstruct, position, argument, 'super-initialize')),
    'super-initialize'
  )
  lines.push(`${cppInitializeName(baseDeclaration)}(${[cppReceiverName, ...args].join(', ')});`)
  const fieldInitializers = cppFieldInitializerStatements(ctx, owning.declaration, owning.fields, cppReceiverName, (field) =>
    owning.instance === null ? null : declaredRecordFieldOf(ctx.deriver, owning.instance, field.key, ctx.classes)
  )
  if (typeof fieldInitializers === 'string') throw createCppEmitBlockedError('conversion:class-property-initializer', fieldInitializers)
  for (const statement of fieldInitializers) lines.push(statement)
}

/**
 * Declares a capture's box before the environment that captures it is built
 * when no earlier binding write allocated that box.
 *
 * Most boxed slots already exist because the owning frame's first
 * `binding-write` allocates them before a closure is created. Two ordinary
 * language shapes do not: a closure can precede the first write to a
 * declaration (`let cached; const get = () => cached; cached = value`), and a
 * closure can hold ITSELF (`CaptureSlot.boxed` set because
 * `closureInitialized.get(declaration) === owner`, `captures.ts`):
 * `const loop = (ts) => { ...; requestAnimationFrame(loop) }` allocates the
 * closure before the initializing write. In both cases the environment needs
 * a handle to the cell immediately. So this declares an empty box exactly
 * once, ahead of the environment build, and marks it declared; a later
 * initializing write that follows (`emitBindingWrite`) then sees it already
 * declared and only fills it in, exactly as any later reassignment would.
 */
/**
 * The packed environment one capturing body is entered with, built in the
 * frame that supplies its captures.
 *
 * `gea::packEnvironment` (gea_runtime.h) decides where the captured state
 * physically goes, and the body's own `unpackEnvironment` reads that same
 * decision from the same predicate, so the two cannot disagree. Where it
 * fits, the state IS the pointer the carrier holds and nothing is allocated;
 * where it does not, the struct is a `gea::Ref` block every holder counts on
 * -- which is why there is no "who deletes it" question here: the last holder
 * does.
 *
 * Two callers, and they are the two ways a body can be reached with state it
 * did not declare: a `CallableObject` carries it for an allocated closure,
 * and a record member carries it for a capturing ACCESSOR
 * (`emit-allocation.ts`), which has no carrier of its own.
 */
export const packedEnvironmentText = (ctx: EmitContext, lines: string[], functionId: FunctionId, admission: CaptureAdmission): string => {
  if (admission.kind !== 'ok') throw new Error(`packedEnvironmentText called for ${functionId} with no admitted environment`)
  for (const slot of admission.layout.slots) ensureBoxedSlotDeclared(ctx, lines, slot)
  const fields = [
    ...admission.layout.slots.map((slot) =>
      slot.boxed
        ? bindingReference(ctx, slot.declaration, `a capture of ${functionId}`).name
        : captureFieldText(
            ctx,
            slot.declaration,
            slot.representation,
            bindingReference(ctx, slot.declaration, `a capture of ${functionId}`).name
          )
    ),
    ...(admission.layout.receiver !== null ? [cppReceiverName] : [])
  ]
  return `gea::packEnvironment(${cppEnvironmentStructName(functionId)}{${fields.join(', ')}})`
}

const ensureBoxedSlotDeclared = (ctx: EmitContext, lines: string[], slot: CaptureSlot): void => {
  if (!slot.boxed) return
  const placement = ctx.placements.get(slot.declaration)
  if (placement?.storage.kind !== 'local' || placement.storage.owner !== ctx.owner) return
  if (ctx.declaredBindings.has(slot.declaration)) return
  const cell = bindingReference(ctx, slot.declaration, 'a self-referencing capture')
  declareCell(ctx, cell.name, cppBoxedType(slot.representation))
  lines.push(`${cell.name} = gea::makeRef<${cppTypeOf(slot.representation)}>();`)
  ctx.declaredBindings.add(slot.declaration)
}

/** A statically numeric scalar, including storage-narrowed Number carriers. */
const isNumberScalarCarrier = (representation: Representation): boolean =>
  representation.kind === 'scalar' &&
  (representation.domain === 'number' ||
    representation.domain === 'int32' ||
    representation.domain === 'uint32' ||
    representation.domain === 'float64')

/** An ordinary numeric Array whose elements `TypedArray.fromValues` can apply ToNumber to without a dynamic boundary. */
const isNumericArrayCarrier = (representation: Representation): representation is Extract<Representation, { kind: 'array-object' }> =>
  representation.kind === 'array-object' && representation.ownership === 'shared-refcount' && isNumberScalarCarrier(representation.element)

/** A typed-array source with the reference ownership needed to preserve and read its view identity. */
const isSharedTypedArrayCarrier = (representation: Representation): representation is Extract<Representation, { kind: 'typed-array' }> =>
  representation.kind === 'typed-array' && representation.ownership === 'shared-refcount'

/**
 * `CallableObject{invoke, environment}` for one function-object allocation.
 *
 * `operation.captures` is never consulted: nothing publishes it, so it is not
 * a source of truth for what this closure reads from an enclosing frame.
 * `targets/cpp/captures.ts`'s whole-program `CaptureIndex` is. Each captured
 * cell is read through `bindingReference` in *this* (allocating) context,
 * which owns every declaration the closure captures by construction, so the
 * ordinary branch of `bindingReference` names it correctly with no special
 * casing. A captured receiver reads `cppReceiverName` the same way: this
 * body's own `gea_this` formal exists whenever it has a receiver at all,
 * whether real or itself captured (`emit-context.ts`'s `effectiveAbiOf`).
 *
 * A boxed slot's field copy needs no special casing here either, despite
 * carrying a `std::shared_ptr` rather than the declaration's own value type:
 * `bindingReference` already names the box's OWN storage for a boxed
 * declaration (never its dereferenced pointee -- that is
 * `emit-bindings.ts`'s `cellValueText`, used only where a value, not a
 * handle, is wanted), so copying `.name` verbatim into the new environment
 * struct copies the pointer, which is exactly the aliasing this closure's
 * capture is supposed to establish.
 */
export const emitAllocateCallable = (ctx: EmitContext, lines: string[], operation: AllocateCallableOperation): void => {
  const admission = ctx.captures.of(operation.functionId)
  if (admission.kind === 'refused') {
    throw createCppEmitBlockedError('capture:refused', `allocates a closure whose environment cannot be built: ${admission.reason}`)
  }
  const name = defineValue(ctx, operation.result)
  const carrier = operation.result.representation
  // An OPTIONAL class method (`bodyString?(): string`) allocates through this
  // exact same operation -- the checker widened the MEMBER's type to admit
  // absence (a structural-compatibility escape hatch, `structural-parts.ts`'s
  // `memberOf`), never the allocation itself: `admission.kind === 'refused'`
  // just above is the only "cannot build a callable" outcome this operation
  // has, and it throws rather than leaving the result unassigned. So the
  // payload built below is unconditionally present; only the C++ TYPE gains a
  // `gea::Optional<...>` wrapper. `gea::Optional<T>`'s own constructors
  // (gea_runtime.h) take exactly one `T`, not `CallableObject`'s pointer pair,
  // so the payload has to be built at its own (unwrapped) type first and
  // handed to `Optional` as that single value -- `payloadCarrier`/`wrap` below
  // do exactly that, and reduce to the un-wrapped case unchanged when there is
  // no `optional` to begin with.
  const payloadCarrier = carrier.kind === 'optional' ? carrier.payload : carrier
  const wrap = (payloadText: string): string => (carrier.kind === 'optional' ? `${cppTypeOf(carrier)}{${payloadText}}` : payloadText)
  // Which body this callable runs, kept so a consumer that must RE-RUN it --
  // a reactive JSX slot -- can ask what that body reads. See `thunkValues`.
  //
  // A THUNK only: no arguments and no receiver. `emit-jsx.ts`'s
  // `reactiveThunkPlan` re-runs what it finds here as `thunk.call()`, and that
  // is the one call it can write -- it has the callee's value and nothing
  // else, no frame to rebuild and no receiver to pass. A component's render
  // member is allocated through this same operation (`plugins/gea/lower.ts`
  // binds it, then calls it with the instance and a props record), and
  // recording it would offer a re-run that cannot be spelled; it would also
  // read that body's `this.x` dependencies and subscribe them through the
  // CALLING frame's receiver, which is a different object. Both are silent
  // until the slot is one the emitter binds, which is why the filter belongs
  // here rather than at the one call site that noticed.
  // A two-entry function object holds THREE fields, not two: an invoke pointer,
  // a construct pointer and the environment (`gea::CallableConstructorObject`,
  // gea_runtime.h). The construct pointer is a second thunk over the same body,
  // rendered by `translation-unit.ts`'s `constructThunkOf` -- ECMA-262 10.2.2's
  // "create the object, then enter the body with it", which no `[[Call]]`
  // pointer can serve because it neither allocates nor returns the instance.
  // Brace-initializing this carrier with two values is what used to leave every
  // pre-`class` constructor function in three.js's renderer unclaimed.
  const pointers =
    payloadCarrier.kind === 'function-and-constructor'
      ? `&${cppThunkName(operation.functionId)}, &${cppConstructedThunkName(operation.functionId)}`
      : `&${cppThunkName(operation.functionId)}`
  // Tagged by the SOURCE DECLARATION, not by this copy's thunk. Two
  // instantiations of one generic function are two thunks and one JavaScript
  // function object; the runtime's own `CallableDeclarationTag` comment says
  // "one program-wide address per emitted source declaration", and passing the
  // thunk made it one per copy. `translation-unit.ts` defines the tag object.
  //
  // And only when the identity can be SEEN. `identifyCallable` forces the
  // `FunctionObjectIdentity` allocation (and its property table) that the
  // runtime otherwise mints lazily; `ir/callable-identity-demand.ts` says
  // whether anything in the program ever asks this convention's callables for
  // their identity. When nothing does, the allocation stays the bare
  // thunk/environment pair and a closure in a hot loop costs its environment
  // and nothing else. A callable that is also a constructor keeps its identity
  // regardless: its `prototype` lives on that owner and `new F()` reads it.
  const identified = (payloadText: string): string =>
    payloadCarrier.kind === 'function-and-constructor' ||
    payloadCarrier.kind === 'dynamic' ||
    ctx.callableIdentityDemand.observes(payloadCarrier)
      ? `gea::identifyCallable<&${cppCallableDeclarationTagName(operation.functionId)}>(${payloadText})`
      : payloadText
  // A function whose OWN structural type the `--dynamic-fallback` prototype
  // census marked (`prototypeMutatedConstructorTypes`, dynamic-fallback.ts)
  // publishes `dynamic` here in place of a native callable carrier -- because
  // `F.prototype = ...`/`F.prototype.n = ...` needs a real, mutable property
  // table (ECMA-262 10.2.5 MakeConstructor) that no native callable carrier
  // has. The box's OWN call ABI is gone once boxed, so it is recovered from
  // `ctx.abiOfCallable` (the same recovery `emit-union-properties.ts` already
  // relies on for the identical problem) and used to pick the matching
  // `Value::box`/`boxMethod`/`boxCallable` overload. `new F()` never uses the
  // native construct-thunk pointer for this carrier (`translation-unit.ts`'s
  // `constructThunkOf` refuses to build one for a `dynamic` instance type
  // anyway) -- `emitConstruct`'s own `dynamic` branch calls `Value::construct`
  // instead, which re-enters through the ordinary `[[Call]]` thunk -- so only
  // ONE pointer is ever needed here, never the constructor-family pair.
  if (payloadCarrier.kind === 'dynamic') {
    const abi = ctx.abiOfCallable(operation.functionId)
    if (!abi) {
      throw createCppEmitBlockedError(
        'call-abi:dynamic',
        'a callable boxed as "dynamic" under --dynamic-fallback needs its own call ABI, and this function publishes none'
      )
    }
    const callableType = `gea::CallableObject<${cppAbiType(abi)}>`
    const boxText = (payloadText: string): string => {
      const callable = identified(payloadText)
      if (abi.receiver !== null) return `gea::Value::boxMethod<${abi.restFrom === null ? -1 : abi.restFrom + 1}>(${callable})`
      if (abi.restFrom === null) return `gea::Value::box(gea::Value::Tag::Function, ${callable})`
      return `gea::Value::boxCallable<${abi.restFrom}>(${callable})`
    }
    if (admission.kind === 'none') {
      lines.push(
        `${name} = gea::host::installOrdinaryConstructorPrototype(${boxText(`${callableType}{&${cppThunkName(operation.functionId)}, nullptr}`)});`
      )
      return
    }
    const dynamicEnvironment = packedEnvironmentText(ctx, lines, operation.functionId, admission)
    lines.push(
      `${name} = gea::host::installOrdinaryConstructorPrototype(${boxText(`${callableType}{&${cppThunkName(operation.functionId)}, ${dynamicEnvironment}}`)});`
    )
    return
  }
  if (admission.kind === 'none') {
    // Same reasoning as a module-level function cell: a callable with no
    // environment is reached by name, and the carrier stays for whoever stores
    // one. The name itself is registered up front by `emitBody`'s walk of
    // `CallOperation.target` (`ir/call-dispatch.ts`), not by this allocation.
    lines.push(`${name} = ${wrap(identified(`${cppTypeOf(payloadCarrier)}{${pointers}, nullptr}`))};`)
    return
  }
  const environment = packedEnvironmentText(ctx, lines, operation.functionId, admission)
  lines.push(`${name} = ${wrap(identified(`${cppTypeOf(payloadCarrier)}{${pointers}, ${environment}}`))};`)
}

/**
 * `new Uint8Array(...)`'s checker overload set (ECMA-262 23.2.5.1) has no
 * single physical frame: a `length: number` overload zero-fills, an
 * `ArrayLike<number>` overload copies-and-converts each element, and a
 * `buffer, byteOffset?, length?` overload aliases existing storage -- three
 * different parameter-0 shapes, not three spellings of one convention. That is
 * why `callee.construct` is `null` here, unconditionally, for every
 * typed-array constructor: `representation/host-abi.ts`'s `widestSubsumingAbi`
 * correctly refuses to join an unrelated shape into "the" ABI.
 *
 * This does not re-run overload resolution to work around that: it reads the
 * argument's own, already-resolved physical representation, which is the
 * checker's resolved-signature decision made visible through the plan
 * (`representation/plan.ts`) rather than re-derived from syntax. A `scalar
 * (number)` argument can only be the `length: number` overload's parameter --
 * no other construct signature has a bare-number parameter 0 -- and an
 * `array-object` argument can only be the `ArrayLike<number>` overload's.
 * Optional numeric lengths preserve absence until this intrinsic applies
 * ToIndex: both undefined and null allocate an empty array. Native buffer
 * views and numeric array copies use their own branches below; unsupported
 * carrier families are refused rather than treated as a numeric length.
 */
const emitTypedArrayConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'typed-array' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(result)}`,
      `a typed array allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const target = typedArrayTargetSpelling(result)
  // ECMA-262 23.2.5.1's THIRD overload, `(buffer, byteOffset?, length?)`,
  // which ALIASES the block rather than copying it. Recognized by the
  // argument's own already-resolved carrier, exactly as the two forms below
  // are, and rendered in `emit-buffers.ts` with the rest of the block-shaped
  // family. Checked before the arity guard below because it is the one
  // overload that takes more than one argument.
  const first = operation.arguments[0]
  if (first?.representation.kind === 'array-buffer' || first?.representation.kind === 'shared-array-buffer') {
    emitTypedArrayBufferConstruct(ctx, lines, operation, target)
    return
  }
  const name = defineValue(ctx, operation.result)
  // The zero-argument form IS "no first operand", so reading the operand first
  // and branching on its absence states the arity check once, in the terms the
  // rest of this function already uses, instead of asserting a length and then
  // indexing on the strength of that assertion.
  const argument = operation.arguments[0]
  if (!argument) {
    lines.push(`${name} = gea::makeRef<${target}>();`)
    return
  }
  if (operation.arguments.length > 1) {
    throw createCppEmitBlockedError(
      'call-abi:construct:typed-array',
      `constructs a typed array from ${operation.arguments.length} arguments; only the zero-, length-, and array-like-argument ` +
        'forms of ECMA-262 23.2.5.1 are implemented (see emitTypedArrayConstruct)'
    )
  }
  const carrier = argument.representation
  if (
    isNumberScalarCarrier(carrier) ||
    (carrier.kind === 'optional' && isNumberScalarCarrier(carrier.payload)) ||
    carrier.kind === 'undefined' ||
    carrier.kind === 'null'
  ) {
    const source = operandText(ctx, argument)
    const length =
      carrier.kind === 'optional'
        ? `(${source}.has_value() ? *${source} : 0.0)`
        : carrier.kind === 'undefined' || carrier.kind === 'null'
          ? '0.0'
          : source
    // Normalize the numeric argument before the runtime's integer/range guard.
    // ToIndex truncates fractions and maps NaN/absence to zero.
    lines.push(`${name} = gea::makeRef<${target}>(gea::detail::typedArrayLengthIndex(gea::detail::toIntegerOrInfinity(${length})));`)
    return
  }
  // A BOXED argument. The overload this dispatch reads off a carrier is read
  // off the BOX'S TAG instead, and the tag can pick exactly one: `Tag::Number`
  // is the `length` overload. `unboxedLoadText` renders that as the
  // tag-and-payload-checked read, so a box holding anything else aborts by
  // name at the construction rather than being reinterpreted as a length --
  // the same discipline every other boxed read in this backend keeps, and the
  // reason `preflight/invocation-arguments.ts` can state `scalar(number)` as
  // this argument's target without over-claiming.
  //
  // three's `new Int32Array( n )` (`WebGLUniforms.allocTexUnits`) and
  // `new Float32Array( flatSize )` (`WebGLClipping.projectPlanes`) are both a
  // length through a JS parameter the source never typed.
  if (carrier.kind === 'dynamic') {
    const length = unboxedLoadText({ kind: 'scalar', domain: 'number' }, operandText(ctx, argument))
    if (length !== null) {
      lines.push(`${name} = gea::makeRef<${target}>(gea::detail::typedArrayLengthIndex(gea::detail::toIntegerOrInfinity(${length})));`)
      return
    }
  }
  if (isNumericArrayCarrier(carrier)) {
    lines.push(`${name} = gea::makeRef<${target}>(${target}::fromValues(${operandText(ctx, argument)}));`)
    return
  }
  // ECMA-262 23.2.5.1's copy-from-another-typed-array overload
  // (`InitializeTypedArrayFromTypedArray`): a fresh block the same LENGTH as
  // the source, each element converted through the target's own write rule --
  // which is what makes `new Uint8ClampedArray(new Float32Array([1.5]))`
  // clamp-and-round rather than truncate. `setFrom` performs exactly that
  // conversion, so the copy is `fromLength` plus one `set` at offset zero.
  if (isSharedTypedArrayCarrier(carrier)) {
    const source = operandText(ctx, argument)
    lines.push(`${name} = gea::makeRef<${target}>(static_cast<std::size_t>(${source}->length()));`)
    lines.push(`${name}->setFrom(*${source}, 0.0);`)
    return
  }
  // A parameter declared `number[] | TypedArray` retains both overloads as a
  // native sum. Each alternative is still one of the two copying forms above;
  // dispatching on the sum's existing tag preserves that decision without
  // boxing the source or collapsing typed-array element domains.
  if (
    carrier.kind === 'tagged-union' &&
    carrier.arms.length > 0 &&
    carrier.arms.every((arm) => isNumericArrayCarrier(arm.value) || isSharedTypedArrayCarrier(arm.value))
  ) {
    const branches = carrier.arms.map((arm, index) => {
      const selected = `gea_typed_source.get<${index}>()`
      const body = isNumericArrayCarrier(arm.value)
        ? `return gea::makeRef<${target}>(${target}::fromValues(${selected}));`
        : `{ const auto& gea_typed_input = ${selected}; auto gea_typed_result = gea::makeRef<${target}>(gea_typed_input->size()); gea_typed_result->setFrom(*gea_typed_input, 0.0); return gea_typed_result; }`
      return index === carrier.arms.length - 1 ? body : `if (gea_typed_source.is<${index}>()) { ${body} }`
    })
    lines.push(
      `${name} = ([&]() -> ${cppTypeOf(result)} { const auto& gea_typed_source = ${operandText(ctx, argument)}; ${branches.join(' ')} }());`
    )
    return
  }
  throw createCppEmitBlockedError(
    'call-abi:construct:typed-array',
    `constructs a typed array from a "${carrier.kind}" argument; supported carriers are numeric lengths (including absence), ` +
      'native buffer views, numeric arrays, typed arrays, and native unions of the two array-copy forms'
  )
}

/**
 * `new Array(...)` -- the one native constructor whose result is an ordinary
 * `array-object` rather than a handle to the host's own object.
 *
 * It is here, beside `emitTypedArrayConstruct`, and for the same structural
 * reason: `ArrayConstructor`'s checker overload set is `new (arrayLength:
 * number)` and `new <T>(...items: T[])`, two genuinely different parameter-0
 * shapes with no single physical frame to join, so `derive.ts` leaves
 * `.construct` null and the recipe has to read the construct operation's own,
 * already-resolved argument representation instead.
 *
 * The length form is exactly `ArrayObject::setLength`, which is ECMA-262
 * 10.4.2.1's own rule -- `resize` grows with value-initialized `Slot`s, and a
 * `Slot` value-initializes `present` to false, i.e. a HOLE. `new Array(64)` is
 * a length-64 array of holes in the specification and a length-64 array of
 * holes here; nothing is materialized into `undefined` behind the program's
 * back, and a read of one still aborts by name in `elementAt` rather than
 * handing back a zero.
 *
 * The `...items` form is refused: each item owes a conversion to the array's
 * element carrier, which is lowering's to state (it is what an array literal
 * already gets), not something to improvise from the argument list here. So is
 * a single non-numeric argument -- `new Array("a")` is a one-element array,
 * `new Array(3)` is three holes, and picking between them is the argument's
 * type talking, so an argument whose carrier is neither is a refusal rather
 * than a guess.
 */
const emitArrayConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'array-object' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(result)}`,
      `an Array allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const target = `gea::ArrayObject<${cppTypeOf(result.element)}>`
  const name = defineValue(ctx, operation.result)
  const argument = operation.arguments[0]
  if (!argument) {
    lines.push(`${name} = gea::makeRef<${target}>();`)
    return
  }
  if (operation.arguments.length > 1) {
    throw createCppEmitBlockedError(
      'call-abi:construct:array',
      `constructs an Array from ${operation.arguments.length} arguments; only the zero- and length-argument forms of ` +
        'ECMA-262 23.1.1.1 are implemented, because the element form owes each item a conversion to the array element ' +
        'carrier that only lowering states (see emitArrayConstruct)'
    )
  }
  const carrier = argument.representation
  if (carrier.kind !== 'scalar' || carrier.domain !== 'number') {
    throw createCppEmitBlockedError(
      'call-abi:construct:array',
      `constructs an Array from a "${carrier.kind}" argument; ECMA-262 23.1.1.1 reads a single argument as a LENGTH only ` +
        'when it is a number and as a sole ELEMENT otherwise, and the element form is not implemented'
    )
  }
  lines.push(`${name} = gea::makeRef<${target}>();`)
  lines.push(`${name}->setLength(${operandText(ctx, argument)});`)
}

/**
 * `new Map()` / `new Set()` / `new WeakMap()` / `new WeakSet()`, and
 * `new Set(array)`.
 *
 * The third member of the `emitTypedArrayConstruct`/`emitArrayConstruct`
 * family above, here for exactly the same structural reason: these four
 * constructors' checker overload sets have no single physical frame. `new
 * Map()`, `new Map(entries: readonly (readonly [K, V])[] | null)` and `new
 * Map(iterable: Iterable<readonly [K, V]>)` are three different parameter-0
 * shapes, so `representation/host-abi.ts`'s `widestSubsumingAbi` correctly
 * refuses to join them and `derive.ts` leaves `.construct` null. This reads
 * the construction's own already-resolved result carrier and argument
 * representation instead.
 *
 * Only the zero-argument form, plus `new Set(T[])`, is rendered. Every other
 * seeding form refuses by name:
 *
 * - a Map/WeakMap seeded from entries needs each element to be a `[K, V]`
 *   PAIR, and this compiler carries a tuple as an ordinary record of "0"/"1"
 *   fields (`derive.ts`'s `deriveTuple`). Reading two struct members back out
 *   as a key and a value is a real lowering, not a spelling, and guessing at
 *   it would be the kind of improvisation `emitArrayConstruct` already
 *   declines for `new Array(...items)`;
 * - a Set seeded from any iterable that is not an Array needs the dynamic
 *   `@@iterator` protocol this backend does not lower at all
 *   (`emit-iterator.ts`);
 * - `new WeakSet(array)` is refused with the others rather than folded in with
 *   `new Set(array)`: it is genuinely rare, and admitting it would mean
 *   claiming the weak-key precondition holds for every element of an array
 *   whose own element carrier this function would have to re-check.
 */
/**
 * The four ambient constructor PROTOCOL NAMES this renderer is written for --
 * named here, once, rather than being re-typed as a fifth copy by anything
 * that needs to know which protocols `emitKeyedCollectionConstruct` answers
 * for. The dispatch above is structural (`result.kind === 'keyed-collection'`),
 * never by this name, so this table is not read by the renderer itself: it is
 * the renderer's own restatement of the four names its comment already
 * documents, exported for `host/native-protocols.ts` to derive a
 * native-boundary claim from, since no host-member-table row names any of
 * them the way most other protocols are named.
 */
export const cppKeyedCollectionConstructorProtocols: readonly string[] = [
  'MapConstructor',
  'SetConstructor',
  'WeakMapConstructor',
  'WeakSetConstructor'
]

const emitKeyedCollectionConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'keyed-collection' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `physical-cpp-type:${representationKey(result)}`,
      `a ${result.family} allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  // The pointee, not the carrier: `cppTypeOf` would wrap it in the
  // `shared_ptr` this line is itself constructing.
  const target = cppTypeOf({ ...result, ownership: 'owned' })
  const name = defineValue(ctx, operation.result)
  const argument = operation.arguments[0]
  if (!argument) {
    lines.push(`${name} = gea::makeRef<${target}>();`)
    return
  }
  if (operation.arguments.length > 1) {
    throw createCppEmitBlockedError(
      'call-abi:construct:keyed-collection',
      `constructs a ${result.family} from ${operation.arguments.length} arguments; ECMA-262 gives these constructors one ` +
        'optional iterable parameter and nothing else'
    )
  }
  const carrier = argument.representation
  if (result.family === 'set' && carrier.kind === 'array-object' && representationKey(carrier.element) === representationKey(result.key)) {
    return void lines.push(`${name} = gea::setFromArray<${cppTypeOf(result.key)}>(${operandText(ctx, argument)});`)
  }
  // A STRING is the second iterable this backend proves statically, and it is
  // not a special case of the Array one: ECMA-262 22.1.5.1 iterates a string
  // by CODE POINT, so `new Set('ab')` holds two one-character strings and
  // `new Set('\u{1F600}')` holds one two-unit string, never two halves of a
  // surrogate pair. The runtime walks it with the same `forEachCodePoint`
  // `[...str]` uses, so the seeded Set and the spread can never disagree.
  // Only a `set<string>` -- a `Set<T>` for any other T seeded from a string is
  // not a program this checker admits, and inventing an element conversion
  // here would be a conversion nothing proved.
  if (result.family === 'set' && carrier.kind === 'string' && result.key.kind === 'string') {
    return void lines.push(`${name} = gea::setFromString(${operandText(ctx, argument)});`)
  }
  throw createCppEmitBlockedError(
    'call-abi:construct:keyed-collection',
    `constructs a ${result.family}<${representationKey(result.key)}> from a "${representationKey(carrier)}" argument; only the zero-argument form is implemented for every ` +
      "family, plus `new Set(T[])` where the array's element carrier is exactly the set's own -- a Map seeded from " +
      'entries needs a [K, V] pair lowering (a tuple is carried here as a record of "0"/"1" fields), and any other ' +
      'iterable needs the dynamic @@iterator protocol this backend does not lower'
  )
}

/**
 * `new RegExp(pattern)`, `new RegExp(pattern, flags)` and the two
 * pattern-copying forms (ECMA-262 22.2.4.1).
 *
 * The fourth case of the same `native-handle` exception `emitTypedArrayConstruct`,
 * `emitArrayConstruct` and `emitKeyedCollectionConstruct` are, for the same
 * reason: `RegExpConstructor`'s overload set has three different parameter-0
 * shapes (`string | RegExp`, `string`, `string | RegExp` again with a second
 * parameter), so `derive.ts` correctly leaves `.construct` null and there is
 * no joined convention to invoke through. The construction renders off its own
 * ARGUMENT carriers instead, which is exactly what the specification switches
 * on: 22.2.4.1 step 3 asks whether the pattern is already a RegExp before it
 * asks anything else.
 *
 * `constructPatternOrThrow` (v1: the validation half of `regex.cpp`'s
 * construction path) is the entry point rather than `gea::makeRef<Pattern>`
 * so that 22.2.3.2 `RegExpInitialize`'s flag and source validation runs and an
 * unknown or repeated flag throws where the language says it throws.
 */
const emitRegExpConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation): void => {
  const args = operation.arguments
  if (args.length > 2) {
    throw createCppEmitBlockedError(
      'call-abi:construct:regexp',
      `constructs a RegExp from ${args.length} argument(s); ECMA-262 22.2.4.1 takes a pattern and an optional flags string`
    )
  }
  if (args.length === 0) {
    lines.push(`${defineValue(ctx, operation.result)} = ${cppConstructPatternEntry}(std::string());`)
    return
  }
  const spellingOf = (argument: IrOperand, position: number): string => {
    const carrier = argument.representation
    if (carrier.kind === 'dynamic') return operandText(ctx, argument)
    if (carrier.kind === 'string') return operandText(ctx, argument)
    if (position === 0 && regexpRoleOf(carrier) === 'pattern') return operandText(ctx, argument)
    throw createCppEmitBlockedError(
      `conversion:${representationKey(carrier)}->string`,
      `"new RegExp" argument ${position} carries "${representationKey(carrier)}"; this backend spells it for a string` +
        (position === 0 ? ` or an existing ${cppRegExpNativeTypes.pattern}` : '') +
        ', and ECMA-262 22.2.4.1 ToStrings anything else -- ToString of an arbitrary value is what this backend has no box for'
    )
  }
  const patternArgument = args[0]
  if (!patternArgument)
    throw createCppEmitBlockedError('call-abi:construct:regexp', 'a RegExp construction with an argument has no pattern operand')
  const flag = args[1]
  // Steps 5-7 over an ordinary OBJECT pattern. Step 5 is already `false` here
  // -- a value carrying `[[RegExpMatcher]]` is the `Pattern` carrier
  // `spellingOf` hands straight through -- so what remains is `patternIsRegExp`
  // choosing between the object's own `source`/`flags` and a ToString of it.
  const fromObject = regExpConstructionFromObject(ctx, patternArgument, flag ?? null)
  if (fromObject !== null) {
    lines.push(`${defineValue(ctx, operation.result)} = ${fromObject};`)
    return
  }
  const pattern = spellingOf(patternArgument, 0)
  const rendered = flag ? spellingOf(flag, 1) : null
  const name = defineValue(ctx, operation.result)
  if (rendered === null) {
    lines.push(`${name} = ${cppConstructPatternEntry}(${pattern});`)
    return
  }
  lines.push(`${name} = ${cppConstructPatternEntry}(${pattern}, ${rendered});`)
}

/** Reconcile one [[Construct]] branch's declared result with the carrier selected for the `new` expression. */
const constructResultText = (ctx: EmitContext, source: Representation, target: Representation, text: string): string | null => {
  if (derivesFrom(ctx, source, target)) return text
  return alignedValueText(ctx, 'emit-callable.ts:2038', source, target, text)
}

/** Evaluate a construction exactly once before applying any result conversion that may inspect its source more than once. */
const convertedConstructInvocationText = (
  ctx: EmitContext,
  source: Representation,
  target: Representation,
  invocation: string
): string | null => {
  const converted = constructResultText(ctx, source, target, callResultName)
  if (converted === null) return null
  if (converted === callResultName) return invocation
  return `[&]() -> ${cppTypeOf(target)} { auto ${callResultName} = ${invocation}; return ${converted}; }()`
}

/** The actual [[Construct]] convention held by one non-sum carrier. */
const constructConventionOf = (representation: Representation): CallableAbi | null => {
  if (representation.kind === 'function-and-constructor') return representation.construct
  if (representation.kind === 'constructor-family' || representation.kind === 'constructor-value-dispatch') return representation.abi
  return null
}

/**
 * `new (condition ? A : B)(...)` where every live alternative is a real
 * constructor carrier. The sum keeps each alternative's frame intact, so the
 * discriminant selects both the construct pointer and the result conversion.
 */
const emitTaggedUnionConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation): boolean => {
  const callee = operation.callee.representation
  if (callee.kind !== 'tagged-union') return false
  if (callee.arms.length === 0)
    throw createCppEmitBlockedError('call-abi:tagged-union-construct', 'a constructor union has no live alternatives')
  const branches = callee.arms.map((arm, index) => {
    const abi = constructConventionOf(arm.value)
    if (abi === null || abi.receiver !== null || abi.restFrom !== null) {
      throw createCppEmitBlockedError(
        'call-abi:tagged-union-construct',
        `constructor-union arm ${index} carries "${representationKey(arm.value)}", not a fixed receiver-free [[Construct]] convention`
      )
    }
    const args = receivableArguments(abi, operation.arguments).map((argument, position) =>
      argumentText(ctx, abi, position, argument, 'union construct')
    )
    const selected = `gea_union_constructor.get<${index}>()`
    const invocation = `${selected}.construct(${paddedArguments(abi, args, 'union construct').join(', ')})`
    const converted = convertedConstructInvocationText(ctx, abi.result, operation.result.representation, invocation)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(abi.result)}->${representationKey(operation.result.representation)}`,
        `constructor-union arm ${index} returns "${representationKey(abi.result)}", which cannot fill "${representationKey(operation.result.representation)}"`
      )
    }
    const body = `return ${converted};`
    return index === callee.arms.length - 1 ? body : `if (gea_union_constructor.is<${index}>()) { ${body} }`
  })
  const target = cppTypeOf(operation.result.representation)
  const invocation = `[&]() -> ${target} { const auto& gea_union_constructor = ${operandText(ctx, operation.callee)}; ${branches.join(' ')} }()`
  lines.push(`${defineValue(ctx, operation.result)} = ${invocation};`)
  return true
}

/** Invoke the call entry already selected by the IR's constructor-entry census. */
const emitExplicitObjectReturnConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation): boolean => {
  const entry = operation.entry
  if (entry?.kind !== 'explicit-object-return') return false
  const abi = entry.abi
  const args = receivableArguments(abi, operation.arguments).map((argument, position) =>
    argumentText(ctx, abi, position, argument, 'construct')
  )
  const invocation = `${operandText(ctx, operation.callee)}.call(${paddedArguments(abi, args, 'construct').join(', ')})`
  const converted = convertedConstructInvocationText(ctx, abi.result, operation.result.representation, invocation)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(abi.result)}->${representationKey(operation.result.representation)}`,
      `an ordinary function's explicit object result "${representationKey(abi.result)}" cannot fill "${representationKey(operation.result.representation)}"`
    )
  }
  lines.push(`${defineValue(ctx, operation.result)} = ${converted};`)
  return true
}

/**
 * `new C(...)`: the construction goes through the constructor carrier's own
 * construct pointer, exactly as a call goes through a callable's invoke
 * pointer. `newTarget` is not consulted -- a derived construction needs the
 * new-target to reach the field initializers of the class that was actually
 * newed, and nothing here transports it -- so a construction whose new-target
 * is not its own callee is refused rather than silently treated as ordinary.
 */
export const emitConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation): void => {
  const callee = operation.callee.representation
  if (operation.newTarget.value !== operation.callee.value) {
    throw createCppEmitBlockedError(
      'call-abi:construct',
      'a construction whose new-target differs from its callee needs new-target transport, which is not installed'
    )
  }
  if (emitNullishInvocation(ctx, lines, operation)) return
  if (emitTaggedUnionConstruct(ctx, lines, operation)) return
  if (emitExplicitObjectReturnConstruct(ctx, lines, operation)) return
  // `new TextEncoder()` / `new TextDecoder(...)`, dispatched on the RESULT and
  // therefore ahead of every callee-shaped branch below: their class objects
  // are declared in `lib.dom.d.ts` as anonymous type literals, so the callee
  // never derives a `native-handle` the way `Uint8Array`'s named
  // `Uint8ArrayConstructor` does -- it derives a constructor carrier over a
  // structural body, and `projection/bindings.ts` gives the NAME `host-class`
  // storage so no cell is emitted for it. See `emitTextCodecConstruct`.
  if (emitTextCodecConstruct(ctx, lines, operation)) return
  if (callee.kind === 'native-handle') {
    // `Uint8Array`/`Int32Array`/... are `native-handle`s whose checker
    // overload set genuinely has no single physical frame (see
    // `emitTypedArrayConstruct`'s own comment), so `callee.construct` is
    // correctly `null` for them -- this has to come before the general
    // `!callee.construct` refusal below, which is right for every OTHER
    // native-handle constructor (one unjoinable overload set there really
    // does mean "no convention"), just not this one.
    const result = operation.result.representation
    if (result.kind === 'typed-array') {
      emitTypedArrayConstruct(ctx, lines, operation, result)
      return
    }
    // `ArrayBuffer` and `DataView` -- the same exception for the same
    // unjoinable-overload-set reason, rendered in `emit-buffers.ts` with the
    // rest of the binary family.
    if (result.kind === 'array-buffer') {
      emitArrayBufferConstruct(ctx, lines, operation, result)
      return
    }
    if (result.kind === 'shared-array-buffer') {
      emitSharedArrayBufferConstruct(ctx, lines, operation, result)
      return
    }
    if (result.kind === 'data-view') {
      emitDataViewConstruct(ctx, lines, operation, result)
      return
    }
    // `Array` is the same shape of exception, and for the same reason -- see
    // `emitArrayConstruct`. Its result is an ordinary array-object, not a
    // handle to the host's own object, which is what distinguishes it here.
    if (callee.protocol === 'FunctionConstructor') {
      if (!ctx.deriver.dynamicFallback || result.kind !== 'dynamic')
        throw createCppEmitBlockedError(
          'call-abi:function-constructor',
          'Function requires --dynamic-fallback and a dynamic callable result'
        )
      const args = functionConstructorArgumentTexts(ctx, operation.arguments, 'construct')
      lines.push(`${defineValue(ctx, operation.result)} = gea::Eval::constructFunction({${args.join(', ')}});`)
      return
    }
    if (callee.protocol === 'ProxyConstructor') {
      if (!ctx.deriver.dynamicFallback || result.kind !== 'dynamic')
        throw createCppEmitBlockedError('call-abi:proxy-construct', 'Proxy requires --dynamic-fallback and a dynamic result carrier')
      if (operation.arguments.length !== 2) throw createCppEmitBlockedError('call-abi:proxy-construct', 'Proxy requires target and handler')
      const args = operation.arguments.map((argument) => boxedValueText(ctx, argument, 'Proxy construction'))
      lines.push(`${defineValue(ctx, operation.result)} = gea::Value::proxy(${args.join(', ')});`)
      return
    }
    if (result.kind === 'array-object' && callee.protocol === 'ArrayConstructor') {
      emitArrayConstruct(ctx, lines, operation, result)
      return
    }
    // `Map`/`Set`/`WeakMap`/`WeakSet` -- the third case of the same exception,
    // for the same unjoinable-overload-set reason. See
    // `emitKeyedCollectionConstruct`.
    if (result.kind === 'keyed-collection') {
      emitKeyedCollectionConstruct(ctx, lines, operation, result)
      return
    }
    // `Date` -- the fourth case, and the same unjoinable overload set again:
    // `new Date()`, `new Date(value)` and `new Date(year, monthIndex, ...)`
    // are three different parameter-0 shapes. See `emitDateConstruct`
    // (emit-prototype-date.ts), which owns every Date spelling this backend has.
    if (isDateCarrier(result) && result.kind === 'native-record-ref') {
      emitDateConstruct(ctx, lines, operation, result)
      return
    }
    // `RegExp` -- the fourth case of the same exception, for the same
    // unjoinable-overload-set reason. See `emitRegExpConstruct`.
    if (regexpRoleOf(result) === 'pattern') {
      emitRegExpConstruct(ctx, lines, operation)
      return
    }
    if (!callee.construct) {
      throw createCppEmitBlockedError(
        `host-invocation:${callee.native ?? callee.protocol}`,
        `a "${callee.protocol}" host handle carries no [[Construct]] convention this program's checker derived for it`
      )
    }
    const invocation = nativeHandleInvocationText(ctx, callee, callee.construct, operation.arguments, 'construct', result)
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${invocation};`)
    return
  }
  // A plain JS constructor function whose `.prototype` the program itself
  // mutates (`prototypeMutatedConstructorTypes`, dynamic-fallback.ts) is boxed
  // to `dynamic`, and `translation-unit.ts`'s `constructThunkOf` refuses to
  // build a native construct thunk for it (its instance carrier is `dynamic`,
  // not `record`/`record-with-index`/`native-record-ref`) -- so `new F()`
  // cannot go through the constructor-family path below at all. `Value::construct`
  // (gea_runtime.h) is the ECMA-262 10.2.2 OrdinaryCreateFromConstructor
  // equivalent instead: it makes a fresh object whose [[Prototype]] is
  // whatever `F.prototype` CURRENTLY holds, re-enters through the ordinary
  // `[[Call]]` thunk with that object as `this`, and returns the object
  // unless the body itself returned one.
  if (callee.kind === 'dynamic') {
    const args = operation.arguments.map((argument) => boxedValueText(ctx, argument, 'dynamic construction argument'))
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${operandText(ctx, operation.callee)}.construct({${args.join(', ')}});`)
    return
  }
  if (callee.kind !== 'constructor-family' && callee.kind !== 'constructor-value-dispatch' && callee.kind !== 'function-and-constructor') {
    throw createCppEmitBlockedError(
      `call-abi:no-construct-path:${callee.kind}`,
      `a callee carried as "${callee.kind}" has no construct path; this emitter constructs only through a constructor carrier`
    )
  }
  // The construct convention, which is the callee's own and not its call one:
  // `function-and-constructor` states both, and padding a construction against
  // the call frame would count the wrong parameters.
  const abi = callee.kind === 'function-and-constructor' ? callee.construct : callee.abi
  // Reconciled against the declared parameter slot exactly as `emitCall`'s
  // generic path reconciles a call's arguments (`argumentText`, above) --
  // this used raw `operandText` before, which left a dynamic-sourced
  // argument (e.g. a caught `error` passed to `new SomeClass(error)`) never
  // converted at all, an unconditional over-claim the moment anything
  // upstream started asking whether that conversion was even installed. See
  // `preflight/invocation-arguments.ts`'s `conversion-role:invocation:construct:argument`.
  const args = receivableArguments(abi, operation.arguments).map((argument, position) =>
    argumentText(ctx, abi, position, argument, 'construct')
  )
  // Devirtualized only where the program constructs REPEATEDLY, which is the
  // distinction an earlier attempt at this lacked: naming the construct
  // function lets clang inline the whole construction -- `gea::makeRef`, its
  // pool refill, its `try`/`catch` -- into whatever body constructs, and that
  // is worth 46.1ms to 41.9ms in `binary_trees`, which constructs a million
  // times inside a recursive body, and 38.1ms to 49.0ms the wrong way in
  // `method_calls`, which constructs once before a hot loop whose own callee
  // then stops being inlined. `buildRepeatedConstructorIndex` answers which,
  // and its doc carries the rest of the measurements -- including `noinline`
  // on the construct function, the obvious way to have the direct call without
  // the inlining, which is worse than either (41.9ms to 44.5ms).
  const cell = ctx.bindingReadDeclarations.get(operation.callee.value)
  const repeated = cell === undefined ? undefined : ctx.repeatedConstructors.get(cell)
  const invocation =
    repeated === undefined
      ? `${operandText(ctx, operation.callee)}.construct(${paddedArguments(abi, args, 'construct').join(', ')})`
      : `${cppConstructName(repeated)}(${[
          `static_cast<gea::NativeClassMethodState*>(${operandText(ctx, operation.callee)}.environment)`,
          ...paddedArguments(abi, args, 'construct')
        ].join(', ')})`
  const name = defineValue(ctx, operation.result)
  lines.push(`${name} = ${invocation};`)
}

/**
 * Class evaluation allocates a native prototype owner, even when its methods
 * capture nothing. Constructor copies share it, while another evaluation of
 * the same declaration gets a new owner. The evaluated superclass supplies
 * the parent owner; looking it up by declaration would conflate factories.
 *
 * This state carries method identities only. Constructor body/field capture
 * transport remains subject to the existing fail-closed admission below.
 */
export const emitAllocateConstructor = (ctx: EmitContext, lines: string[], operation: AllocateConstructorOperation): void => {
  if (operation.captures.length > 0) {
    throw createCppEmitBlockedError(
      'capture:class-constructor',
      `carries ${operation.captures.length} capture(s); a class's methods and field initializers are called directly by ` +
        "translation-unit.ts's constructDefinitionsOf, with no environment parameter to receive one, so no capture can be transported here"
    )
  }
  const name = defineValue(ctx, operation.result)
  const heritageOperand = operation.heritage
  const heritage = heritageOperand?.representation
  // A family of several classes is a base's constructor slot that the program
  // also stores subclasses into; the struct extends the family's declared
  // class alone, so the evaluated value is checked to be exactly that class.
  const exactBase =
    heritage?.kind === 'constructor-family' && heritage.members.length > 1 && heritage.abi.result.kind === 'class-ref'
      ? heritage.abi.result.declaration
      : null
  const parent =
    heritage?.kind !== 'constructor-family' || !heritageOperand
      ? ''
      : exactBase !== null
        ? `gea::exactNativeClassHeritage<${cppClassName(exactBase)}>(${operandText(ctx, heritageOperand)}.environment)`
        : `gea::nativeClassMethodStateFromEnvironment(${operandText(ctx, heritageOperand)}.environment)`
  const environment = `gea::allocateNativeClassMethodEnvironment<${cppClassName(operation.declaration)}>(${parent})`
  lines.push(`${name} = ${cppTypeOf(operation.result.representation)}{&${cppConstructThunkName(operation.declaration)}, ${environment}};`)
}
