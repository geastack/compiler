import type { CallOperation, IrOperand, IrResult } from '../../../ir/model.js'
import type { CallableAbi, Representation } from '../../../representation/model.js'
import { dictionaryKeyDomainOf, representationKey } from '../../../representation/model.js'
import { hasReferenceIdentity } from '../../../representation/collections.js'
import { thrownValueCarrier } from '../../../ir/lower-exceptions.js'
import { alignedValueText, callableObjectAbi } from '../emit-narrowing.js'
import { cppConstantLiteral, cppStringLiteral, cppTypeOf, cppUndefinedValue } from '../types.js'
import {
  createCppEmitBlockedError,
  operandText,
  prototypeMethodReceiverText,
  type EmitContext,
  type PrototypeMethodRead
} from '../emit-context.js'
import { arrayMethods } from './emit-prototype-array.js'
import { dateCallText } from './emit-prototype-date.js'
import { nativeErrorCallText } from './emit-prototype-error.js'
import { unionToStringCallText } from '../emit-union-properties.js'
import { iteratorCallText } from './emit-prototype-iterator.js'
import { stringMethods, type NativeScalarCall } from './emit-prototype-string.js'
import { regexpMethodCallText } from './emit-prototype-regexp.js'
import { dataViewCallText, typedArrayCallText, typedArrayElementSpelling } from '../emit-buffers.js'
import { keyedTableKeyText } from '../emit-carrier-members.js'
import { callableShapeCallText, dynamicObjectCallText, nativeHandleShapeCallText, objectShapeCallText } from '../host/object-protocol.js'

/**
 * `String.prototype`/`Number.prototype`/`Array.prototype` calls that fuse a deferred `[[Get]]`
 * (`emit-carrier-members.ts`'s `stringMemberText`/`arrayAccessText`) with the
 * call that follows it into one C++ expression.
 *
 * This is the identical two-step shape `emit-host-invoke.ts`'s `hostCallText`
 * already uses for a host method (`el.setAttribute(k, v)`) -- the access
 * records which member was reached off which receiver and renders nothing;
 * the call reads that record and renders the whole thing at once -- applied
 * to a different receiver family for a different reason. A host member is
 * deferred because the *host* states no spelling for the bare member, only
 * for the call. A String/Array prototype member is deferred because ECMA-262
 * gives the ambient `lib.es5.d.ts` interface method no `this` parameter at
 * all (`stringMemberText`'s own comment), so there is no receiver-carrying
 * calling convention this backend could build a first-class `CallableObject`
 * from -- the receiver has to be fused in at the call site instead of routed
 * through one.
 *
 * `ctx.prototypeMethodReads` is a map of its own, separate from
 * `ctx.hostMemberReads`: the two mechanisms share a shape but not a table, so
 * a String/Array method can never be mistaken for (or silently fall through
 * to) a real `gea::host` protocol member, and `hostCallText`'s own
 * fail-closed "no method template" guard stays exactly as strict as it was
 * for every actual host member.
 *
 * Every member is refused by name at the `[[Get]]`, before this file is ever
 * reached, unless its own family's table has a renderer for it. Each family
 * exports that table's key set so `emit-carrier-members.ts` defers exactly the
 * keys a renderer exists for -- one authority for "is this method
 * implemented", not two lists that could drift apart.
 *
 * The two large families live in files of their own, because the table IS the
 * content and `String.prototype` and `Array.prototype` each have enough of it
 * to bury the dispatch below:
 *
 *   - `emit-prototype-string.ts` -- `stringMethods` / `stringPrototypeMethods`
 *     / `stringMemberRefusals`
 *   - `emit-prototype-array.ts`  -- `arrayMethods` / `arrayPrototypeMethods`
 *     / `arrayMemberRefusals`
 *
 * What stays here is `Number.prototype`, `Promise.prototype`, the four keyed
 * collections, and the dispatch that routes a deferred read to its family.
 */

/**
 * ECMA-262 21.1.3.3/21.1.3.2/21.1.3.5 `Number.prototype.toFixed` /
 * `toExponential` / `toPrecision`.
 *
 * One argument, and `gea_runtime.h` already implements all three -- ported
 * from v1's own `gea::runtime::numeric` family, digit clamping and the
 * NaN/Infinity arms included -- so what is added here is only the fusion of
 * the deferred `[[Get]]` with its call, exactly as `substring` is.
 *
 * The zero-argument forms are refused rather than defaulted. ECMA-262 gives
 * `toFixed()` an implied `fractionDigits` of 0 and `toPrecision()` a
 * ToString-of-the-number result that is a *different* operation, and an
 * omitted trailing optional argument never reaches `operation.arguments` at
 * all (`substringText`'s own note) -- so synthesizing a digit count here
 * would render one of those two forms as the other for `toPrecision`, which
 * is a wrong answer rather than a missing one.
 */
const numberFormatText =
  (member: 'toFixed' | 'toExponential' | 'toPrecision', clause: string) =>
  (ctx: EmitContext, receiverText: string, args: readonly IrOperand[]): string => {
    const digits = args[0]
    if (args.length !== 1 || !digits) {
      throw createCppEmitBlockedError(
        `host-invocation:Number.prototype.${member}`,
        `"Number.prototype.${member}" is spelled for its one digits argument (ECMA-262 ${clause}); this call passes ${args.length}` +
          (args.length === 0 ? ', and the argument-less form is a different operation rather than this one with a default' : '')
      )
    }
    if (digits.representation.kind !== 'scalar' || digits.representation.domain !== 'number') {
      throw createCppEmitBlockedError(
        `host-invocation:Number.prototype.${member}`,
        `"Number.prototype.${member}"'s digits argument carries a "${representationKey(digits.representation)}" carrier, not a number scalar`
      )
    }
    return `gea::host::detail::${member}(${receiverText}, ${operandText(ctx, digits)})`
  }

/**
 * `Number.prototype.toString` -- ECMA-262 21.1.3.6.
 *
 * The one number method here whose radix argument is genuinely optional, and
 * the two forms are two different runtime functions rather than one with a
 * default: 21.1.3.6 step 5 says a radix of 10 *is* `Number::toString(x)`, the
 * same operation `ToString(number)` performs, and every other radix is the
 * separate digit-layout the following steps describe.
 */
const numberToStringText = (ctx: EmitContext, receiverText: string, args: readonly IrOperand[]): string => {
  if (args.length === 0) return `gea::host::detail::toString(${receiverText})`
  const radix = args[0]
  if (args.length !== 1 || !radix) {
    throw createCppEmitBlockedError(
      'host-invocation:Number.prototype.toString',
      `"Number.prototype.toString" takes at most one radix argument (ECMA-262 21.1.3.6); this call passes ${args.length}`
    )
  }
  if (
    radix.representation.kind === 'optional' &&
    radix.representation.absence === 'undefined' &&
    radix.representation.payload.kind === 'scalar' &&
    radix.representation.payload.domain === 'number'
  ) {
    const text = operandText(ctx, radix)
    return `(${text}.has_value() ? gea::host::detail::toStringRadix(${receiverText}, *${text}) : gea::host::detail::toString(${receiverText}))`
  }
  if (radix.representation.kind !== 'scalar' || radix.representation.domain !== 'number') {
    throw createCppEmitBlockedError(
      'host-invocation:Number.prototype.toString',
      `"Number.prototype.toString"'s radix argument carries a "${representationKey(radix.representation)}" carrier, not a number scalar`
    )
  }
  return `gea::host::detail::toStringRadix(${receiverText}, ${operandText(ctx, radix)})`
}

/** `emit-carrier-members.ts`'s `scalarMemberText` defers exactly these keys off a number-domain `scalar` receiver. */
const numberMethods: ReadonlyMap<string, (ctx: EmitContext, receiverText: string, args: readonly IrOperand[]) => string> = new Map([
  ['toFixed', numberFormatText('toFixed', '21.1.3.3')],
  ['toExponential', numberFormatText('toExponential', '21.1.3.2')],
  ['toPrecision', numberFormatText('toPrecision', '21.1.3.5')],
  ['toString', numberToStringText],
  [
    'valueOf',
    (_ctx, receiverText, args) => {
      if (args.length !== 0) {
        throw createCppEmitBlockedError(
          'host-invocation:Number.prototype.valueOf',
          `"Number.prototype.valueOf" takes no arguments; this call passes ${args.length}`
        )
      }
      return receiverText
    }
  ]
])

/** The locals `promiseReactionText`'s rendering binds, named out of every body-local namespace its text can be spliced into. */
const caughtSettledName = 'gea_catch_settled'
const caughtReasonName = 'gea_catch_reason'
const caughtValueName = 'gea_catch_value'
const catchResultName = 'gea_catch_result'
const catchHandlerName = 'gea_catch_handler'
const fulfilledHandlerName = 'gea_then_handler'
const fulfilledValueName = 'gea_then_value'
const settledResultName = 'gea_then_settled'

/**
 * The fulfillment handler `gea::Promise<V>::then` is actually handed.
 *
 * `then` is a template: it invokes whatever it is given with the promise's OWN
 * payload, `const V&`. The handler the program wrote declares the parameter
 * the CHECKER gave it, which TypeScript only requires `V` to be assignable to
 * -- and assignable is not the same as physically identical. A per-arm
 * dispatch of a union of promises is where the two come apart at their widest:
 * hono's `HonoRequest.#cachedBody` reads `bodyCache[anyCachedKey]`, whose
 * carrier is a `TaggedUnion` of five `Promise`s, and calls `.then(body => ...)`
 * on it with one handler declaring the UNION of the five payloads.
 * `prototype-method-reads.ts`'s mixed-union claim rightly renders that as five
 * arms, one per promise, and each arm then hands `then` a handler whose
 * parameter is the whole union while its own payload is a single arm of it.
 * The result was five `callSettledHandler` substitution failures inside the
 * header and a `Promise<int>` (the degenerate `promise_result_t` of a failed
 * deduction) where the program's own result carrier belonged.
 *
 * So the value is converted into the parameter the handler declared, by the
 * same authority and with the same text `promiseReactionText`'s two-handler
 * form already uses for it (`argumentText`). The adapter is a C++ lambda
 * rather than another `CallableObject`, because `then` names no handler type
 * to build one at and a lambda captures the handler exactly once.
 *
 * Handed straight back where nothing has to be converted -- a handler that
 * declares no parameter at all (27.2.5.4 lets it: `p.then(() => reload())`,
 * which `detail::callSettledHandler` already serves), a receiver whose carrier
 * was not recorded, a `Promise<void>` whose fulfillment value is `undefined`
 * rather than a payload, and the ordinary case where the two agree.
 */
const fulfilledHandlerText = (
  ctx: EmitContext,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined,
  abi: CallableAbi | null,
  handlerText: string
): string => {
  if (receiverCarrier === undefined || abi === null) return handlerText
  const payload = receiverCarrier.value
  if (payload.kind === 'void') return handlerText
  const slot = abi.parameters[0]
  if (slot === undefined || abi.parameters.length !== 1 || abi.receiver !== null || abi.restFrom !== null) return handlerText
  if (representationKey(slot.value) === representationKey(payload)) return handlerText
  const converted = alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:then-handler-value', payload, slot.value, fulfilledValueName)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(payload)}->${representationKey(slot.value)}`,
      `a "Promise.prototype.then" handler declares its fulfillment value as "${representationKey(slot.value)}" and no conversion is ` +
        `installed from the "${representationKey(receiverCarrier)}" receiver's own payload`
    )
  }
  return (
    `[${fulfilledHandlerName} = ${handlerText}](const ${cppTypeOf(payload)}& ${fulfilledValueName}) ` +
    `{ return ${fulfilledHandlerName}.call(${converted}); }`
  )
}

/**
 * ECMA-262 27.2.5.4 `Promise.prototype.then`.
 *
 * `then(onFulfilled)` is the runtime's own member. `gea::Promise<V>::then`
 * deduces the result from the handler, adopts a thenable it returns, and
 * forwards a rejection it was given no handler for -- so nothing is needed
 * here but the result reconciliation below. The callback's own carrier is not
 * checked on that path either: `then` is a template that invokes whatever it
 * is handed with the promise's own payload, so C++ rejects a callable that
 * cannot take it, at the same call this renders.
 *
 * `then(onFulfilled, onRejected)` is NOT that call with one more argument, and
 * it is not `then(f).catch(r)` either: 27.2.5.4 installs both reactions on the
 * SAME promise, so `onRejected` observes the RECEIVER's rejection and never a
 * throw from `onFulfilled` -- 27.2.5.4 step 5 hands both to
 * `PerformPromiseThen` on one `[[PromiseReactions]]` list, where chaining
 * would have given `onFulfilled`'s own abrupt completion somewhere to land.
 * Rendering it as the chain would silently swallow that throw.
 *
 * It also inherits `catch`'s result problem -- the result fulfils with EITHER
 * handler's value, and that union is the representation layer's answer rather
 * than a deduction -- so the two share `promiseReactionText` below, which is
 * where both the reason conversion and the result-carrier agreement live.
 */
const promiseThenText = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined
): string => {
  const onFulfilled = args[0]
  if (args.length > 2 || !onFulfilled) {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.then',
      `"Promise.prototype.then" takes a fulfillment handler and an optional rejection handler (ECMA-262 27.2.5.4); this call passes ${args.length}`
    )
  }
  const onRejected = args[1]
  if (onRejected !== undefined) {
    return promiseReactionText(ctx, 'then', receiverText, onFulfilled, onRejected, result, receiverCarrier)
  }
  const abi = callableObjectAbi(onFulfilled.representation)
  const text = `${receiverText}.then(${fulfilledHandlerText(ctx, receiverCarrier, abi, operandText(ctx, onFulfilled))})`
  // `gea::Promise<V>::then` DEDUCES its result from the handler's own result --
  // 27.2.5.4.1 adopts a thenable, so `U` and `Promise<U>` both land on
  // `Promise<U>` -- while the emitter has ALREADY placed a cell for this call.
  // Those are two authorities, and where they disagree the assignment is a bare
  // `no viable overloaded '='`: a handler returning ONE ARM of a sum the cell
  // carries whole is exactly that shape, and `gea::Promise` has no converting
  // constructor from a promise over an arm. Reconciling it here routes the
  // difference through the one conversion authority, which hands the text back
  // untouched when the two already agree (the common case).
  //
  // A handler whose own result is a sum is left alone: the runtime's
  // `promise_result` collapses `TaggedUnion<T, Promise<T>>` to `Promise<T>` and
  // keeps a genuine union of fulfillment values whole, and re-deciding that
  // here would be a THIRD authority free to disagree with both.
  const handlerResult = abi === null ? null : abi.result
  if (result === null || handlerResult === null || handlerResult.kind === 'tagged-union') return text
  const deduced: Representation = { kind: 'promise', value: handlerResult.kind === 'promise' ? handlerResult.value : handlerResult }
  const aligned = alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:then', deduced, result.representation, text)
  if (aligned === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(deduced)}->${representationKey(result.representation)}`,
      `a "Promise.prototype.then" over a handler returning "${representationKey(handlerResult)}" settles "${representationKey(deduced)}", ` +
        `and no conversion is installed into the cell this call publishes, "${representationKey(result.representation)}"`
    )
  }
  return aligned
}

/**
 * ECMA-262 27.2.5.1 `Promise.prototype.catch(onRejected)` -- which step 3
 * defines as `then(undefined, onRejected)` -- and 27.2.5.4's own two-handler
 * form, which is the same machine with the fulfilled arm filled in. One
 * renderer for both, because 27.2.5.1 IS 27.2.5.4 with one argument elided,
 * and two renderers would be two places for the reason conversion and the
 * result agreement to drift apart.
 *
 * Rendered HERE rather than as a `gea::Promise` member, and that is not a
 * style choice. Two things a template member cannot do:
 *
 * - It cannot name the result carrier. `then`'s result is `Promise<U>` for a
 *   handler returning `U`, which the runtime deduces exactly; `catch`'s is
 *   `Promise<T | TResult>` -- a UNION of the receiver's payload and the
 *   handler's result, and the union's carrier is the representation layer's
 *   answer, not a deduction. A deduced one would be a second authority, free
 *   to disagree with the cell the emitter already placed.
 * - It cannot convert into that carrier. Both arms may need one (the
 *   receiver's `T` and the handler's `TResult` into the union), and a
 *   conversion is `convertedValueText`'s to render -- boxing needs
 *   `dynamicTagFor`, which is emitter-side for the reason
 *   `resultAdapterOf` states.
 *
 * So the runtime supplies only what the language cannot express in the
 * emitter: `rejected()`, and `rethrow()` to recover the thrown value. The
 * rejection travels as an `exception_ptr` (see `gea::Promise`'s own comment),
 * and rethrowing inside a handler is how its payload comes back typed -- every
 * `throw` this backend emits carries `thrownValueCarrier`, so `catch (const
 * gea::Value&)` catches all of them, which `emit-exceptions.ts` already checks
 * for the source program's own `try`/`catch`.
 *
 * The three states are all rendered. Rejected: run the handler. Fulfilled: the
 * value passes through unchanged (27.2.5.1 installs no fulfillment handler) or
 * through 27.2.5.4's second-form handler. Unsettled: an unsettled result --
 * there is no value to pass through and no rejection to handle, and reading
 * `value()` there would convert a payload the program never produced.
 */
const promiseReactionText = (
  ctx: EmitContext,
  family: 'then' | 'catch',
  receiverText: string,
  onFulfilled: IrOperand | undefined,
  onRejected: IrOperand,
  result: IrResult | null,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined
): string => {
  const label = family === 'catch' ? 'Promise.prototype.catch' : 'Promise.prototype.then'
  const clause = family === 'catch' ? '27.2.5.1' : '27.2.5.4'
  const published = result === null ? null : result.representation
  if (published !== null && published.kind !== 'promise') {
    throw createCppEmitBlockedError(
      `host-invocation:${label}`,
      `a "${label}" result carries "${representationKey(published)}", not a promise; ${clause} returns one, ` +
        'and a discarded result leaves the two arms no cell to agree on'
    )
  }
  // A result NOBODY reads is not a reason to drop the reaction. `p.catch(h)`
  // and `p.then(f, g)` as STATEMENTS are how @hono/node-server spells every
  // stream teardown, and the handlers still have to run; what is absent is only
  // a cell for the two arms to agree on. So the rendering publishes the one
  // carrier that needs no agreement -- a `Promise<void>` -- and every arm
  // settles it by running rather than by producing a value. The value the
  // program discarded stays discarded; the rejection nothing handled is still
  // held, which is the only part of 27.2.5.1's result still observable.
  const discarded = published === null
  const carrier: Extract<Representation, { kind: 'promise' }> = published ?? { kind: 'promise', value: { kind: 'void' } }
  if (receiverCarrier === undefined) {
    throw createCppEmitBlockedError(
      `host-invocation:${label}`,
      `a "${label}" reached with no receiver carrier recorded has no fulfilled arm to render`
    )
  }
  const resultType = cppTypeOf(carrier)
  const handlerAbi = (handler: IrOperand, role: 'rejection' | 'fulfillment') => {
    const abi = callableObjectAbi(handler.representation)
    if (!abi || abi.receiver !== null || abi.restFrom !== null || abi.parameters.length > 1) {
      throw createCppEmitBlockedError(
        `host-invocation:${label}`,
        `a "${label}" handler carried as "${representationKey(handler.representation)}" is not a plain 0- or 1-parameter ` +
          `callable; ${clause} calls it with the ${role === 'rejection' ? 'rejection reason' : 'fulfillment value'} and nothing else -- ` +
          'no receiver, no rest pack'
      )
    }
    return abi
  }
  /**
   * The argument a reaction handler is called with, converted from whatever
   * the reaction itself has in hand into the parameter the handler declared --
   * or nothing at all, because ECMA-262 passes a value the handler is free not
   * to declare (`p.catch(() => fallback)` is ordinary JavaScript).
   */
  const argumentText = (
    abi: NonNullable<ReturnType<typeof callableObjectAbi>>,
    source: Representation,
    text: string,
    site: string,
    note: string
  ): string => {
    const slot = abi.parameters[0]
    if (slot === undefined) return ''
    const converted = alignedValueText(ctx, site, source, slot.value, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(source)}->${representationKey(slot.value)}`,
        `a "${label}" handler declares its ${note} as "${representationKey(slot.value)}" and no conversion is installed from ` +
          `"${representationKey(source)}"`
      )
    }
    return converted
  }
  /**
   * Settle this call's result from one handler's own result.
   *
   * A handler that itself returns a promise: the result RESOLVES with the
   * handler's result, and resolving with a thenable adopts its state
   * (27.2.5.4.1) -- so the whole promise converts, rather than its payload
   * being wrapped in a fresh one. `convertedValueText`'s promise-to-promise
   * pair is that adoption, rejection and all.
   *
   * A handler that returns NOTHING settles the result by running, not by
   * producing a value to adopt. `void` is not a carrier -- `cppResultTypeOf`
   * elides the payload rather than standing an `Undefined` in for it, and the
   * runtime's `Promise<void>` specialization matches that exactly: `resolve()`
   * takes no argument.
   */
  const settledText = (abi: NonNullable<ReturnType<typeof callableObjectAbi>>, handlerName: string, argument: string): string => {
    const handled = `${handlerName}.call(${argument})`
    if (discarded) return `${handled}; ${catchResultName}.resolve();`
    if (abi.result.kind === 'void') {
      if (carrier.value.kind === 'void') return `${handled}; ${catchResultName}.resolve();`
      // A function that falls off its end produced `undefined` (ECMA-262
      // 10.2.1.4: an implicit return completion carries it), and the result
      // resolves WITH that. TypeScript writes exactly this as the `| void` arm
      // of `Promise<T | void>` -- `p.catch((e) => { log(e) })` in
      // @hono/node-server's listener -- so refusing here would refuse the
      // program's own declared type. What has to exist is a rendering of
      // absence in the result's payload; where the payload cannot hold one,
      // the handler genuinely cannot settle it and that is still a refusal.
      const absent = alignedValueText(
        ctx,
        'prototype/emit-prototype-invoke.ts:void-handler',
        { kind: 'undefined' },
        carrier.value,
        cppUndefinedValue
      )
      if (absent === null) {
        throw createCppEmitBlockedError(
          `conversion:void->${representationKey(carrier.value)}`,
          `a "${label}" handler returns nothing while this call's result carries "${representationKey(carrier)}"; ${clause} ` +
            "resolves the result WITH the handler's result, and this payload has no rendering of the `undefined` it produced"
        )
      }
      return `${handled}; ${catchResultName}.resolve(${absent});`
    }
    // A handler that MAY have produced a thenable. 27.2.5.4.1 is a per-VALUE
    // test, not a per-type one -- a thenable is adopted and anything else,
    // `undefined` included, resolves to itself -- so an `optional` over a
    // promise settles the result one way when it is present and the other when
    // it is not. @hono/node-server's `writeFromReadableStream` is the shape:
    // its pump is `(result) => Promise<void> | undefined`, the next hop while
    // the source has one and nothing once it is drained, handed straight to
    // `read().then(pump, onError)`.
    //
    // Neither arm below can answer it, and the general one answered it WRONG
    // rather than refusing: `alignedValueText` from an optional thenable into
    // an `undefined` payload is the discard, which folds to the constant
    // `gea::Undefined{}` and drops `handled` entirely -- the handler never ran,
    // and with it the whole rest of the pump. Resolving instead of adopting
    // would be the quieter version of the same loss: the returned promise's
    // rejection is the only part of that chain still observable from here.
    if (abi.result.kind === 'optional' && abi.result.payload.kind === 'promise') {
      const adopted = alignedValueText(
        ctx,
        'prototype/emit-prototype-invoke.ts:optional-thenable',
        abi.result.payload,
        carrier,
        `(*${settledResultName})`
      )
      const absent =
        carrier.value.kind === 'void'
          ? ''
          : alignedValueText(
              ctx,
              'prototype/emit-prototype-invoke.ts:optional-thenable-absent',
              { kind: 'undefined' },
              carrier.value,
              cppUndefinedValue
            )
      if (adopted === null || absent === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(abi.result)}->${representationKey(carrier)}`,
          `a "${label}" handler returns "${representationKey(abi.result)}" -- a thenable that may be absent -- and no conversion is ` +
            `installed from ${adopted === null ? 'its payload' : 'the absence it stands for'} into this call's own result ` +
            `"${representationKey(carrier)}"`
        )
      }
      return (
        `const auto ${settledResultName} = ${handled}; ` +
        `if ((${settledResultName}).has_value()) ${catchResultName}.adopt(${adopted}); ` +
        `else ${catchResultName}.resolve(${absent});`
      )
    }
    // The result declares NO payload while the handler produced one. A
    // `Promise<void>` is settled by RUNNING, not by carrying a value: the
    // runtime's `Promise<void>::resolve()` takes no argument, and
    // `gea::Promise<void>(x)` is not a constructor -- the void conversion
    // `alignedValueText` renders for the payload is the discard `(void)(x)`,
    // which the `resultType(...)` wrapper below then tried to build a promise
    // out of ("no matching conversion for functional-style cast from 'void'").
    // @hono/node-server's stream pump is the shape: `reader.read().then(handler,
    // onError)` whose handler returns a value nothing reads, published as a
    // `Promise<void>` because the program's own type says so.
    //
    // A handler returning a PROMISE is excluded and takes the branch below:
    // 27.2.5.4.1 ADOPTS it, so the result settles when that promise settles and
    // rejects if it rejects -- dropping it here would resolve the result early
    // and swallow the rejection.
    if (carrier.value.kind === 'void' && abi.result.kind !== 'promise') return `${handled}; ${catchResultName}.resolve();`
    const arm =
      abi.result.kind === 'promise'
        ? alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:269', abi.result, carrier, handled)
        : ((payload) => (payload === null ? null : `${resultType}(${payload})`))(
            alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:271', abi.result, carrier.value, handled)
          )
    if (arm === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(abi.result)}->${representationKey(carrier)}`,
        `a "${label}" handler returns "${representationKey(abi.result)}" and no conversion is installed into this call's own ` +
          `result "${representationKey(carrier)}"`
      )
    }
    return `${catchResultName}.adopt(${arm});`
  }
  const rejectedAbi = handlerAbi(onRejected, 'rejection')
  const rejectedBody = settledText(
    rejectedAbi,
    catchHandlerName,
    argumentText(rejectedAbi, thrownValueCarrier, caughtReasonName, 'prototype/emit-prototype-invoke.ts:253', 'reason')
  )
  // A `Promise<void>` receiver has no value to hand a fulfilled arm, so
  // `observe`'s fulfilled arm is niladic there (the specialization calls it
  // with no argument) -- and a handler that declared a parameter anyway is
  // handed the `undefined` 27.2.5.4 says the fulfillment value is.
  const voidPayload = receiverCarrier.value.kind === 'void'
  const fulfilledParameter = voidPayload ? '' : `const ${cppTypeOf(receiverCarrier.value)}& ${caughtValueName}`
  const fulfilledArm = ((): string => {
    if (onFulfilled !== undefined) {
      const abi = handlerAbi(onFulfilled, 'fulfillment')
      const argument = voidPayload
        ? argumentText(abi, { kind: 'undefined' }, cppUndefinedValue, 'prototype/emit-prototype-invoke.ts:then-void-value', 'value')
        : argumentText(abi, receiverCarrier.value, caughtValueName, 'prototype/emit-prototype-invoke.ts:then-value', 'value')
      return (
        `[${catchResultName}, ${fulfilledHandlerName}](${fulfilledParameter}) mutable { ` +
        `try { ${settledText(abi, fulfilledHandlerName, argument)} } ` +
        `catch (...) { ${catchResultName}.reject(std::current_exception()); } }`
      )
    }
    // 27.2.5.1 installs no fulfillment handler, so the receiver's fulfillment
    // value travels through unchanged -- unless nobody can read it, in which
    // case the `Promise<void>` above settles by running and the value stops
    // here rather than being converted into a carrier no cell asked for.
    if (discarded) {
      return voidPayload
        ? `[${catchResultName}]() mutable { ${catchResultName}.resolve(); }`
        : `[${catchResultName}](const ${cppTypeOf(receiverCarrier.value)}&) mutable { ${catchResultName}.resolve(); }`
    }
    if (voidPayload && carrier.value.kind !== 'void') {
      throw createCppEmitBlockedError(
        `conversion:void->${representationKey(carrier.value)}`,
        `a "${label}" over a "${representationKey(receiverCarrier)}" receiver has no fulfillment value to pass through into ` +
          `"${representationKey(carrier)}"; ${clause} installs no fulfillment handler, so the result can only fulfil with nothing`
      )
    }
    const passedThrough = voidPayload
      ? ''
      : alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:280', receiverCarrier.value, carrier.value, caughtValueName)
    if (passedThrough === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(receiverCarrier.value)}->${representationKey(carrier.value)}`,
        `a "${label}" over a "${representationKey(receiverCarrier)}" receiver cannot pass its fulfillment value through into ` +
          `"${representationKey(carrier)}"; ${clause} installs no fulfillment handler, so the value has to travel unchanged`
      )
    }
    return voidPayload
      ? `[${catchResultName}]() mutable { ${catchResultName}.resolve(); }`
      : `[${catchResultName}](${fulfilledParameter}) mutable { ${catchResultName}.resolve(${passedThrough}); }`
  })()
  const fulfilledBinding = onFulfilled === undefined ? '' : `const auto ${fulfilledHandlerName} = ${operandText(ctx, onFulfilled)}; `
  return (
    `([&]() -> ${resultType} { const auto ${caughtSettledName} = ${receiverText}; ${resultType} ${catchResultName}; ` +
    `const auto ${catchHandlerName} = ${operandText(ctx, onRejected)}; ` +
    fulfilledBinding +
    `${caughtSettledName}.observe(` +
    `${fulfilledArm}, ` +
    `[${catchResultName}, ${catchHandlerName}](const std::exception_ptr& gea_catch_rejection) mutable { ` +
    `try { std::rethrow_exception(gea_catch_rejection); } ` +
    `catch (const ${cppTypeOf(thrownValueCarrier)}& ${caughtReasonName}) { try { ${rejectedBody} } ` +
    `catch (...) { ${catchResultName}.reject(std::current_exception()); } } }); return ${catchResultName}; }())`
  )
}

const promiseCatchText = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined
): string => {
  const onRejected = args[0]
  if (args.length !== 1 || !onRejected) {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.catch',
      `"Promise.prototype.catch" takes one rejection handler (27.2.5.1); this call passes ${args.length}`
    )
  }
  return promiseReactionText(ctx, 'catch', receiverText, undefined, onRejected, result, receiverCarrier)
}

/**
 * ECMA-262 27.2.5.3 `Promise.prototype.finally(onFinally)`.
 *
 * Not `then(h, h)`, and not `catch(h)` either: the handler runs on BOTH
 * settlements and changes neither of them. 27.2.5.3's `thenFinally` calls
 * `onFinally` and then returns the original value; `catchFinally` calls it and
 * then RETHROWS the original reason. So the result carries the receiver's
 * settlement through unchanged -- which is why `lib.es5.d.ts` types it
 * `Promise<T>` over the same `T`, with no arm for the handler's own result.
 *
 * The handler is called with NO arguments (27.2.5.3 step 4 builds a niladic
 * `thenFinally`), and its result is dropped -- so the only thing it can
 * contribute to the result is a throw, which 27.2.5.3 lets replace the
 * settlement. The one exception is a THENABLE result: 27.2.5.3 step 5
 * `promiseResolve`s it and waits for it before passing the value on, which
 * this rendering does not do and therefore refuses by name rather than
 * silently running the continuation early. `lib.es5.d.ts` types `onfinally`
 * as `() => void`, so a program has to go out of its way to reach that.
 */
const finallyHandlerName = 'gea_finally_handler'

const promiseFinallyText = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined
): string => {
  const onFinally = args[0]
  if (args.length !== 1 || !onFinally) {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.finally',
      `"Promise.prototype.finally" takes one handler (ECMA-262 27.2.5.3); this call passes ${args.length}` +
        (args.length === 0 ? ', and the handler-less form settles nothing this rendering could observe' : '')
    )
  }
  const published = result === null ? null : result.representation
  if (published !== null && published.kind !== 'promise') {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.finally',
      `a "Promise.prototype.finally" result carries "${representationKey(published)}", not a promise; 27.2.5.3 returns one`
    )
  }
  if (receiverCarrier === undefined) {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.finally',
      'a "Promise.prototype.finally" reached with no receiver carrier recorded has no fulfilled arm to render'
    )
  }
  const discarded = published === null
  const carrier: Extract<Representation, { kind: 'promise' }> = published ?? { kind: 'promise', value: { kind: 'void' } }
  const abi = callableObjectAbi(onFinally.representation)
  if (!abi || abi.receiver !== null || abi.restFrom !== null || abi.parameters.length !== 0) {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.finally',
      `a "Promise.prototype.finally" handler carried as "${representationKey(onFinally.representation)}" is not a plain 0-parameter ` +
        'callable; 27.2.5.3 calls it with no arguments at all -- no reason, no value, no receiver'
    )
  }
  if (abi.result.kind === 'promise') {
    throw createCppEmitBlockedError(
      'host-invocation:Promise.prototype.finally',
      `a "Promise.prototype.finally" handler returns "${representationKey(abi.result)}"; 27.2.5.3 step 5 resolves that thenable and waits ` +
        'for it before passing the settlement on, and running the continuation without that wait would be a different program'
    )
  }
  const voidPayload = receiverCarrier.value.kind === 'void'
  // The value travels through unchanged, exactly as it does across `catch`'s
  // fulfilled arm -- unless nobody reads the result, in which case there is no
  // carrier to travel into and the `Promise<void>` below settles by running.
  const passThrough = ((): string | null => {
    if (discarded || carrier.value.kind === 'void') return ''
    if (voidPayload) return null
    return alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:finally', receiverCarrier.value, carrier.value, caughtValueName)
  })()
  if (passThrough === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(receiverCarrier.value)}->${representationKey(carrier.value)}`,
      `a "Promise.prototype.finally" over a "${representationKey(receiverCarrier)}" receiver cannot pass its fulfillment value through ` +
        `into "${representationKey(carrier)}"; 27.2.5.3 changes the settlement in no way, so the value has to travel unchanged`
    )
  }
  const resultType = cppTypeOf(carrier)
  const fulfilledParameter = voidPayload
    ? ''
    : `const ${cppTypeOf(receiverCarrier.value)}&${passThrough === '' ? '' : ` ${caughtValueName}`}`
  return (
    `([&]() -> ${resultType} { const auto ${caughtSettledName} = ${receiverText}; ${resultType} ${catchResultName}; ` +
    `const auto ${finallyHandlerName} = ${operandText(ctx, onFinally)}; ` +
    `${caughtSettledName}.observe(` +
    `[${catchResultName}, ${finallyHandlerName}](${fulfilledParameter}) mutable { ` +
    `try { ${finallyHandlerName}.call(); ${catchResultName}.resolve(${passThrough}); } ` +
    `catch (...) { ${catchResultName}.reject(std::current_exception()); } }, ` +
    `[${catchResultName}, ${finallyHandlerName}](const std::exception_ptr& gea_finally_rejection) mutable { ` +
    `try { ${finallyHandlerName}.call(); ${catchResultName}.reject(gea_finally_rejection); } ` +
    `catch (...) { ${catchResultName}.reject(std::current_exception()); } }); return ${catchResultName}; }())`
  )
}

/**
 * `p.toString()`.
 *
 * NOT a `Promise.prototype` member -- 27.2.5 defines no `toString` at all. It
 * is `Object.prototype.toString`, which every object inherits, and 20.1.3.6
 * step 15 reads the receiver's `@@toStringTag` for the answer: 27.2.5.5 makes
 * that the literal "Promise". So the result is a class-independent constant
 * with no call, exactly as it is for the same operation reached through
 * `String(p)` and `` `${p}` `` (`emit-tostring.ts`'s own `promise` branch),
 * which is why it renders the same string here.
 *
 * Refusing it read "toString is a Promise.prototype member this backend states
 * no rendering for", which named the wrong prototype and sent the reader to
 * implement a method that does not exist.
 */
const promiseToStringText = (_ctx: EmitContext, _receiverText: string, args: readonly IrOperand[]): string => {
  if (args.length !== 0) {
    throw createCppEmitBlockedError(
      'host-invocation:Object.prototype.toString',
      `"Object.prototype.toString" takes no arguments (20.1.3.6); this call passes ${args.length}`
    )
  }
  return cppConstantLiteral('[object Promise]', 'string', { kind: 'string' })
}

/** The one signature every promise member's renderer has; `result` and the receiver's carrier are read only by `catch`. */
type PromiseCallRenderer = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null,
  receiverCarrier: Extract<Representation, { kind: 'promise' }> | undefined
) => string

const promiseMethods: ReadonlyMap<string, PromiseCallRenderer> = new Map([
  ['then', promiseThenText],
  ['catch', promiseCatchText],
  ['finally', promiseFinallyText],
  ['toString', promiseToStringText]
])

/** The keys `promiseMemberText` may defer -- one authority for "is this method implemented", as above. */
export const promisePrototypeMethods: ReadonlySet<string> = new Set(promiseMethods.keys())

/**
 * The keyed-collection prototype methods this backend renders, per family.
 *
 * Four sets rather than one, because the four interfaces genuinely differ:
 * `Map.prototype` has `get`/`set` and no `add`, `Set.prototype` has `add` and
 * neither, and ECMA-262 gives the two weak families no `clear` and no `size`
 * at all (24.3/24.4) -- there is nothing to clear or count when entries may be
 * collected. Merging them would let `weakSet.clear()` reach an emitter that
 * has a spelling for it, which is exactly the over-claim that turns a preflight
 * refusal into a clang error.
 *
 * Deliberately absent from every family, each still refused BY NAME at its
 * access (`keyedCollectionMemberText`):
 *
 * - `forEach` -- a real ECMA-262 member (23.1.3.5 / 24.2.3.6). It takes a
 *   callback whose `this`-arg and three-parameter frame this backend has no
 *   convention for; `Array.prototype.map` is the one callback-taking method it
 *   does render, and its own renderer below is what that took.
 * - `keys` / `values` -- each returns an iterator whose element carrier is not
 *   currently projected here. Map `entries` is implemented below because its
 *   result already carries the concrete pair type needed by `gea::Iterator`.
 * - `getOrInsert` / `getOrInsertComputed` (ES2026), the ES2025
 *   `union`/`intersection`/`difference`/`isSubsetOf` family, and `Map.groupBy`
 *   / `Set.prototype.symmetricDifference` -- unbuilt, not refused on
 *   principle.
 */
const strongMapMethods: ReadonlySet<string> = new Set(['get', 'set', 'has', 'delete', 'clear', 'entries', 'keys', 'values'])
const strongSetMethods: ReadonlySet<string> = new Set(['add', 'has', 'delete', 'clear'])
const weakMapMethods: ReadonlySet<string> = new Set(['get', 'set', 'has', 'delete'])
const weakSetMethods: ReadonlySet<string> = new Set(['add', 'has', 'delete'])

export type KeyedCollectionFamilyTag = 'map' | 'set' | 'weak-map' | 'weak-set'

export const keyedCollectionPrototypeMethods = (family: KeyedCollectionFamilyTag): ReadonlySet<string> =>
  family === 'map' ? strongMapMethods : family === 'set' ? strongSetMethods : family === 'weak-map' ? weakMapMethods : weakSetMethods

/**
 * The call text for one deferred keyed-collection method.
 *
 * The mutating pair (`set`/`add`) goes through a free function rather than a
 * member call: ECMAScript returns the COLLECTION from both, so the call's
 * result carrier is the collection's own, and a `void` member call would not
 * typecheck against it (`gea::mapSet`/`gea::setAdd`, gea_runtime.h -- v1's
 * `collection_internal::MapSet`/`SetAdd` split, spelled for this backend's
 * `shared_ptr` carrier). Everything else is a plain member call, with `delete`
 * renamed to `remove` in exactly this one place because `delete` is a C++
 * keyword.
 *
 * The receiver's arrow-vs-dot is not decided here: `keyedCollectionMemberText`
 * recorded the receiver text and this carrier is always `shared-refcount` by
 * the time a method defers -- `emitKeyedCollectionConstruct` refuses any other
 * ownership at construction, so a collection reaching a call site is a
 * `shared_ptr`.
 */
const keyedCollectionCallText = (
  ctx: EmitContext,
  carrier: Extract<Representation, { kind: 'keyed-collection' }>,
  member: string,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null
): string => {
  const family = carrier.family
  const expected = member === 'set' ? 2 : member === 'clear' || member === 'entries' || member === 'keys' || member === 'values' ? 0 : 1
  if (args.length !== expected) {
    throw createCppEmitBlockedError(
      `host-invocation:${family}.prototype.${member}`,
      `"${family}.prototype.${member}" takes ${expected} argument(s); this call passes ${args.length}`
    )
  }
  // Every argument is converted into the SLOT it fills -- position 0 is a key
  // and position 1 (`set` only) is the value -- rather than passed as the
  // expression happened to carry it.
  //
  // Load-bearing for exactly one carrier, and it is the one the source itself
  // declared dynamic: `Map<string, any>` is `gea::Map<std::string,
  // gea::Value>`, so `bag.set('a', 1)` arrives with a `double` third argument
  // against a `gea::Value` parameter and `gea::mapSet`'s own template
  // deduction reports conflicting `V`. `convertedValueText` is the same
  // authority every other store goes through, so the box it renders is the
  // one `emit-narrowing.ts` would render anywhere else, not a second spelling
  // of it. For a fully typed collection the source and target carriers are
  // identical and it returns the text unchanged, so nothing native is
  // disturbed.
  const slotOf = (index: number): Representation => (index === 1 && carrier.value ? carrier.value : carrier.key)
  const argumentTexts = args.map((argument, index) => {
    const slot = slotOf(index)
    const text = operandText(ctx, argument)
    if (index === 0 && (family === 'weak-map' || family === 'weak-set') && hasReferenceIdentity(argument.representation)) {
      // A weak collection compares its key by object identity. Its generic K
      // is only the checker's admissibility boundary; rebuilding a
      // structurally compatible class instance as K would create a different
      // object. Preserve the actual reference carrier and let WeakMap/WeakSet
      // erase only its identity after the checker has admitted the call.
      return text
    }
    const converted = alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:438', argument.representation, slot, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(argument.representation)}->${representationKey(slot)}`,
        `"${family}.prototype.${member}" argument ${index} carries "${representationKey(argument.representation)}", ` +
          `and this backend states no conversion of it into the collection's own "${representationKey(slot)}"`
      )
    }
    return converted
  })
  if (member === 'set') {
    // `gea::mapSet` returns `Ref<Map<K, V>>`, which is the ordinary carrier
    // but cannot be downcast to the identity-bearing recursive wrapper. The
    // JavaScript result is the original receiver, so mutate that one wrapper
    // and return the same `Ref<wrapper>` directly.
    if (carrier.recursive) {
      if (!result || representationKey(result.representation) !== representationKey(carrier)) {
        throw createCppEmitBlockedError(
          `host-invocation:${family}.prototype.set`,
          `recursive ${family}.prototype.set publishes "${result ? representationKey(result.representation) : 'nothing'}", not its receiver carrier`
        )
      }
      return `([&]() -> ${cppTypeOf(result.representation)} { ${receiverText}->set(${argumentTexts.join(', ')}); return ${receiverText}; }())`
    }
    const helper = family === 'weak-map' ? 'gea::weakMapSet' : 'gea::mapSet'
    return `${helper}(${receiverText}, ${argumentTexts.join(', ')})`
  }
  if (member === 'add') {
    if (carrier.recursive) {
      if (!result || representationKey(result.representation) !== representationKey(carrier)) {
        throw createCppEmitBlockedError(
          `host-invocation:${family}.prototype.add`,
          `recursive ${family}.prototype.add publishes "${result ? representationKey(result.representation) : 'nothing'}", not its receiver carrier`
        )
      }
      return `([&]() -> ${cppTypeOf(result.representation)} { ${receiverText}->add(${argumentTexts[0]}); return ${receiverText}; }())`
    }
    const helper = family === 'weak-set' ? 'gea::weakSetAdd' : 'gea::setAdd'
    return `${helper}(${receiverText}, ${argumentTexts[0]})`
  }
  if (member === 'entries') {
    if (family !== 'map' || result?.representation.kind !== 'iterator') {
      throw createCppEmitBlockedError(
        `host-invocation:${family}.prototype.entries`,
        `"${family}.prototype.entries" publishes "${result ? representationKey(result.representation) : 'nothing'}"; ` +
          'Map entries require the iterator carrier that names their concrete pair element'
      )
    }
    return `gea::Iterator<${cppTypeOf(result.representation.element)}>(${receiverText})`
  }
  // `keys` and `values` -- ECMA-262 24.1.3.8 / 24.1.3.11 -- yield ONE HALF of
  // each entry, so unlike `entries` there is no pair to mint: the element is
  // the collection's own `K` or `V`, which the carrier already names. The
  // runtime's generic cursor constructor takes the per-step read as a closure
  // (the same one its Map-entry constructor is built on), so this re-reads the
  // map's CURRENT entry list every step, exactly as `entries` does and as the
  // specification requires -- a `delete` mid-iteration is observed live.
  if (member === 'keys' || member === 'values') {
    if (result?.representation.kind !== 'iterator') {
      throw createCppEmitBlockedError(
        `host-invocation:${family}.prototype.${member}`,
        `"${family}.prototype.${member}" publishes "${result ? representationKey(result.representation) : 'nothing'}"; ` +
          'a keyed collection cursor requires the iterator carrier that names its element'
      )
    }
    const element = cppTypeOf(result.representation.element)
    // A Set's `keys` IS its `values` (24.2.3.8): one storage, and the element
    // is the collection's key either way.
    if (family === 'set') return `gea::Iterator<${element}>(${receiverText})`
    const half = member === 'keys' ? 'first' : 'second'
    return (
      `gea::Iterator<${element}>([gea_collection = ${receiverText}](std::size_t gea_position, ${element}& gea_out) -> bool { ` +
      `const auto& gea_entries = gea_collection->entries(); ` +
      `if (gea_position >= gea_entries.size()) return false; ` +
      `gea_out = gea_entries[gea_position].${half}; return true; })`
    )
  }
  // `delete` is a C++ keyword; `remove` is the member the runtime spells for
  // ECMA-262's `delete`, and this is the single place the rename happens.
  const spelling = member === 'delete' ? 'remove' : member
  const invocation = `${receiverText}->${spelling}(${argumentTexts.join(', ')})`
  if (member === 'get' && carrier.value && result && result.representation.kind !== 'void') {
    // The runtime returns Optional<V> in the collection's storage order.
    // The call site's union can have a different order or a narrowed payload.
    const source: Representation = { kind: 'optional', payload: carrier.value, absence: 'undefined' }
    const converted = alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:collection-get', source, result.representation, invocation)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(source)}->${representationKey(result.representation)}`,
        `"${family}.prototype.get" has no conversion from its collection storage result to the published call result`
      )
    }
    return converted
  }
  return invocation
}

/** The keys `scalarMemberText` may defer off a number receiver -- one authority for "is this method implemented", as above. */
export const numberPrototypeMethods: ReadonlySet<string> = new Set(numberMethods.keys())

/**
 * `Object.prototype` methods reached through a `dictionary` receiver.
 *
 * A `{ [name: string]: V }` index signature covers every string key, so
 * `headers.hasOwnProperty(k)` LOOKS like a table read of the key
 * `"hasOwnProperty"`. It is not: the checker resolves that name against
 * `Object.prototype` and publishes the method's own signature -- a
 * `CallableObject<bool(PropertyKey)>` -- while the table would hand back a
 * `V`. Emitting the read is how a certified program produced
 * `CallableObject<...> = std::string`, so the access defers here instead and
 * the whole thing renders at the call, the same shape every other prototype
 * family uses.
 *
 * Only the members whose meaning survives the carrier are listed.
 * `hasOwnProperty` is exactly `has` on the table -- the own half, no prototype
 * chain, which is all a `std::map` has. `toString`/`valueOf`/`isPrototypeOf`
 * ask about an object identity a `dictionary` does not carry, so they stay
 * unclaimed and refuse at the read rather than compiling to something else.
 */
export const dictionaryPrototypeMethods: ReadonlySet<string> = new Set(['hasOwnProperty'])

/**
 * The call text for a deferred `Object.prototype` read off a dictionary.
 *
 * The argument is a `PropertyKey` in the ambient declaration and the table is
 * keyed by one domain of it; `keyedTableKeyText` is the same reconciliation
 * every other use of the table goes through, so a number-keyed table asks the
 * key the identical question here that a subscript would.
 */
const dictionaryCallText = (
  ctx: EmitContext,
  member: string,
  receiverText: string,
  table: { readonly accessor: string; readonly key: 'string' | 'number' | 'symbol' },
  args: readonly IrOperand[]
): string => {
  if (member !== 'hasOwnProperty') {
    throw createCppEmitBlockedError(
      `host-invocation:Object.prototype.${member}`,
      `"${member}" was recorded as a deferred Object.prototype read off a dictionary but this file renders no call for it`
    )
  }
  const key = args[0]
  if (key === undefined) {
    throw createCppEmitBlockedError('call-abi:hasOwnProperty', '"Object.prototype.hasOwnProperty" was called with no key')
  }
  return `${receiverText}${table.accessor}has(${keyedTableKeyText(ctx, key, dictionaryKeyDomainOf(table.key, key.representation))})`
}

/**
 * The call text for a deferred String/Array prototype-method read, or `null`
 * when the callee is not one -- the ordinary invoke paths run unchanged.
 */
export const prototypeMethodCallText = (ctx: EmitContext, operation: CallOperation): string | NativeScalarCall | null => {
  const read = ctx.prototypeMethodReads.get(operation.callee.value)
  if (!read) return null
  // Spelled here, not at the access that recorded the read: the record names
  // the receiver's operand (`PrototypeMethodReceiver`) and this is the call
  // that fuses with it.
  return renderPrototypeMethodCall(ctx, read, prototypeMethodReceiverText(ctx, read.receiver), operation)
}

/**
 * One deferred read, spelled against one receiver TEXT.
 *
 * Split from the entry point above so a union arm can be rendered as itself:
 * `mixed-union` below hands each arm its own recorded read and its own
 * `get<N>()` spelling, and the arm then renders through exactly the same
 * ladder a lone receiver of that carrier would -- rather than through a second
 * copy of it, which is the shape this file exists to avoid.
 */
const renderPrototypeMethodCall = (
  ctx: EmitContext,
  read: PrototypeMethodRead,
  receiverText: string,
  operation: CallOperation
): string | NativeScalarCall | null => {
  if (read.receiverKind === 'bigint') {
    if (read.member === 'valueOf') return receiverText
    const radix = operation.arguments[0]
    return radix === undefined || radix.representation.kind === 'undefined'
      ? `(${receiverText}).toString()`
      : `gea::host::BigIntConstructor::toStringRadix(${receiverText}, ${operandText(ctx, radix)})`
  }
  if (read.receiverKind === 'string') {
    const render = stringMethods.get(read.member)
    if (!render) {
      throw createCppEmitBlockedError(
        `host-invocation:String.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred String.prototype read but this file renders no call for it`
      )
    }
    return render(ctx, receiverText, operation.arguments, operation.result, ctx.stringMetadataNames.get(operation.callee.value))
  }
  if (read.receiverKind === 'number') {
    const render = numberMethods.get(read.member)
    if (!render) {
      throw createCppEmitBlockedError(
        `host-invocation:Number.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred Number.prototype read but this file renders no call for it`
      )
    }
    return render(ctx, receiverText, operation.arguments)
  }
  if (read.receiverKind === 'promise') {
    const render = promiseMethods.get(read.member)
    if (!render) {
      throw createCppEmitBlockedError(
        `host-invocation:Promise.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred Promise.prototype read but this file renders no call for it`
      )
    }
    return render(ctx, receiverText, operation.arguments, operation.result, read.promiseCarrier)
  }
  if (read.receiverKind === 'iterator') {
    return iteratorCallText(ctx, read.member, receiverText, read.iteratorCarrier, operation)
  }
  if (read.receiverKind === 'date') {
    // The whole table is `emit-prototype-date.ts`'s, the same way the String
    // and Array families own theirs; this file only routes.
    return dateCallText(ctx, read.member, receiverText, operation)
  }
  if (read.receiverKind === 'regexp') {
    return regexpMethodCallText(ctx, read.member, receiverText, operation.arguments, operation.result)
  }
  if (read.receiverKind === 'dictionary') {
    if (read.dictionaryTable === undefined) {
      throw createCppEmitBlockedError(
        `host-invocation:Object.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred dictionary read with no table spelling`
      )
    }
    return dictionaryCallText(ctx, read.member, receiverText, read.dictionaryTable, operation.arguments)
  }
  if (read.receiverKind === 'object-shape') {
    if (read.objectShapeFields === undefined || read.objectShapeAccessor === undefined) {
      throw createCppEmitBlockedError(
        `host-invocation:object-shape.${read.member}`,
        `"${read.member}" was recorded as a deferred object-shape read with no field list`
      )
    }
    return objectShapeCallText(ctx, read.member, receiverText, read.objectShapeAccessor, read.objectShapeFields, operation.arguments)
  }
  if (read.receiverKind === 'native-handle-shape') {
    if (read.intrinsicProtocol === undefined) {
      throw createCppEmitBlockedError(
        `host-invocation:native-handle-shape.${read.member}`,
        `"${read.member}" was recorded as a deferred native-handle read with no protocol name`
      )
    }
    return nativeHandleShapeCallText(ctx, read.member, read.intrinsicProtocol, operation.arguments)
  }
  if (read.receiverKind === 'callable-shape') {
    return callableShapeCallText(ctx, read.member, receiverText, operation.arguments)
  }
  if (read.receiverKind === 'dynamic-object') {
    return dynamicObjectCallText(ctx, read.member, receiverText, operation.arguments)
  }
  // The ECMA-262 binary family, rendered in `emit-buffers.ts` -- see that
  // file's header for why its members live together rather than with the
  // indexed access each carrier also has.
  if (read.receiverKind === 'data-view') {
    return dataViewCallText(ctx, read.member, receiverText, operation.arguments)
  }
  if (read.receiverKind === 'union-to-string') {
    if (read.receiver.kind !== 'operand') {
      throw createCppEmitBlockedError(
        'property-access:tagged-union:get:false',
        'a union "toString" read was recorded without the union operand its dispatch is built from'
      )
    }
    return unionToStringCallText(ctx, read.receiver.operand.representation, receiverText)
  }
  if (read.receiverKind === 'native-error') {
    return nativeErrorCallText(read.member, receiverText)
  }
  if (read.receiverKind === 'typed-array') {
    if (read.receiverElement === null) {
      throw createCppEmitBlockedError(
        `host-invocation:TypedArray.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred %TypedArray%.prototype read with no element spelling`
      )
    }
    return typedArrayCallText(ctx, read.member, receiverText, read.receiverElement, operation.arguments)
  }
  if (read.receiverKind === 'typed-array-union') {
    const carrier = read.typedArrayUnionCarrier
    if (!carrier || !carrier.arms.every((arm) => arm.value.kind === 'typed-array')) {
      throw createCppEmitBlockedError(
        `host-invocation:TypedArray.prototype.${read.member}`,
        `"${read.member}" was recorded as a typed-array union read without a typed-array-only carrier`
      )
    }
    const branches = carrier.arms.map((arm, index) => {
      if (arm.value.kind !== 'typed-array') {
        throw createCppEmitBlockedError(
          `host-invocation:TypedArray.prototype.${read.member}`,
          `"${read.member}" reached a non-typed-array arm after typed-array-union admission`
        )
      }
      const receiver = `${receiverText}.get<${index}>()`
      const invocation = typedArrayCallText(ctx, read.member, receiver, typedArrayElementSpelling(arm.value), operation.arguments)
      if (operation.result === null || operation.result.representation.kind === 'void') return invocation
      const source: Representation = read.member === 'set' ? { kind: 'undefined' } : arm.value
      const converted = alignedValueText(ctx, 'prototype/emit-prototype-invoke.ts:682', source, operation.result.representation, invocation)
      if (converted === null) {
        throw createCppEmitBlockedError(
          `conversion:${representationKey(source)}->${representationKey(operation.result.representation)}`,
          `a typed-array union arm's "${read.member}" result carries "${representationKey(source)}" while the call publishes ` +
            `"${representationKey(operation.result.representation)}", and no installed conversion reconciles them`
        )
      }
      return converted
    })
    return branches.reduceRight<string>(
      (rest, branch, index) => (index === branches.length - 1 ? branch : `${receiverText}.is<${index}>() ? ${branch} : (${rest})`),
      ''
    )
  }
  if (read.receiverKind === 'mixed-union') {
    const carrier = read.mixedUnionCarrier
    const arms = read.mixedUnionArms
    if (!carrier || !arms || arms.length !== carrier.arms.length) {
      throw createCppEmitBlockedError(
        `host-invocation:union.${read.member}`,
        `"${read.member}" was recorded as a mixed-union call without a per-arm answer for every arm`
      )
    }
    const resultType = operation.result === null ? 'void' : cppTypeOf(operation.result.representation)
    // A DISCARDED result and an absent arm together are the one combination
    // whose branches cannot agree on a type by themselves. The absent arm's
    // `throwAbsentUnionMember<void>` is `void` -- there is no result cell for
    // it to be instantiated at -- while a live arm still evaluates to whatever
    // its own method returns, and `Array.prototype.push` returns a number even
    // when nobody reads it. C++'s conditional operator has no common type for
    // `void` and `double`, so the whole statement was refused for a program
    // that is perfectly well formed: hono's `_getQueryParam` writes
    // `;(results[name] as string[]).push(value)` over a `string | string[]`,
    // where the `as` names the arm the author means and the string arm is
    // proved to have no `push`.
    //
    // Discarding both sides explicitly is what the statement already means --
    // 13.3.6.1 throws on the absent arm and 23.1.3.20 returns a length nobody
    // reads on the live one -- and it is applied only when an arm really is
    // absent, so a union whose arms all answer keeps the text it had.
    const discardedWithAbsentArm = operation.result === null && arms.some((armRead) => armRead === null)
    const branches = arms.map((armRead, index) => {
      const armCarrier = carrier.arms[index]?.value
      if (armRead === null) {
        // The arm the claim proved holds no callable of this name. 6.2.5.5
        // answers `undefined` for the read and 13.3.6.1 throws on the call --
        // one step later, and only if this arm is the live one.
        return (
          `gea::host::throwAbsentUnionMember<${resultType}>(${cppStringLiteral(read.member)}, ` +
          `${cppStringLiteral(armCarrier ? representationKey(armCarrier) : 'arm')})`
        )
      }
      const text = renderPrototypeMethodCall(ctx, armRead, `${receiverText}.get<${index}>()`, operation)
      if (typeof text !== 'string') {
        throw createCppEmitBlockedError(
          `host-invocation:union.${read.member}`,
          `a mixed-union arm's "${read.member}" renders as a native scalar call, which has no per-arm spelling here`
        )
      }
      return discardedWithAbsentArm ? `(void)(${text})` : text
    })
    return branches.reduceRight<string>(
      (rest, branch, index) => (index === branches.length - 1 ? branch : `${receiverText}.is<${index}>() ? ${branch} : (${rest})`),
      ''
    )
  }
  if (read.receiverKind === 'array-buffer') {
    // ECMA-262 25.1.5.3 `ArrayBuffer.prototype.slice`: a fresh block holding a
    // COPY of the selected bytes, sharing nothing with the source. The
    // relative-index fold is the runtime's own -- the same one every ranged
    // method here uses -- and an omitted `end` is the buffer's own size, which
    // only this call site can supply.
    if (read.member !== 'slice') {
      throw createCppEmitBlockedError(
        `host-invocation:ArrayBuffer.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred ArrayBuffer.prototype read but this file renders no call for it`
      )
    }
    const start = operation.arguments[0] === undefined ? '0.0' : operandText(ctx, operation.arguments[0] as IrOperand)
    const end =
      operation.arguments[1] === undefined
        ? `static_cast<double>(${receiverText}->size())`
        : operandText(ctx, operation.arguments[1] as IrOperand)
    return `gea::detail::arrayBufferSlice(${receiverText}, ${start}, ${end})`
  }
  if (read.receiverKind === 'keyed-collection') {
    if (!read.collectionFamily) {
      throw createCppEmitBlockedError(
        `host-invocation:KeyedCollection.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred keyed-collection read with no family, and the four families' spellings differ`
      )
    }
    if (!keyedCollectionPrototypeMethods(read.collectionFamily).has(read.member)) {
      throw createCppEmitBlockedError(
        `host-invocation:${read.collectionFamily}.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred ${read.collectionFamily} read but this file renders no call for it`
      )
    }
    if (!read.collectionCarrier) {
      throw createCppEmitBlockedError(
        `host-invocation:${read.collectionFamily}.prototype.${read.member}`,
        `"${read.member}" was recorded as a deferred keyed-collection read with no carrier, and its arguments cannot be converted into slots this call cannot see`
      )
    }
    return keyedCollectionCallText(ctx, read.collectionCarrier, read.member, receiverText, operation.arguments, operation.result)
  }
  const render = arrayMethods.get(read.member)
  if (!render) {
    throw createCppEmitBlockedError(
      `host-invocation:Array.prototype.${read.member}`,
      `"${read.member}" was recorded as a deferred Array.prototype read but this backend renders no call for it`
    )
  }
  // Every Array renderer needs the receiver's own ELEMENT carrier, not just
  // its `representationKey`: `join` and the comparator-less `sort` ask whether
  // the runtime can ToString it, `concat` asks whether the packed rest spreads
  // or appends, and `find`/`at`/`pop`/`shift` compare it against the call's own
  // optional result. `receiverElement` (a key string) answers only the last
  // kind of question, so the carrier travels with the read -- the identical
  // reason `collectionCarrier` does, stated at its own field.
  if (!read.arrayCarrier) {
    throw createCppEmitBlockedError(
      `host-invocation:Array.prototype.${read.member}`,
      `"${read.member}" was recorded as a deferred Array.prototype read with no receiver carrier, and its element carrier cannot be recovered at a call ` +
        'that no longer has the receiver'
    )
  }
  return render(ctx, receiverText, read.arrayCarrier.element, operation.arguments, operation.result)
}
