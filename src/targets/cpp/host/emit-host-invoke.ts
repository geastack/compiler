import type { CallableAbi, Representation } from '../../../representation/model.js'
import type { StructuralTypeId } from '../../../identity/ids.js'
import { representationKey } from '../../../representation/model.js'
import { hostMemberTemplateOf, isArrayConstantOf } from '../../../representation/host-templates.js'
import type { CallOperation, IrOperand } from '../../../ir/model.js'
import { createCppEmitBlockedError, internSymbolKey, operandText, paddedArguments, type EmitContext } from '../emit-context.js'
import { consoleArgumentsText, toStringRefusal, toStringText } from '../emit-tostring.js'
import { toNumberRefusal, toNumberText } from '../emit-tonumber.js'
import { booleanTestText } from '../emit-presence.js'
import { hostArgumentText, hostMemberReceiverText } from './emit-host-arity.js'
import { fillHostTemplate, hostMemberOf } from './host-members.js'
import {
  cppConstantLiteral,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppTypeOf
} from '../types.js'
import { awaitedText } from '../prototype/emit-prototype-promise.js'
import { jsonCallText } from '../emit-json.js'
import { dateConstructorCallText } from '../prototype/emit-prototype-date.js'
import { isStringObjectCarrier } from '../prototype/emit-prototype-regexp.js'
import { cppStringObjectNativeType } from '../regexp-types.js'
import { errorConstructorNames, isNativeError } from '../error-types.js'
import { objectMemberText } from './emit-host-object.js'
import { armAt, armIs } from '../emit-union-properties.js'
import { memberAccessOperator } from '../emit-carrier-members.js'
import { recordFieldsOfShape } from '../records.js'
import { typedArrayTargetSpelling } from '../emit-buffers.js'
import { alignedValueText } from '../emit-narrowing.js'
import { thrownValueCarrier } from '../../../ir/lower-exceptions.js'
import { atomicsCallSupport } from './atomics.js'

/**
 * `[[Call]]`/`[[Construct]]` on a `native-handle` receiver -- the invoke path
 * `emitCall`/`emitConstruct` (emit.ts) take when a callee is the host handle
 * itself, never a member of one (`nativeHandleMemberText`, emit-properties.ts,
 * is the sibling for `Math.pow`-shaped reads; this is for `new Error(x)`).
 *
 * A qualified free-function symbol, `gea::host::<protocol>::<member>(...)`,
 * called directly with an explicit template argument -- the same convention
 * `gea::jsx::create<Node>(tag)` already uses, for the same reason: a C++
 * function pointer stored inside `gea_runtime.h` cannot name a program's own
 * generated struct (`gea_record_type|N`), because that struct is declared
 * *after* this header is included. A free function template sidesteps that
 * entirely -- it is instantiated at the call site, where the struct name is
 * already in scope.
 *
 * This table is deliberately small: it is the backend's honest inventory of
 * which host protocols have a *real* `gea::host` implementation behind them,
 * keyed by the protocol string the checker bound (`nativeHandleMemberText`
 * keys its own dispatch the identical way) -- never a guess, and never
 * silently widened to a protocol this file has not implemented.
 */
/**
 * One protocol's own invocation renderer.
 *
 * A single shared shape was enough while `ErrorConstructor` was the only entry,
 * and it stopped being enough the moment a second protocol arrived that is not
 * that shape: `String(x)` takes one argument of *any* carrier and returns a
 * `std::string`, `new Error(m)` takes an optional string and returns a pointer
 * to a program-generated struct. Those are not one convention with a parameter
 * -- they are different conventions -- so each states and checks its own
 * requirements here and refuses by name when a call does not meet them.
 */
type HostInvocationRenderer = (context: HostInvocationRequest) => string

interface HostInvocationRequest {
  readonly ctx: EmitContext
  readonly protocol: string
  readonly abi: CallableAbi
  readonly args: readonly IrOperand[]
  readonly role: 'call' | 'construct'
  /**
   * The carrier this invocation's result is HELD as, where the graph published
   * one -- which is not always what `abi.result` says.
   *
   * `abi` is the declaration's convention; this is the value this call site
   * actually produces. The two differ for exactly the shape
   * `errorConstructResultOverride` (semantics/normalize/producers/invocations.ts)
   * licenses: `new RangeError(m) as RangeError & { code: string }` is declared
   * to return the plain error interface and holds the intersection's record.
   * `create<ErrorRecord>` is a template over the struct, so it can mint either
   * -- and the one to mint is the one the program holds.
   */
  readonly result: Representation | null
}

/**
 * Unwraps one leading `optional<string>` (or bare `string`) parameter, or
 * `null` when the convention is not that shape.
 */
const leadingStringParameter = (abi: CallableAbi): Representation | null => {
  const first = abi.parameters[0]?.value
  if (first === undefined) return null
  const unwrapped = first.kind === 'optional' ? first.payload : first
  return unwrapped.kind === 'string' ? unwrapped : null
}

/**
 * `new Error(m)` / `Error(m)`.
 *
 * Only the ABI's own leading message parameter is ever read. A further
 * parameter (`ErrorConstructor`'s `options: ErrorOptions`) is part of the
 * checker's real overload set -- `widestSubsumingAbi` (host-abi.ts) admits it
 * honestly, it is not invented here -- but this implementation does not act on
 * it, and says so rather than pretending to. Dropping it from the emitted
 * call is still sound: an argument the source actually passed was already
 * lowered to its own IR operation before this one runs, so its evaluation (a
 * side effect included) already happened and was already emitted; only
 * *referencing* that operand's value in this call's own text is what is
 * skipped.
 *
 * `[[Call]]` and `[[Construct]]` both produce a fresh `Error` -- ECMA-262's own
 * rule -- so one renderer serves both roles.
 */
/** The local an `Error` construction with a `cause` is bound to while the cause is installed on it. */
const errorCauseTargetName = 'gea_error_with_cause'

/**
 * `new Error(message, { cause })` -- the cause read, with the guard that says
 * whether the options bag actually carries one, or `null` when this is not an
 * options carrier a definite `cause` can be read out of.
 *
 * The same shape `emitSuperInitialize` already reads for `super(m, { cause })`
 * inside a `class X extends Error`, because it is the same installation: a
 * record's absent field is a value beside a PRESENCE FLAG, not an
 * `Optional<T>`, and `ErrorOptions` declares `cause?: unknown`, so every
 * ordinary spelling arrives with the flag. Preserving it matters because
 * ECMA-262 20.5.8.1 installs the own property only when the bag has one, and
 * an error whose `cause` is `undefined` is a different object from one with no
 * `cause` at all -- which `gea::runtime::Error::gea_readOwnField` answers from
 * its own flag.
 */
const errorCauseInstall = (ctx: EmitContext, options: IrOperand): { guard: string | null; text: string } | null => {
  const carrier = options.representation
  const optionsText = operandText(ctx, options)
  const outerGuard = carrier.kind === 'optional' ? `${optionsText}.has_value()` : null
  const payload = carrier.kind === 'optional' ? carrier.payload : carrier
  const payloadText = carrier.kind === 'optional' ? `(*${optionsText})` : optionsText
  if (payload.kind !== 'record' && payload.kind !== 'record-with-index' && payload.kind !== 'native-record-ref') return null
  const fields =
    payload.kind === 'native-record-ref'
      ? payload.native === null
        ? recordFieldsOfShape(ctx.deriver, payload.shapeId)
        : null
      : payload.fields
  const cause = fields?.find((field) => field.key === 'cause')
  if (cause === undefined || cause.value.kind !== 'dynamic') return null
  const access = memberAccessOperator(payload.ownership)
  const guards = [outerGuard, cause.required ? null : `${payloadText}${access}${cppRecordFieldPresenceName('cause')}`].filter(
    (guard): guard is string => guard !== null
  )
  return { guard: guards.length > 0 ? guards.join(' && ') : null, text: `${payloadText}${access}${cppRecordFieldName('cause')}` }
}

const renderErrorCreate = ({ ctx, protocol, abi, args, role, result }: HostInvocationRequest): string => {
  // The struct this construction MINTS is the one the program holds, not the
  // one the declaration names: `create<ErrorRecord>` is a template, and an
  // `as`-asserted construction publishes a wider record than
  // `ErrorConstructor`'s own return type (see `HostInvocationRequest.result`).
  // The declaration's carrier is the fallback for a call whose graph published
  // no result at all -- `new Error(m)` as a bare statement.
  const minted = result ?? abi.result
  if (isNativeError(minted)) {
    const name = errorConstructorNames.get(protocol)
    if (name === undefined)
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `no intrinsic error constructor is registered for ${protocol}`
      )
    const message = args[0]
    const text = message === undefined ? 'gea::Optional<std::string>{}' : operandText(ctx, message)
    const created = `gea::host::createRuntimeError("${name}", ${text})`
    const options = args[1]
    if (options === undefined || options.representation.kind === 'undefined') return created
    const install = errorCauseInstall(ctx, options)
    if (install === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `Error options carried as "${representationKey(options.representation)}" need a presence-preserving cause property read`
      )
    }
    // An immediately invoked lambda because the construction is an expression
    // and the installation is a statement -- the guard cannot be folded into a
    // conditional operator without evaluating `createRuntimeError` twice.
    const statement = `${install.guard === null ? '' : `if (${install.guard}) `}${errorCauseTargetName}->setCause(${install.text});`
    return `([&]() { auto ${errorCauseTargetName} = ${created}; ${statement} return ${errorCauseTargetName}; }())`
  }
  // Two carrier kinds spell one C++ type here. `native-record-ref` names a
  // shape the deriver registered; `record` carries the fields inline -- which
  // is what an `as RangeError & { code: string }` intersection derives, since
  // its members are stated at the assertion rather than by a declared
  // interface. Both are `gea::Ref<gea_record_type_N>` when the record is
  // counted, which is the only ownership `create` can produce: it returns a
  // `gea::Ref`, so a by-value record would be a different type entirely.
  if ((minted.kind !== 'native-record-ref' && minted.kind !== 'record') || minted.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" ${role} result carries a "${representationKey(minted)}" carrier, but this implementation only mints a counted record`
    )
  }
  if (abi.receiver !== null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" ${role} convention declares a receiver, which this implementation does not carry`
    )
  }
  if (leadingStringParameter(abi) === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" ${role} convention's leading parameter is not an optional string message, which is the only shape this implementation was built for`
    )
  }
  const message = args[0]
  if (!message) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" ${role} with no message argument -- the ABI's own leading parameter was not projected`
    )
  }
  // A free function template, not a stored function pointer: a pointer inside
  // `gea_runtime.h` cannot name a program's own generated struct, which is
  // declared after that header is included. Instantiating at the call site,
  // where the struct name is already in scope, sidesteps it entirely -- the
  // same convention `gea::jsx::create<Node>(tag)` uses.
  return `gea::host::${protocol}::create<${cppRecordStructName(minted.shapeId)}>(${operandText(ctx, message)})`
}

/**
 * `String(x)` -- ECMAScript `ToString` called as a function.
 *
 * The convention this dispatches on is the ARGUMENT's carrier, not the
 * declared parameter's. `lib.es5.d.ts` types `String(value?: any)`, so the ABI
 * derived from the declaration says `(optional(dynamic)) -> string` for every
 * call -- which describes what the *declaration* permits, not what this call
 * passes. `String(count)` where `count` is a `number` passes a `double`, and
 * rendering it as a boxed dynamic would manufacture the very box the argument
 * does not have. The declaration bounds what is legal; the operand says what
 * is actually there, and the second is what has an implementation.
 */
const renderToString = ({ ctx, protocol, abi, args, role, result }: HostInvocationRequest): string => {
  if (role === 'construct') {
    // `new String(x)` mints the WRAPPER OBJECT (ECMA-262 22.1.5), never the
    // primitive `role === 'call'` below produces -- so `result` (the carrier
    // this call site actually holds, per `HostInvocationRequest`'s own
    // comment) must be the String-object native-record-ref, not `abi.result`
    // (`StringConstructor`'s declared `new (value?: any): String`, which
    // resolves the same way but is not what a graph publishing no result at
    // all would leave this checking against).
    const minted = result ?? abi.result
    if (!isStringObjectCarrier(minted)) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}`,
        `a "${protocol}" construct result carries "${representationKey(minted)}", not the String-object carrier`
      )
    }
    const argument = args[0]
    // `new String()` with no argument wraps the empty string -- ECMA-262
    // 22.1.5.1 step 2's `ToString(value)` of an absent `value` is `undefined`,
    // which ToStrings to `"undefined"`... except step 1 special-cases zero
    // arguments to `s = ""` directly, never reaching ToString at all.
    const stringified = argument
      ? toStringText(operandText(ctx, argument), argument.representation, ctx.classes, ctx.deriver)
      : cppConstantLiteral('', 'string', { kind: 'string' })
    if (stringified === null)
      throw createCppEmitBlockedError(`host-invocation:${protocol}`, toStringRefusal(argument!.representation, ctx.classes, ctx.deriver))
    return `gea::makeRef<${cppStringObjectNativeType}>(${stringified})`
  }
  if (abi.result.kind !== 'string') {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" call result carries "${abi.result.kind}", not a string`
    )
  }
  const argument = args[0]
  // `String()` with no argument is the empty string, which is a constant and
  // needs no conversion at all.
  if (!argument) return cppConstantLiteral('', 'string', { kind: 'string' })
  const carrier = argument.representation
  const converted = toStringText(operandText(ctx, argument), carrier, ctx.classes, ctx.deriver, true)
  if (converted === null)
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      toStringRefusal(carrier, ctx.classes, ctx.deriver)
    )
  return converted
}

/**
 * `Number(x)` -- ECMAScript `ToNumber` called as a function.
 *
 * Dispatches on the argument's carrier for the same reason `renderToString`
 * does: `lib.es5.d.ts` declares `Number(value?: any)`, so the derived
 * convention says `(optional(dynamic)) -> number` at every call site and
 * describes the declaration rather than the call.
 *
 * `Number()` with no argument is `0`, not `NaN` -- the empty-argument case is
 * its own rule in the specification, and it is not the same as
 * `Number(undefined)`.
 */
const renderToNumber = ({ ctx, protocol, abi, args, role }: HostInvocationRequest): string => {
  if (role !== 'call') {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}`,
      `"new ${protocol}" constructs a Number *object* -- a wrapper with identity, distinct from the primitive ` +
        'ToNumber produces -- and no Number object carrier is implemented'
    )
  }
  if (!(abi.result.kind === 'scalar' && abi.result.domain === 'number')) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" call result carries "${representationKey(abi.result)}", not a number`
    )
  }
  const argument = args[0]
  if (!argument) return cppConstantLiteral('0', 'number', { kind: 'scalar', domain: 'number' })
  const carrier = argument.representation
  // Number() explicitly permits BigInt-to-Number; ordinary ToNumber does not.
  if (carrier.kind === 'scalar' && carrier.domain === 'bigint') return `(${operandText(ctx, argument)}).toNumber()`
  // One table, `emit-tonumber.ts`, for every carrier -- including the two this
  // used to refuse outright. An `optional` states which absence it carries and
  // a `tagged-union` states its arms, so both convert by dispatching on what
  // the carrier already knows rather than by boxing the value to ask it at run
  // time.
  const converted = toNumberText(operandText(ctx, argument), carrier)
  if (converted === null)
    throw createCppEmitBlockedError(`host-invocation:${protocol}${role === 'call' ? '.call' : ''}`, toNumberRefusal(carrier))
  return converted
}

const renderBigInt = ({ ctx, args, role }: HostInvocationRequest): string => {
  if (role !== 'call') throw createCppEmitBlockedError('host-invocation:BigIntConstructor', 'BigInt is callable but is not a constructor')
  const argument = args[0]
  if (!argument)
    throw createCppEmitBlockedError(`host-invocation:BigIntConstructor${role === 'call' ? '.call' : ''}`, 'BigInt requires an argument')
  const carrier = argument.representation
  const text = operandText(ctx, argument)
  if (carrier.kind === 'scalar') {
    const input = carrier.domain === 'bigint' ? text : `static_cast<${carrier.domain === 'boolean' ? 'bool' : 'double'}>(${text})`
    return `gea::host::BigIntConstructor::create(${input})`
  }
  if (carrier.kind === 'string') return `gea::host::BigIntConstructor::create(std::string(${text}))`
  if (carrier.kind === 'dynamic') return `gea::host::BigIntConstructor::create(${text})`
  throw createCppEmitBlockedError(
    `host-invocation:BigIntConstructor${role === 'call' ? '.call' : ''}`,
    `BigInt conversion from ${representationKey(carrier)} is not implemented`
  )
}

/**
 * `Boolean(x)` / `Boolean()` -- ECMA-262 20.3.1.1, which is `ToBoolean` and
 * nothing else.
 *
 * `booleanTestText` (emit-presence.ts) already IS `ToBoolean` for every carrier
 * this backend has: it is what `if (x)` renders through, arm by arm for a
 * tagged union, and by presence-and-payload for an optional. So the `Boolean`
 * handle's own call has a real implementation the moment it is routed here --
 * no new runtime half, and no separate truthiness rule that could disagree with
 * the one every conditional already uses.
 *
 * `new Boolean(x)` is refused for the same reason `new Number(x)` is: it
 * constructs a wrapper OBJECT with identity, which is a different value from
 * the primitive and has no carrier here.
 */
const renderToBoolean = ({ ctx, protocol, abi, args, role }: HostInvocationRequest): string => {
  if (role !== 'call') {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}`,
      `"new ${protocol}" constructs a Boolean *object* -- a wrapper with identity, distinct from the primitive ` +
        'ToBoolean produces -- and no Boolean object carrier is implemented'
    )
  }
  if (!(abi.result.kind === 'scalar' && abi.result.domain === 'boolean')) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" call result carries "${representationKey(abi.result)}", not a boolean`
    )
  }
  // `Boolean()` with no argument is `ToBoolean(undefined)`, which is `false`.
  const argument = args[0]
  if (!argument) return cppConstantLiteral('false', 'boolean', { kind: 'scalar', domain: 'boolean' })
  return booleanTestText(operandText(ctx, argument), argument.representation)
}

/**
 * `Promise.resolve(x)` / `Promise.resolve()` -- ECMA-262 27.2.4.7.
 *
 * A `member` renderer rather than a `hostInvocations` one: the handle invoked
 * here is `Promise`'s *member*, not the `Promise` handle itself (that would be
 * `new Promise(executor)`, which nothing implements). `hostCallText` routes to
 * it on the table's own `arity: 'call-site'` marking, because no fixed
 * template can spell this call: the promise it mints is `gea::Promise<T>` with
 * `T` the payload the checker gave THIS call, which is routinely a
 * program-generated struct.
 *
 * The result's own carrier is the authority for `T`, never the argument's, and
 * the difference is the whole of the spec subtlety. 27.2.4.7 step 2 returns an
 * argument that is already a promise UNCHANGED instead of wrapping it, and the
 * checker states the same rule in the type system: `resolve<T>(value: T)`
 * returns `Promise<Awaited<T>>`, and `Awaited<T>` is `T` exactly when `T` is
 * not a thenable. So "the argument's carrier is the result promise's payload"
 * is not a convenience check -- it IS the proof that this call site is the
 * non-thenable arm, taken from the checker's own answer rather than from a
 * structural guess about what does or does not have a `then`. When the two
 * disagree, `Awaited` unwrapped something, and that is the arm this refuses.
 *
 * `gea::Promise<V>` copies share one PromiseState, so returning the operand
 * preserves the fulfillment/rejection identity required by step 2.
 */
/**
 * `Promise.all` -- ECMA-262 27.2.4.1.
 *
 * The runtime states the loop; this states what `PromiseResolve` is for ONE
 * element, which is a per-carrier question the runtime cannot ask: a promise
 * arm reads its settled value, a non-thenable is already its own resolution,
 * and a union of both is a discriminant test away from either.
 * `awaitedText` (prototype/emit-prototype-promise.ts) is that one rule, shared
 * with `await`, and it is handed over as a lambda rather than restated here.
 *
 * An argument that is not an Array refuses by name. The specification takes any
 * iterable, and every other iterable this backend carries has its own protocol
 * -- reaching the Array overload with one would be a wrong answer.
 */
const promiseAllText = (ctx: EmitContext, operation: CallOperation): string => {
  const argument = operation.arguments[0]
  if (!argument)
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.all',
      'a "PromiseConstructor.all" with no argument has nothing to resolve'
    )
  const elements = argument.representation
  if (elements.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.all',
      `"PromiseConstructor.all" over a "${representationKey(elements)}" argument is not rendered: 27.2.4.1 iterates any ` +
        'iterable, and only an Array has a stated iteration here'
    )
  }
  const resolved = awaitedText(ctx, 'host/emit-host-invoke.ts:promiseAllText', elements.element, 'gea_element')
  const body = resolved ?? 'gea_element'
  return (
    `gea::host::PromiseConstructor::all(${operandText(ctx, argument)}, ` +
    `[](const ${cppTypeOf(elements.element)}& gea_element) { return ${body}; })`
  )
}

/**
 * `Promise.race` -- 27.2.4.5. The runtime states the loop and the first-settle
 * rule (see its own doc); this states how ONE element is registered on the
 * result, which is the per-carrier half only the emitter can answer.
 *
 * The difference from `all` just above is the whole reason this is a separate
 * renderer rather than another `awaitedText` caller: `all` READS each element's
 * settled value, and a race must not read an element at all -- reading an
 * unsettled promise waits for it, which is exactly the block
 * `@hono/node-server`'s `readWithoutBlocking` uses a race to avoid. So a
 * promise element is ADOPTED and a non-thenable element resolves the result
 * outright.
 *
 * `adopt` is used only when the payloads are the same C++ type, because that is
 * what `gea::Promise<V>::adopt` takes. A promise of a DIFFERENT payload is
 * registered through `observe`, whose fulfillment handler converts the settled
 * value into the result's own carrier first -- the conversion is
 * `alignedValueText`, the same one every other cross-carrier store goes
 * through, so a race cannot invent a widening nothing else performs.
 */
const promiseRaceElementText = (ctx: EmitContext, element: Representation, value: Representation): string | null => {
  const valueType = cppResultTypeOf(value)
  if (element.kind === 'promise') {
    if (cppResultTypeOf(element.value) === valueType) return 'gea_result.adopt(gea_element);'
    const settledType = cppTypeOf(element.value)
    const converted = alignedValueText(ctx, 'host/emit-host-invoke.ts:promiseRaceElementText', element.value, value, 'gea_settled')
    if (converted === null) return null
    return (
      `gea_element.observe([gea_result](const ${settledType}& gea_settled) mutable { gea_result.resolve(${converted}); }, ` +
      '[gea_result](std::exception_ptr gea_reason) mutable { gea_result.reject(gea_reason); });'
    )
  }
  // A non-thenable IS its own resolution (27.2.4.7.1 `PromiseResolve`), so it
  // settles the race the moment it is reached.
  const converted = alignedValueText(ctx, 'host/emit-host-invoke.ts:promiseRaceElementText', element, value, 'gea_element')
  return converted === null ? null : `gea_result.resolve(${converted});`
}

/**
 * The same race over a TUPLE argument, which is what `Promise.race([a, b])`
 * carries whenever the two elements do not share one carrier -- and they
 * routinely do not: `@hono/node-server` races a `Promise<Buffer>` against a
 * `Promise<undefined>`, so the literal is a two-field struct, not an Array.
 *
 * No runtime loop, because there is nothing to loop over: a tuple's arity is a
 * compile-time fact and each position has its OWN carrier, so each gets its own
 * registration. That is not a shortcut around the Array path -- it is the only
 * correct rendering, since one `Adopt` lambda cannot be written for two
 * different element types.
 *
 * Registration order is the tuple's own order, which is the iteration order
 * 27.2.4.5 walks its argument in, so "first settled wins" resolves the same way
 * it does for the Array form.
 */
const promiseRaceTupleText = (
  ctx: EmitContext,
  argument: IrOperand,
  tuple: Extract<Representation, { kind: 'record' }>,
  value: Representation
): string | null => {
  const accessor = memberAccessOperator(tuple.ownership)
  const resultType = cppResultTypeOf(value)
  const steps: string[] = []
  for (const [position, field] of tuple.fields.entries()) {
    if (field.key !== String(position) || !field.required) return null
    const body = promiseRaceElementText(ctx, field.value, value)
    if (body === null) return null
    steps.push(`{ const ${cppTypeOf(field.value)}& gea_element = gea_source${accessor}${cppRecordFieldName(field.key)}; ${body} }`)
  }
  if (steps.length === 0) return null
  return (
    `[&]() -> gea::Promise<${resultType}> { const auto& gea_source = ${operandText(ctx, argument)}; ` +
    `gea::Promise<${resultType}> gea_result; ${steps.join(' ')} return gea_result; }()`
  )
}

const promiseRaceText = (ctx: EmitContext, operation: CallOperation): string => {
  const argument = operation.arguments[0]
  const result = operation.result?.representation
  if (!argument || result?.kind !== 'promise') {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.race',
      'a "PromiseConstructor.race" needs one iterable argument and a promise result carrier'
    )
  }
  const elements = argument.representation
  if (elements.kind === 'record') {
    const tupleText = promiseRaceTupleText(ctx, argument, elements, result.value)
    if (tupleText !== null) return tupleText
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.race',
      `"PromiseConstructor.race" cannot settle a "${representationKey(result.value)}" result from the tuple ` +
        `"${representationKey(elements)}"`
    )
  }
  if (elements.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.race',
      `"PromiseConstructor.race" over a "${representationKey(elements)}" argument is not rendered: 27.2.4.5 iterates any ` +
        'iterable, and only an Array has a stated iteration here'
    )
  }
  const body = promiseRaceElementText(ctx, elements.element, result.value)
  if (body === null) {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.race',
      `"PromiseConstructor.race" cannot settle a "${representationKey(result.value)}" result from a ` +
        `"${representationKey(elements.element)}" element`
    )
  }
  return (
    `gea::host::PromiseConstructor::race<${cppResultTypeOf(result.value)}>(${operandText(ctx, argument)}, ` +
    `[](gea::Promise<${cppResultTypeOf(result.value)}>& gea_result, const ${cppTypeOf(elements.element)}& gea_element) { ${body} })`
  )
}

const promiseConstructorText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  if (member === 'all') return promiseAllText(ctx, operation)
  if (member === 'race') return promiseRaceText(ctx, operation)
  if (member === 'reject') {
    const result = operation.result?.representation
    const reason = operation.arguments[0]
    if (result?.kind !== 'promise' || reason === undefined) {
      throw createCppEmitBlockedError(
        'host-member-call:PromiseConstructor.reject',
        'Promise.reject requires one rejection reason and a promise result carrier'
      )
    }
    const carried = alignedValueText(
      ctx,
      'host/emit-host-invoke.ts:371',
      reason.representation,
      thrownValueCarrier,
      operandText(ctx, reason)
    )
    if (carried === null) {
      throw createCppEmitBlockedError(
        'host-member-call:PromiseConstructor.reject',
        `Promise.reject reason "${representationKey(reason.representation)}" cannot enter the thrown-value carrier`
      )
    }
    // `cppResultTypeOf`, not `cppTypeOf`: a promise PAYLOAD is the one
    // position where a bare `void` is the right spelling, which is exactly
    // why `types.ts`'s own `promise` case renders `gea::Promise<...>` through
    // that function. `Promise.reject()` at a `Promise<void>` result is
    // ordinary -- `stream.ts`'s `destroy` path has one -- and asking
    // `cppTypeOf` here crashed emission with "void is not a value carrier and
    // has no physical C++ type" AFTER the program had already certified.
    // `PromiseConstructor::reject<void>` instantiates: it only ever names
    // `gea::Promise<V>::rejected_with`, which carries no fulfilment value.
    return `gea::host::PromiseConstructor::reject<${cppResultTypeOf(result.value)}>(${carried})`
  }
  if (member !== 'resolve') {
    throw createCppEmitBlockedError(
      `host-member-call:PromiseConstructor.${member}`,
      `"PromiseConstructor.${member}" has no rendering; only "resolve", "reject", and "all" are claimed, and an unclaimed member is ` +
        'refused at its access before this'
    )
  }
  // No result means no payload carrier, and the payload is the only place the
  // `Awaited<T>` answer above can be read from. Deriving `T` from the argument
  // instead would silently wrap a thenable that the spec says to adopt, so a
  // discarded `Promise.resolve(x)` refuses here rather than guessing.
  if (!operation.result) {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.resolve',
      'a "PromiseConstructor.resolve" whose value is discarded publishes no result carrier, and the promise payload is ' +
        'the only evidence that the argument is not itself a thenable'
    )
  }
  const result = operation.result.representation
  if (result.kind !== 'promise') {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.resolve',
      `a "PromiseConstructor.resolve" result carries "${representationKey(result)}", not a promise`
    )
  }
  const payload = result.value
  const argument = operation.arguments[0]
  if (operation.arguments.length === 0) {
    // `Promise.resolve()` -- `value` absent, fulfilling with `undefined`,
    // which this backend elides for `void` everywhere else and elides here
    // too rather than standing an `Undefined` payload in for it.
    if (payload.kind !== 'void') {
      throw createCppEmitBlockedError(
        'host-member-call:PromiseConstructor.resolve',
        `a "PromiseConstructor.resolve" passing no argument must fulfil with undefined, but this call's result payload ` +
          `carries "${representationKey(payload)}"`
      )
    }
    return 'gea::host::PromiseConstructor::resolve()'
  }
  if (operation.arguments.length !== 1 || !argument) {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.resolve',
      `"PromiseConstructor.resolve" takes one argument or none; this call passes ${operation.arguments.length}`
    )
  }
  const carrier = argument.representation
  if (carrier.kind === 'promise') {
    if (representationKey(carrier.value) !== representationKey(payload)) {
      throw createCppEmitBlockedError(
        'host-member-call:PromiseConstructor.resolve',
        `a "PromiseConstructor.resolve" promise argument carries payload "${representationKey(carrier.value)}" but the result ` +
          `carries "${representationKey(payload)}"`
      )
    }
    return operandText(ctx, argument)
  }
  // 27.2.4.7 over a value that is EITHER answer. `Promise.resolve(x)` on an
  // `x: T | Promise<T>` is where the checker's `Awaited<T>` collapses the two
  // arms into one payload, and the specification's own rule is a per-value
  // test rather than a type-level one: step 2 RETURNS a promise whose
  // constructor is this one, step 3 wraps anything else. This carrier already
  // keeps that test as its discriminant, so each arm renders the answer the
  // spec gives IT -- the thenable arm adopted by identity, the value arm
  // wrapped -- instead of one of the two answers standing in for both.
  //
  // hono's `resolveCallback` is the shape: two `instanceof` tests above the
  // `return Promise.resolve(str)` leave `str` carried as `string |
  // Promise<string>` while TypeScript types the result `Promise<string>`.
  if (carrier.kind === 'tagged-union') {
    const source = 'gea_promise_resolve_source'
    const minted = `gea::host::PromiseConstructor::resolve<${cppResultTypeOf(payload)}>`
    const arms = carrier.arms.map((arm, index) => {
      const value = arm.value
      // A `dynamic` arm is refused for the reason the whole-carrier case below
      // states, and every other disagreement with the payload is the same
      // missing conversion a bare argument would be refused for.
      if (value.kind === 'promise' && representationKey(value.value) === representationKey(payload)) return armAt(source, index)
      if (value.kind !== 'dynamic' && representationKey(value) === representationKey(payload)) return `${minted}(${armAt(source, index)})`
      return null
    })
    const dispatched = arms.every((arm): arm is string => arm !== null)
      ? arms.reduceRight<string | null>(
          (rest, text, index) => (rest === null ? text : `${armIs(source, index)} ? ${text} : (${rest})`),
          null
        )
      : null
    if (dispatched !== null) {
      return `([&]() -> ${cppTypeOf(result)} { const auto& ${source} = ${operandText(ctx, argument)}; ` + `return ${dispatched}; }())`
    }
  }
  // A boxed argument the program asserted to the payload type
  // (`Promise.resolve(request[key] as Buffer)`): read out of the box with the
  // exact-type check, which refuses by name a thenable -- or anything else --
  // the assertion did not describe.
  if (carrier.kind === 'dynamic' && payload.kind !== 'dynamic') {
    const unboxed = alignedValueText(ctx, 'promise-resolve-argument', carrier, payload, operandText(ctx, argument))
    if (unboxed !== null) return `gea::host::PromiseConstructor::resolve<${cppResultTypeOf(payload)}>(${unboxed})`
  }
  if (representationKey(carrier) !== representationKey(payload)) {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.resolve',
      `a "PromiseConstructor.resolve" argument carries "${representationKey(carrier)}" but the promise it mints has ` +
        `payload "${representationKey(payload)}"; the checker's own Awaited<T> unwrapped a thenable, whose adoption is not implemented`
    )
  }
  // The one place the equality above proves nothing: `Awaited<any>` is `any`,
  // so a `dynamic` argument passes it vacuously while the value it carries may
  // still BE a thenable at runtime, which 27.2.4.7 adopts rather than wraps.
  // Non-thenability is what this whole renderer rests on and a declaration of
  // `any` is precisely the program refusing to state it, so this refuses too
  // rather than wrapping on the strength of a check that did not run.
  if (carrier.kind === 'dynamic') {
    throw createCppEmitBlockedError(
      'host-member-call:PromiseConstructor.resolve',
      'a "PromiseConstructor.resolve" argument carried as dynamic states no type to prove it is not a thenable, and ' +
        'Awaited<any> is any, so the payload carries no evidence either'
    )
  }
  // An explicit template argument, never deduction: the argument's C++ text is
  // an expression whose type is the carrier's, and naming the payload outright
  // is what makes the emitted call readable as the carrier the plan selected.
  return `gea::host::PromiseConstructor::resolve<${cppResultTypeOf(payload)}>(${operandText(ctx, argument)})`
}

/**
 * `Symbol()` / `Symbol(description)` -- ECMA-262 20.4.1.1.
 *
 * A fresh symbol every call, by definition, so there is nothing to intern and
 * nothing static: `gea::makeSymbol` mints one. `[[Construct]]` is not a thing
 * `Symbol` has -- `new Symbol()` is a TypeError, and `SymbolConstructor` states
 * no construct signature -- so a construction refuses by name rather than
 * silently rendering the call form.
 *
 * The description parameter is `string | number | undefined`. A string passes
 * through; a number is ToString'd, which is what the spec does (20.4.1.1 step 2
 * calls ToString on a non-undefined description). Every other carrier refuses,
 * including an optional one: `Symbol(undefined)` has description `undefined`,
 * NOT the string `"undefined"`, and a carrier that cannot tell absence from a
 * value cannot pick between those two answers.
 */
const renderSymbolCall = ({ ctx, args, role }: HostInvocationRequest): string => {
  if (role === 'construct') {
    throw createCppEmitBlockedError('host-invocation:SymbolConstructor', '"Symbol" is not a constructor; `new Symbol()` throws a TypeError')
  }
  const description = args[0]
  if (description === undefined) return 'gea::makeSymbol()'
  const carrier = description.representation
  if (carrier.kind !== 'string' && !(carrier.kind === 'scalar' && carrier.domain !== 'bigint')) {
    throw createCppEmitBlockedError(
      'host-invocation:SymbolConstructor.call',
      `a "Symbol" description carried as "${representationKey(carrier)}" cannot be converted without deciding whether an ` +
        'absent description is `undefined` or the string "undefined"'
    )
  }
  const text = toStringText(operandText(ctx, description), carrier, ctx.classes, ctx.deriver)
  if (text === null)
    throw createCppEmitBlockedError('host-invocation:SymbolConstructor.call', toStringRefusal(carrier, ctx.classes, ctx.deriver))
  return `gea::makeSymbol(${text})`
}

/**
 * `Symbol.for(key)` -- ECMA-262 20.4.2.2.
 *
 * A literal key does not render as a call at all. It is interned into this
 * unit's own table (`internSymbolKey`) and the access becomes a reference to
 * one namespace-scope `inline const gea::Symbol`, so the registry probe happens
 * once per unit rather than once per use -- v1's `__geawebsym_*` answer to the
 * same question, and the reason this member is marked `call-site` in
 * `hostMembers` instead of carrying a fixed template.
 *
 * `ctx.constantTexts` is the only legal source for that literal: it holds each
 * `constant` operation's own text, so a key that came from anywhere else --
 * a variable, a concatenation, a parameter -- is simply absent from it and
 * renders as the runtime `gea::symbolFor` call instead. Both spellings produce
 * the same symbol; only the number of registry probes differs.
 */
const symbolMemberText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  if (member !== 'for') {
    throw createCppEmitBlockedError(
      `host-member-call:SymbolConstructor.${member}`,
      `"SymbolConstructor.${member}" has no call-site spelling; only "for" is stated here, and "keyFor" renders through ` +
        'its own fixed template'
    )
  }
  const key = operation.arguments[0]
  if (key === undefined) {
    throw createCppEmitBlockedError('host-member-call:SymbolConstructor.for', '"Symbol.for" takes a key, and this call passes none')
  }
  if (key.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      'host-member-call:SymbolConstructor.for',
      `a "Symbol.for" key carried as "${representationKey(key.representation)}" is not a string, and the registry is keyed ` +
        'by the ToString of the key -- which this backend does not run for a non-string'
    )
  }
  const literal = ctx.constantTexts.get(key.value)
  if (literal !== undefined) return internSymbolKey(ctx.symbolKeys, literal)
  return `gea::symbolFor(${operandText(ctx, key)})`
}

const renderPromiseCreate = ({ ctx, args, role, result }: HostInvocationRequest): string => {
  if (role !== 'construct') {
    throw createCppEmitBlockedError(
      `host-invocation:PromiseConstructor${role === 'call' ? '.call' : ''}`,
      'Promise has no [[Call]] operation; it must be constructed with new'
    )
  }
  if (args.length !== 1 || args[0] === undefined) {
    throw createCppEmitBlockedError(
      'host-invocation:PromiseConstructor',
      `new Promise requires one executor; this construction passes ${args.length}`
    )
  }
  if (result?.kind !== 'promise') {
    throw createCppEmitBlockedError(
      'host-invocation:PromiseConstructor',
      `new Promise publishes "${result === null ? 'nothing' : representationKey(result)}" instead of a promise carrier`
    )
  }
  const helper = result.value.kind === 'void' ? 'constructVoid' : `construct<${cppTypeOf(result.value)}>`
  return `gea::host::PromiseConstructor::${helper}(${operandText(ctx, args[0])})`
}

/**
 * The renderer for each protocol whose *handle itself* is invoked.
 *
 * Deliberately small: it is the backend's honest inventory of which host
 * protocols have a real `gea::host` implementation behind an invocation, keyed
 * by the protocol string the checker bound (`nativeHandleMemberText`, in
 * emit-properties.ts, keys its own member dispatch the identical way). Never a
 * guess, and never silently widened to a protocol this file has not written.
 *
 * Exported so `host/native-protocols.ts` can read the key set as one of the
 * tables a native-boundary claim is derived from, rather than restating this
 * inventory as a fourth, hand-typed copy: this map IS the emitter's dispatch,
 * not a description of it, so its keys are proof a protocol here is real.
 */
export const hostInvocations: ReadonlyMap<string, HostInvocationRenderer> = new Map([
  ['PromiseConstructor', renderPromiseCreate],
  ['ErrorConstructor', renderErrorCreate],
  // The six NativeError constructors, which 20.5.6.1.1 defines as 20.5.1.1
  // with a different `name` -- one renderer, because the difference is inside
  // `gea::host::<protocol>::create`, which this already spells from the
  // protocol string it was handed.
  ['EvalErrorConstructor', renderErrorCreate],
  ['RangeErrorConstructor', renderErrorCreate],
  ['ReferenceErrorConstructor', renderErrorCreate],
  ['SyntaxErrorConstructor', renderErrorCreate],
  ['TypeErrorConstructor', renderErrorCreate],
  ['URIErrorConstructor', renderErrorCreate],
  ['StringConstructor', renderToString],
  ['NumberConstructor', renderToNumber],
  ['BigIntConstructor', renderBigInt],
  ['BooleanConstructor', renderToBoolean],
  ['SymbolConstructor', renderSymbolCall]
])

/**
 * The renderer for each protocol whose *member* call is spelled at the call
 * site -- the sibling of `hostInvocations` for the member half.
 *
 * Two maps rather than one because they answer about two different things: a
 * protocol may have an invocable handle, a call-site-spelled member, or both,
 * and `PromiseConstructor` is the case that makes the difference concrete --
 * `Promise.resolve(x)` is implemented, `new Promise(executor)` is not, and one
 * map keyed by protocol could not say so.
 *
 * Exported for the same reason `hostInvocations` is: `host/native-protocols.ts`
 * reads its keys as another table a native-boundary claim is derived from.
 */
/**
 * `Array.isArray(v)` -- ECMA-262 23.1.2.2, answered from the ARGUMENT'S
 * CARRIER.
 *
 * The predicate is decidable at compile time for every carrier that is not the
 * dynamic box, and the runtime already states both ends of that: `isArray(const
 * Value&)` reads the box's own tag, and `isArray(const Ref<ArrayObject<E>>&)`
 * returns `true` without reading anything. What was missing is everything
 * between -- and in particular a TAGGED UNION, where the answer is exactly the
 * discriminant: hono asks `Array.isArray( init.headers )` with
 * `HeadersInit`-shaped carrier `Dictionary | ArrayObject`, and the union has
 * no `isArray` overload, so the call reached C++ as a hard error.
 *
 * `false` is stated by KIND rather than as a default, so a carrier nobody has
 * thought about refuses instead of being answered wrongly. A typed array is
 * one of the `false`s on purpose: 23.1.2.2 asks whether the value is an Array
 * EXOTIC OBJECT, and a `Uint8Array` is not one -- `Array.isArray(new
 * Uint8Array())` is `false` in the language.
 *
 * An `optional` answers per state: an absent value is `undefined`, which is
 * not an array.
 */
const isArrayText = (ctx: EmitContext, operation: CallOperation): string => {
  const argument = operation.arguments[0]
  if (argument === undefined) {
    throw createCppEmitBlockedError('host-member-call:ArrayConstructor.isArray', '"Array.isArray" takes a value, and this call passes none')
  }
  const answer = (representation: Representation, text: string): string => {
    if (representation.kind === 'dynamic') return `gea::host::ArrayConstructor::isArray(${text})`
    // The one carrier whose KIND is not its answer. A closed tuple is laid
    // out as a record (`derive.ts`: "there is deliberately no tuple carrier"),
    // and `record` is in the kind table's `false` set because an object
    // literal is not an Array exotic object -- but a tuple's value IS one.
    // See `RepresentationDeriver.isTupleShape`.
    if (representation.kind === 'record' && ctx.deriver.isTupleShape(representation.shapeId as StructuralTypeId)) return 'true'
    // Answered by kind wherever the kind alone answers -- the one table the
    // IR's frame for this call reads too (`representation/host-templates.ts`).
    const constant = isArrayConstantOf(representation.kind)
    if (constant !== null) return constant ? 'true' : 'false'
    if (representation.kind === 'optional') {
      const payload = answer(representation.payload, `(*${text})`)
      return payload === 'false' ? 'false' : `(${text}.has_value() ? ${payload} : false)`
    }
    if (representation.kind === 'tagged-union') {
      // The discriminant IS the answer. Built right to left, and collapsed
      // whenever every arm agrees -- a union of two arrays is `true` with no
      // test at all, and one of two non-arrays is `false`.
      const arms = representation.arms.map((arm, index) => answer(arm.value, armAt(text, index)))
      const first = arms[0]
      if (first !== undefined && arms.every((arm) => arm === first)) return first
      const dispatched = arms.reduceRight<string | null>(
        (rest, arm, index) => (rest === null ? arm : `${armIs(text, index)} ? ${arm} : (${rest})`),
        null
      )
      if (dispatched === null) return 'false'
      return `(${dispatched})`
    }
    throw createCppEmitBlockedError(
      'host-member-call:ArrayConstructor.isArray',
      `"Array.isArray" of a "${representationKey(representation)}" carrier is not answered here: 23.1.2.2 asks whether the ` +
        'value is an Array exotic object, and this carrier states neither that it is nor that it cannot be'
    )
  }
  return answer(argument.representation, operandText(ctx, argument))
}

/** The statically named `length` field of an ArrayLike record. */
const arrayLikeLengthText = (ctx: EmitContext, source: IrOperand): string => {
  const carrier = source.representation
  if (carrier.kind !== 'record' && carrier.kind !== 'record-with-index' && carrier.kind !== 'native-record-ref') {
    throw createCppEmitBlockedError(
      'host-member-call:ArrayConstructor.from',
      `Array.from expected a static ArrayLike record and received "${representationKey(carrier)}"`
    )
  }
  const fields =
    carrier.kind === 'native-record-ref' && carrier.native === null
      ? recordFieldsOfShape(ctx.deriver, carrier.shapeId)
      : carrier.kind === 'native-record-ref'
        ? null
        : carrier.fields
  const length = fields?.find((field) => field.key === 'length')
  if (!length || length.value.kind !== 'scalar' || length.value.domain !== 'number') {
    throw createCppEmitBlockedError(
      'host-member-call:ArrayConstructor.from',
      `Array.from received an ArrayLike carrier "${representationKey(carrier)}" whose statically known length is not a number`
    )
  }
  return `${operandText(ctx, source)}${memberAccessOperator(carrier.ownership)}${cppRecordFieldName('length')}`
}

/** `Array.from(source[, mapfn])`, over the four source carriers the runtime can iterate without a dynamic `@@iterator` lookup. */
const arrayFromText = (ctx: EmitContext, operation: CallOperation): string => {
  const source = operation.arguments[0]
  if (!source)
    throw createCppEmitBlockedError('host-member-call:ArrayConstructor.from', '"Array.from" takes a source and this call passes none')
  if (operation.arguments.length > 2) {
    throw createCppEmitBlockedError(
      'host-member-call:ArrayConstructor.from',
      '"Array.from" with a thisArg needs a callback receiver binding this runtime does not carry'
    )
  }
  const result = operation.result?.representation
  if (!result || result.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      'host-member-call:ArrayConstructor.from',
      `"Array.from" result carries "${result ? representationKey(result) : 'nothing'}", not an array-object`
    )
  }
  const callback = operation.arguments[1]
  const args = [operandText(ctx, source), ...(callback ? [operandText(ctx, callback)] : [])].join(', ')
  const carrier = source.representation
  if (carrier.kind === 'array-object') return `gea::runtime::array::fromArray(${args})`
  if (carrier.kind === 'iterator') return `gea::runtime::array::fromIterator(${args})`
  if (carrier.kind === 'typed-array') return `gea::runtime::array::fromTypedArray(${args})`
  if (carrier.kind === 'string') return `gea::runtime::array::fromString(${args})`
  if (carrier.kind === 'record' || carrier.kind === 'record-with-index' || carrier.kind === 'native-record-ref') {
    if (!callback) {
      throw createCppEmitBlockedError(
        'host-member-call:ArrayConstructor.from',
        '"Array.from" of a length-only ArrayLike needs a mapper to produce each element'
      )
    }
    return `gea::runtime::array::fromLength(${arrayLikeLengthText(ctx, source)}, ${operandText(ctx, callback)})`
  }
  throw createCppEmitBlockedError(
    'host-member-call:ArrayConstructor.from',
    `"Array.from" of a "${representationKey(carrier)}" source needs an iterable protocol this backend does not lower`
  )
}

/** `%TypedArray%.from(source[, mapfn])`, retaining the concrete result element type from the call's own carrier. */
const typedArrayFromText = (ctx: EmitContext, operation: CallOperation): string => {
  const source = operation.arguments[0]
  if (!source)
    throw createCppEmitBlockedError(
      'host-member-call:TypedArrayConstructor.from',
      '"TypedArray.from" takes a source and this call passes none'
    )
  if (operation.arguments.length > 2) {
    throw createCppEmitBlockedError(
      'host-member-call:TypedArrayConstructor.from',
      '"TypedArray.from" with a thisArg needs a callback receiver binding this runtime does not carry'
    )
  }
  const result = operation.result?.representation
  if (!result || result.kind !== 'typed-array') {
    throw createCppEmitBlockedError(
      'host-member-call:TypedArrayConstructor.from',
      `"TypedArray.from" result carries "${result ? representationKey(result) : 'nothing'}", not a typed-array`
    )
  }
  const target = typedArrayTargetSpelling(result)
  const callback = operation.arguments[1]
  const args = [operandText(ctx, source), ...(callback ? [operandText(ctx, callback)] : [])].join(', ')
  const carrier = source.representation
  if (carrier.kind === 'array-object') return `gea::runtime::array::typedArrayFromArray<${target}>(${args})`
  if (carrier.kind === 'typed-array') return `gea::runtime::array::typedArrayFromTypedArray<${target}>(${args})`
  if (carrier.kind === 'string' && callback) return `gea::runtime::array::typedArrayFromString<${target}>(${args})`
  throw createCppEmitBlockedError(
    'host-member-call:TypedArrayConstructor.from',
    `"TypedArray.from" of a "${representationKey(carrier)}" source${callback ? '' : ' without a mapper'} is not implemented`
  )
}

/** `ArrayBuffer.isView` -- true precisely for TypedArray and DataView carriers. */
const isArrayBufferViewText = (ctx: EmitContext, operation: CallOperation): string => {
  const argument = operation.arguments[0]
  if (argument === undefined) {
    throw createCppEmitBlockedError(
      'host-member-call:ArrayBufferConstructor.isView',
      '"ArrayBuffer.isView" takes a value, and this call passes none'
    )
  }
  const answer = (representation: Representation, valueText: string): string => {
    if (representation.kind === 'typed-array' || representation.kind === 'data-view') return 'true'
    if (representation.kind === 'optional') {
      const payload = answer(representation.payload, `(*${valueText})`)
      return payload === 'false' ? 'false' : `(${valueText}.has_value() ? ${payload} : false)`
    }
    if (representation.kind === 'tagged-union') {
      const arms = representation.arms.map((arm, index) => answer(arm.value, armAt(valueText, index)))
      const first = arms[0]
      if (first !== undefined && arms.every((arm) => arm === first)) return first
      const dispatched = arms.reduceRight<string | null>(
        (rest, arm, index) => (rest === null ? arm : `${armIs(valueText, index)} ? ${arm} : (${rest})`),
        null
      )
      return dispatched === null ? 'false' : `(${dispatched})`
    }
    if (representation.kind === 'dynamic') {
      throw createCppEmitBlockedError(
        'host-member-call:ArrayBufferConstructor.isView',
        '"ArrayBuffer.isView" of a dynamic value needs a runtime TypedArray/DataView brand, which gea::Value does not carry'
      )
    }
    return 'false'
  }
  return answer(argument.representation, operandText(ctx, argument))
}

/** The finite, checker-authenticated Atomics surface. No dynamic receiver is admitted. */
const atomicsText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  const args = operation.arguments
  const support = atomicsCallSupport(
    member,
    args.map((argument) => argument.representation)
  )
  if (!support.supported) throw createCppEmitBlockedError(`host-member-call:Atomics.${member}`, support.reason)
  const number = (position: number): string => operandText(ctx, args[position]!)
  if (support.kind === 'is-lock-free') return `gea::runtime::atomics::isLockFree(${number(0)})`
  const view = args[0]!
  const viewText = operandText(ctx, view)
  if (support.kind === 'fixed') {
    return `gea::runtime::atomics::${support.runtimeMember}(${viewText}, ${args
      .slice(1)
      .map((_argument, position) => number(position + 1))
      .join(', ')})`
  }
  if (support.kind === 'wait') {
    return `gea::runtime::atomics::wait(${viewText}, ${number(1)}, ${number(2)}, ${args[3] ? number(3) : 'std::numeric_limits<double>::infinity()'})`
  }
  return `gea::runtime::atomics::notify(${viewText}, ${number(1)}, ${args[2] ? number(2) : 'std::numeric_limits<double>::infinity()'})`
}

export const hostMemberRenderers: ReadonlyMap<string, (ctx: EmitContext, member: string, operation: CallOperation) => string> = new Map([
  ['Atomics', atomicsText],
  ['PromiseConstructor', promiseConstructorText],
  ['SymbolConstructor', symbolMemberText],
  // `Object`'s statics, in their own module: every one of them renders from
  // the RECEIVER's carrier -- a known shape's field list, or a real
  // enumeration of a real own-property table -- which is a different question
  // from the ones the two renderers above answer, and one that runs through
  // all ten claimed members. See `emit-host-object.ts`'s own header.
  ['ObjectConstructor', objectMemberText],
  // `Date.parse`/`Date.UTC`. Their spelling is decided by the call's own
  // argument count (`Date.UTC` takes one to seven), which is exactly what a
  // fixed-arity template row cannot state. `Date.now` is not routed here: it
  // is a `property` row over a real callable.
  ['DateConstructor', dateConstructorCallText],
  // `Array.isArray`, whose whole answer is the argument's carrier -- see
  // `isArrayText`. `ArrayConstructor` has no other claimed member.
  [
    'ArrayConstructor',
    (ctx, member, operation) =>
      hostMemberTemplateOf('ArrayConstructor', member) === 'array-is-array' ? isArrayText(ctx, operation) : arrayFromText(ctx, operation)
  ],
  ['Int8ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Uint8ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Uint8ClampedArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Int16ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Uint16ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Int32ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Uint32ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Float32ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['Float64ArrayConstructor', (ctx, _member, operation) => typedArrayFromText(ctx, operation)],
  ['ArrayBufferConstructor', (ctx, _member, operation) => isArrayBufferViewText(ctx, operation)]
])

/**
 * The call/construct text for a `native-handle` invocation, or a thrown
 * refusal naming exactly what is missing.
 */
export const nativeHandleInvocationText = (
  ctx: EmitContext,
  callee: Extract<Representation, { readonly kind: 'native-handle' }>,
  abi: CallableAbi,
  args: readonly IrOperand[],
  role: 'call' | 'construct',
  result: Representation | null
): string => {
  const { protocol } = callee
  // A host that states the whole `new C(...)` expression renders through it.
  // Consulted before the renderers below, and only for a construction: those
  // are this backend's own protocols, whose spelling depends on the call's
  // static types rather than on the class alone, and a plugin row plus a
  // backend renderer for one protocol would be two authorities over one
  // question. Keyed the way every other host row is -- by the carrier the host
  // stated, falling back to the declared name.
  const stated = role === 'construct' ? ctx.hosts.constructors.get(callee.native ?? protocol) : undefined
  if (stated !== undefined) {
    // A `'pass-through'` row names the single `{args}` slot -- every argument,
    // in order, each as the host takes it -- and has no fixed count to check:
    // which of the host's overloads a call means is decided by C++ from the
    // argument types, exactly the member arm this mirrors (`hostCallText`
    // above). A fixed-number row still gets the strict count check, because its
    // template names exactly that many `{argN}` slots and nothing else can fill
    // the difference.
    if (stated.arity === 'pass-through') {
      const passed = args.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument))).join(', ')
      const filled = fillHostTemplate(stated.emit, null, [], passed)
      if (filled === null) {
        throw createCppEmitBlockedError(
          `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
          `the "${protocol}" host construct template names a slot this construction cannot fill`
        )
      }
      return filled
    }
    // Padded the same way the generic constructor-carrier path is
    // (`paddedArguments`, emit-context.ts): a host's construct template is
    // stated for the checker's full parameter frame, and a call that omits a
    // trailing optional argument (`new MediaRecorder(stream)` against
    // `new (stream, options?)`) is exactly the shape that helper exists for.
    // `stated.arity` still has to match the PADDED count, so a template whose
    // stated arity disagrees with the checker's own frame still refuses by
    // name instead of silently filling the wrong number of slots.
    const argTexts = paddedArguments(
      abi,
      args.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument))),
      role
    )
    if (argTexts.length !== stated.arity) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `constructing "${protocol}" is stated with ${stated.arity} argument slot(s) and this construction passes ` +
          `${argTexts.length}; the host's spelling has nowhere to put the difference`
      )
    }
    // `null` for the receiver on purpose: a construction has none, so a
    // template that names `{receiver}` was written for the wrong position and
    // `fillHostTemplate` refuses it rather than filling it with nothing.
    const filled = fillHostTemplate(stated.emit, null, argTexts)
    if (filled === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `the "${protocol}" host construct template names a slot this construction cannot fill`
      )
    }
    return filled
  }
  const invocation = role === 'call' ? ctx.hosts.invocations.get(`${callee.native ?? protocol}.call`) : undefined
  if (invocation !== undefined) {
    if (invocation.arity === 'pass-through') {
      const passed = args.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument))).join(', ')
      const filled = fillHostTemplate(invocation.emit, null, [], passed)
      if (filled === null)
        throw createCppEmitBlockedError(
          `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
          `the "${protocol}" host invocation template names a slot this call cannot fill`
        )
      return filled
    }
    const argTexts = paddedArguments(
      abi,
      args.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument))),
      role
    )
    if (argTexts.length !== invocation.arity) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `calling "${protocol}" is stated with ${invocation.arity} argument slot(s) and this call passes ${argTexts.length}; the host's spelling has nowhere to put the difference`
      )
    }
    const filled = fillHostTemplate(invocation.emit, null, argTexts)
    if (filled === null)
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
        `the "${protocol}" host invocation template names a slot this call cannot fill`
      )
    return filled
  }
  const render = hostInvocations.get(protocol)
  if (render === undefined) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}${role === 'call' ? '.call' : ''}`,
      `a "${protocol}" host handle has no ${role} implementation; only ${[...hostInvocations.keys()].join(', ')} ` +
        `${hostInvocations.size === 1 ? 'is' : 'are'} wired to real gea::host C++`
    )
  }
  return render({ ctx, protocol, abi, args, role, result })
}

/**
 * A host *method* call -- `document.getElementById(id)`, `el.setAttribute(k, v)`.
 *
 * The access itself rendered nothing (`nativeHandleMemberText`, emit-properties.ts)
 * because a host method is not a value: the host states one spelling for the
 * whole call and none for the method on its own. That access recorded which
 * member was reached and how the receiver renders, and this fills the host's
 * template with both. Returns `null` when the callee is not a deferred host
 * member, so the ordinary invoke paths run unchanged.
 */
export const hostCallText = (ctx: EmitContext, operation: CallOperation): string | null => {
  const numericRest = operation.numericRestHostCall
  if (numericRest !== undefined) {
    const host = hostMemberOf(ctx.hosts.members, numericRest.protocol, numericRest.member)
    const valid = operation.arguments.every(
      (argument) => argument.representation.kind === 'scalar' && argument.representation.domain === 'number'
    )
    const rendered =
      host?.kind === 'property' && host.numericRestCall !== undefined && valid
        ? fillHostTemplate(
            host.numericRestCall,
            '',
            [],
            `{${operation.arguments.map((argument) => `static_cast<double>(${operandText(ctx, argument)})`).join(', ')}}`
          )
        : null
    if (rendered === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${numericRest.protocol}.${numericRest.member}`,
        'a borrowed numeric rest frame has no matching host spelling or numeric operands'
      )
    }
    return rendered
  }
  const callee = operation.callee.representation
  const read = ctx.hostMemberReads.get(operation.callee.value)
  if (!read) {
    // A `native-handle` callee -- `Error(x)`, never `obj.method()` -- invokes
    // through a qualified free function, not through `.call(...)` on its own
    // materialized value: a host singleton's handle carries no function
    // pointer of its own to call through.
    if (callee.kind !== 'native-handle') return null
    if (!callee.call) {
      throw createCppEmitBlockedError(
        `host-invocation:${callee.protocol}.call`,
        `a "${callee.protocol}" host handle carries no [[Call]] convention this program's checker derived for it`
      )
    }
    return nativeHandleInvocationText(ctx, callee, callee.call, operation.arguments, 'call', operation.result?.representation ?? null)
  }
  // Spelled here rather than at the access that recorded the member: the
  // record holds the receiver's operand, and this is the call that fills the
  // host's template with it (`hostMemberReceiverText`). Taken before the row is
  // checked so a receiver that refuses still refuses first, exactly as it did
  // when the access itself spelled it.
  const receiverText = hostMemberReceiverText(ctx, read)
  const host = hostMemberOf(ctx.hosts.members, read.protocol, read.member)
  if (!host || host.kind !== 'method') {
    throw createCppEmitBlockedError(
      `host-invocation:${read.protocol}.${read.member}`,
      `"${read.protocol}.${read.member}" was recorded as a host method but names no method template`
    )
  }
  if (read.protocol === 'JSON') {
    if (read.member !== 'stringify' && read.member !== 'parse') {
      throw createCppEmitBlockedError(
        `host-invocation:JSON.${read.member}`,
        `"JSON.${read.member}" has no rendering; only "stringify" and "parse" are claimed`
      )
    }
    return jsonCallText(ctx, read.member, operation)
  }
  // A member the table itself marks as spelled at the call site, because its
  // C++ depends on this call's static types and not on the member alone. The
  // marking says *that* a renderer decides; which one is this map's answer, so
  // a row marked `call-site` on a protocol nothing here renders refuses by
  // name rather than falling through to an arity check it has no arity for.
  if (host.arity === 'call-site') {
    const render = hostMemberRenderers.get(read.protocol)
    if (render === undefined) {
      throw createCppEmitBlockedError(
        `host-invocation:${read.protocol}.${read.member}`,
        `"${read.protocol}.${read.member}" is claimed with a call-site spelling, but no renderer in this file states one ` +
          `for "${read.protocol}"`
      )
    }
    return render(ctx, read.member, operation)
  }
  // A variadic member (`console.log`/`console.error`) has no fixed arity to
  // check against and no positional `{argN}` slots to fill: every argument's
  // ToString text is joined into ONE value first, and that value fills the
  // template's single `{args}` slot. A carrier with no ToString refuses by
  // name here -- exactly `toStringRefusal`'s own message -- rather than
  // falling back to a boxed carrier. `operation.arguments` is guaranteed to
  // be N individual operands here, never one packed `array-object` -- see
  // `ir/lower.ts`'s `calleeReceiverIsNativeHandle` -- UNLESS
  // `argumentsAreSpread` says otherwise (below).
  if (host.arity === 'variadic') {
    // `console.log(...values)`: `ir/lower-invocation.ts` passed the whole
    // array through as this call's one argument rather than range-copying
    // it, so the `{args}` slot fills with the array's OWN text -- C++
    // overload resolution then picks `gea_runtime.h`'s
    // `console::log(const Ref<ArrayObject<Value>>&)` over the
    // `std::string`/`std::vector<Value>` overloads the plain per-operand join
    // below fills instead, the same "let overload resolution decide" posture
    // this file's own `pass-through` arity already takes.
    if (operation.argumentsAreSpread) {
      const [whole] = operation.arguments
      if (whole === undefined) {
        throw createCppEmitBlockedError(
          `host-member-call:${read.protocol}.${read.member}`,
          `"${read.protocol}.${read.member}" was recorded as a spread call with no argument to spread`
        )
      }
      const filled = fillHostTemplate(host.emit, receiverText, [], operandText(ctx, whole))
      if (filled === null) {
        throw createCppEmitBlockedError(
          `host-invocation:${read.protocol}.${read.member}`,
          `the "${read.protocol}.${read.member}" host template names a slot this call cannot fill`
        )
      }
      return filled
    }
    const joined = consoleArgumentsText(ctx, operation.arguments)
    if ('refused' in joined) {
      throw createCppEmitBlockedError(
        `host-member-call:${read.protocol}.${read.member}`,
        `"${read.protocol}.${read.member}" cannot stringify an argument: ${toStringRefusal(joined.refused, ctx.classes, ctx.deriver)}`
      )
    }
    const filled = fillHostTemplate(host.emit, receiverText, [], joined.text)
    if (filled === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${read.protocol}.${read.member}`,
        `the "${read.protocol}.${read.member}" host template names a slot this call cannot fill`
      )
    }
    return filled
  }
  // Every argument, in order, each as the host takes it -- and no arity check,
  // because the row states none: which of the host's overloads this call means
  // is decided by C++ from the argument types, not by counting them here.
  if (host.arity === 'pass-through') {
    const passed = operation.arguments.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument))).join(', ')
    const rendered = fillHostTemplate(host.emit, receiverText, [], passed)
    if (rendered === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${read.protocol}.${read.member}`,
        `the "${read.protocol}.${read.member}" host template names a slot this call cannot fill`
      )
    }
    return rendered
  }
  if (operation.arguments.length !== host.arity) {
    throw createCppEmitBlockedError(
      `host-member-call:${read.protocol}.${read.member}`,
      `"${read.protocol}.${read.member}" is spelled for ${host.arity} argument(s); this call passes ${operation.arguments.length}`
    )
  }
  const filled = fillHostTemplate(
    host.emit,
    receiverText,
    // Each argument as the HOST takes it, not as the program holds it -- the
    // same crossing a free host function's arguments make (`hostArgumentText`).
    // A member is not a different boundary: `setVertexBytesLengthAtIndex`
    // declares `std::vector<double>` exactly as a free thunk would, and the
    // program's array is an `ArrayObject` either way.
    operation.arguments.map((argument) => hostArgumentText(argument.representation, operandText(ctx, argument)))
  )
  if (filled === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${read.protocol}.${read.member}`,
      `the "${read.protocol}.${read.member}" host template names a slot this call cannot fill`
    )
  }
  return filled
}
