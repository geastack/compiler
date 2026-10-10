import { representationKey, type Representation } from '../../../representation/model.js'
import { awaitedRepresentation, holdsThenable } from '../../../representation/promise-resolution.js'
export { awaitedRepresentation } from '../../../representation/promise-resolution.js'
import { type ConversionSite, alignedValueText } from '../emit-narrowing.js'
import { cppConstantLiteral, cppTypeOf } from '../types.js'
import { nativePromiseBaseOf } from '../class-ref-transport.js'
import { createCppEmitBlockedError } from '../emit-context.js'

/**
 * Resolving a value the way `await` and `Promise.all` both do.
 *
 * ECMA-262 27.2.4.7.1 `PromiseResolve` is the one operation behind both: a
 * thenable is adopted, and anything else resolves to ITSELF. `Awaited<T>` is
 * TypeScript's name for the same fact, which is why `await 1` is `1`.
 *
 * This is the BLOCKING rendering -- adoption as a read of the settled value,
 * `.awaited()` -- and its one remaining caller is a module body's top-level
 * `await`, which runs at the bottom of the program's own stack. Every `await`
 * inside a function suspends instead: `coroutineAwaitStatements` below renders
 * the same four shapes as `co_await`.
 *
 * The case this exists for is the THIRD one, which neither half of that
 * sentence covers on its own: a union of both. `string | Promise<string>` is
 * what every `Promise.all` argument and every conditionally-async helper is
 * made of (an HTML-escaping template helper is exactly that), and it is neither "a
 * promise" nor "not a promise" -- it is a discriminant test away from either.
 * `emitAwait` used to ask only `kind === 'promise'` and pass such a union
 * through untouched, handing a `TaggedUnion<...>` to a consumer that had been
 * told it would get the payload.
 *
 * `null` for a carrier with nothing to resolve, which is the caller's signal
 * that the value is already its own resolution and needs no text at all.
 *
 * `ctx`/`site` are the conversion census's site: the optional shape below
 * stores an absence into the result cell, and every cross-carrier store goes
 * through `alignedValueText` so the census is asked and printer drift is
 * recorded -- calling the recipe printer's renderer directly would answer the
 * spelling without recording that the question was put (the architecture
 * gate counts exactly that).
 */
export const awaitedText = (
  ctx: ConversionSite,
  site: string,
  carrier: Representation,
  text: string,
  target: Representation | null = null
): string | null => {
  if (carrier.kind === 'promise') {
    // A `Promise<void>` settles to `undefined`, and `awaited()` on it returns
    // nothing: a cell that holds the answer gets the `undefined` the language
    // resolves to, after the read rethrows a rejection.
    if (carrier.value.kind === 'void' && target !== null && target.kind !== 'void')
      return alignedValueText(ctx, site, undefinedCarrier, target, voidAwaitedText(text)) ?? `${text}.awaited()`
    return `${text}.awaited()`
  }
  // An instance of a class extending `Promise` IS a thenable: it resolves by
  // the promise its struct derives from (`nativePromiseBaseOf`). Passing it
  // through as its own resolution would hand the instance to a cell told it
  // holds the fulfillment value.
  const nativePromise = nativePromiseAwaitedText(carrier, text)
  if (nativePromise !== null) return nativePromise
  // A box may hold a promise (a cache returning one as `any`), and
  // `await` adopts it; the awaited value of an `any` is itself `any`.
  if (carrier.kind === 'dynamic' && (target === null || target.kind === 'dynamic' || target.kind === 'void'))
    return `gea::detail::awaitedDynamic(${text})`
  if (carrier.kind === 'optional') return awaitedOptionalText(ctx, site, carrier, text, target)
  if (carrier.kind !== 'tagged-union') return null
  if (!carrier.arms.some((arm) => arm.value.kind === 'promise' || isNativePromiseClass(arm.value))) return null
  // Every arm is accounted for, not just the promise ones: an arm that is not
  // a thenable resolves to itself, so it contributes its own payload. The last
  // arm is the fall-through and is never tested, because the union holds one
  // of its arms by construction and a test with no `else` has nothing to
  // answer -- the same shape `taggedUnionArmText` (emit-narrowing.ts) uses.
  const resolvedArms = carrier.arms.map((arm, index) =>
    arm.value.kind === 'promise'
      ? `${text}.get<${index}>().awaited()`
      : (nativePromiseAwaitedText(arm.value, `${text}.get<${index}>()`) ?? `${text}.get<${index}>()`)
  )
  // Arms resolving to DIFFERENT carriers (`Promise<Entry[]> |
  // Promise<string[][]>` from a retry wrapper) meet only in the
  // result cell's union, so each is entered into that cell -- a conditional
  // expression has no common type to find between two unrelated arms.
  const armTexts: string[] = []
  for (const [index, arm] of carrier.arms.entries()) {
    const settlesVoid = arm.value.kind === 'promise' && arm.value.value.kind === 'void' && target !== null && target.kind !== 'void'
    const armText = settlesVoid ? voidAwaitedText(`${text}.get<${index}>()`) : (resolvedArms[index] as string)
    const armCarrier = settlesVoid ? undefinedCarrier : awaitedRepresentation(arm.value)
    if (
      target === null ||
      target.kind === 'void' ||
      armCarrier === null ||
      armCarrier.kind === 'void' ||
      cppTypeOf(armCarrier) === cppTypeOf(target)
    ) {
      armTexts.push(armText)
      continue
    }
    armTexts.push(alignedValueText(ctx, site, armCarrier, target, armText) ?? armText)
  }
  const last = armTexts[armTexts.length - 1]
  if (last === undefined) return null
  let chain = last
  for (let index = armTexts.length - 2; index >= 0; index -= 1) {
    chain = `${text}.is<${index}>() ? ${armTexts[index]} : (${chain})`
  }
  return `(${chain})`
}

const undefinedCarrier: Representation = { kind: 'undefined' }

/** A `Promise<void>` read as the `undefined` it settles to. */
const voidAwaitedText = (text: string): string => `(${text}.awaited(), gea::Undefined{})`

/** Whether a carrier is an instance of a class extending the intrinsic `Promise`. */
const isNativePromiseClass = (carrier: Representation): boolean => carrier.kind === 'class-ref' && carrier.nativeBase?.kind === 'promise'

/**
 * `await` of an instance of a class extending `Promise`: its base promise's
 * own `awaited()`. A family redeclaring `then` refuses by name -- 27.2.4.7.1
 * would call that `then`, and the native read would skip it.
 */
const nativePromiseAwaitedText = (carrier: Representation, text: string): string | null => {
  if (!isNativePromiseClass(carrier)) return null
  const promise = nativePromiseBaseOf(carrier)
  if (promise === null) {
    throw createCppEmitBlockedError(
      'call-abi:await-overridden-then',
      `resolving an instance of class ${carrier.kind === 'class-ref' ? carrier.declaration : ''} calls the "then" its family redeclares, ` +
        'which a read of its native promise would skip'
    )
  }
  return `static_cast<const ${cppTypeOf(promise)}&>(*${text}).awaited()`
}

/**
 * The FOURTH shape: a thenable that may also be ABSENT.
 *
 * `PromiseResolve` resolves a non-thenable to itself, and `undefined` is a
 * non-thenable, so `await (Promise<T> | undefined)` is `T | undefined` -- and
 * the carrier for such a value is an `optional` WRAPPER around the thing that
 * may be a promise, never a promise or a union of one. Asking only the three
 * kinds above therefore passed it through untouched, and the result cell was
 * then told it held the payload while it was handed the wrapper, and clang
 * refused the store (`await writeStream(...)?.catch(...)`,
 * `Optional<Promise<undefined>>`, and `await options.errorHandler(err)`,
 * an optional over a union).
 *
 * The presence test is the resolution: present resolves the payload by the
 * same three rules one level in, absent resolves to the absence itself. Which
 * absence is the wrapper's own tag -- `null` and `undefined` are distinguishable
 * values and a later `=== null` on the result would answer the wrong one --
 * and it is spelled by `cppConstantLiteral` and stored by `alignedValueText`,
 * the same pair every other absence store already goes through, rather than a
 * second hand-written empty-optional spelling that could drift from theirs.
 *
 * `target` is the cell the text must produce, and it is the IR's own result
 * carrier rather than something derived here: the two arms resolve to
 * DIFFERENT carriers whenever the payload is a union mixing `T` with
 * `Promise<T | undefined>` (`CustomErrorHandler` is exactly that), so
 * `awaitedRepresentation` cannot name one and only the consumer knows which
 * cell is waiting. It falls back to that derivation for the caller that has no
 * result cell of its own -- `Promise.all`, whose element lambda deduces its
 * own return type.
 */
const awaitedOptionalText = (
  ctx: ConversionSite,
  site: string,
  carrier: Extract<Representation, { kind: 'optional' }>,
  text: string,
  target: Representation | null
): string | null => {
  // The payload resolves in the result cell's own terms only where it has no
  // carrier of its own to answer in: a `Promise<void>` (whose `awaited()` is
  // no value) or arms that disagree.
  const payloadResolution = awaitedRepresentation(carrier.payload)
  const present = awaitedText(
    ctx,
    site,
    carrier.payload,
    `(*${text})`,
    payloadResolution === null || payloadResolution.kind === 'void' ? target : null
  )
  // Nothing under the wrapper is a thenable, so the optional is already its
  // own resolution and needs no text -- the same answer the bare-carrier case
  // gives, one level out.
  if (present === null) return null
  const resolved = target ?? awaitedRepresentation(carrier)
  // A `void` result has no value to select between, so there is no ternary to
  // build; and a payload whose arms resolve to carriers that disagree leaves
  // the derivation with no name for the cell, which is a real hole rather than
  // a spelling gap.
  if (resolved === null || resolved.kind === 'void') return null
  const absence: Representation = { kind: carrier.absence }
  const absenceText = cppConstantLiteral(carrier.absence, carrier.absence, absence)
  const absent = alignedValueText(ctx, site, absence, resolved, absenceText)
  if (absent === null) return null
  return `(${text}.has_value() ? ${present} : ${absent})`
}

/**
 * `await` inside an async COROUTINE: the same four resolution shapes
 * `awaitedText` states, rendered as statements that suspend.
 *
 * `co_await promise` suspends the frame and resumes it from one promise job
 * with the fulfillment value, or rethrows the rejection at the resume point
 * where the enclosing `try` catches it. A non-thenable is awaited too --
 * 27.7.5.3 wraps it in a resolved promise, so `await 1` still yields to the
 * job queue once -- through `gea::awaitValue`, which is that one tick.
 *
 * Statements rather than one expression, because a `co_await` is legal in far
 * fewer places than a read is: never inside a lambda, and every conversion
 * renderer is free to spell its answer as one. So each arm suspends into a
 * named local first, and only that local is ever handed to `alignedValueText`.
 *
 * `into` is the result cell, already declared; `null` discards the value, and
 * so does a `void` target.
 */
export const coroutineAwaitStatements = (
  ctx: ConversionSite,
  site: string,
  carrier: Representation,
  text: string,
  target: Representation | null,
  into: string | null
): readonly string[] => {
  const cell = into === null || target === null || target.kind === 'void' ? null : { name: into, carrier: target }
  // The top level keeps the plain assignment `awaitedText` makes: the result
  // cell holds the payload carrier the plan published for this `await`.
  if (carrier.kind === 'promise') {
    if (carrier.value.kind === 'void') return settleInto(ctx, site, `${text}`, carrier.value, cell)
    return cell === null ? [`co_await ${text};`] : [`${cell.name} = co_await ${text};`]
  }
  const nativePromise = nativePromiseCoroutineText(carrier, text)
  if (nativePromise !== null) return settleInto(ctx, site, nativePromise.text, nativePromise.payload, cell)
  // A box may hold a promise, which is adopted; anything else settles to
  // itself. `promiseResolveDynamic` is that 27.2.4.7.1 split, answered with a
  // promise either way, so both take their one tick.
  if (carrier.kind === 'dynamic') return settleInto(ctx, site, dynamicResolutionText(text), carrier, cell)
  if (carrier.kind === 'optional' && holdsThenable(carrier.payload)) return armStatements(ctx, site, carrier, text, cell, 0)
  if (carrier.kind === 'tagged-union' && holdsThenable(carrier)) return armStatements(ctx, site, carrier, text, cell, 0)
  return cell === null ? [`co_await gea::awaitValue(${text});`] : [`${cell.name} = co_await gea::awaitValue(${text});`]
}

interface AwaitCell {
  readonly name: string
  readonly carrier: Representation
}

/** `PromiseResolve` of a box, as a promise to suspend on. */
const dynamicResolutionText = (text: string): string => `gea::detail::promiseResolveDynamic(${text})`

/**
 * The one-tick Await an async generator writes itself around a value it
 * yields or returns, and the async-from-sync step's second tick (the runtime
 * adds none of these). A box goes through `promiseResolveDynamic`, because it
 * may hold a thenable to adopt and `gea::awaitValue` refuses a `gea::Value` at
 * compile time for exactly that reason; every native carrier takes
 * `awaitValue`, which already adopts a promise or a union arm holding one.
 */
export const awaitTickText = (carrier: Representation, text: string): string =>
  carrier.kind === 'dynamic' ? `co_await ${dynamicResolutionText(text)}` : `co_await gea::awaitValue(${text})`

/** `nativePromiseAwaitedText`'s promise, without the read: the base promise and the payload it settles. */
const nativePromiseCoroutineText = (
  carrier: Representation,
  text: string
): { readonly text: string; readonly payload: Representation } | null => {
  if (!isNativePromiseClass(carrier)) return null
  const promise = nativePromiseBaseOf(carrier)
  if (promise === null) {
    throw createCppEmitBlockedError(
      'call-abi:await-overridden-then',
      `resolving an instance of class ${carrier.kind === 'class-ref' ? carrier.declaration : ''} calls the "then" its family redeclares, ` +
        'which a read of its native promise would skip'
    )
  }
  return { text: `static_cast<const ${cppTypeOf(promise)}&>(*${text})`, payload: promise.value }
}

/** One arm's value entered into the result cell -- by the conversion census whenever the carriers differ. */
const enteredText = (ctx: ConversionSite, site: string, source: Representation, cell: AwaitCell, text: string): string => {
  if (cppTypeOf(source) === cppTypeOf(cell.carrier)) return text
  const converted = alignedValueText(ctx, site, source, cell.carrier, text)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(cell.carrier)}`,
      `awaits a ${representationKey(source)} arm into a ${representationKey(cell.carrier)} result, and no conversion is installed between them`
    )
  }
  return converted
}

/** Suspend on one promise and enter what it settles into the cell. */
const settleInto = (
  ctx: ConversionSite,
  site: string,
  promise: string,
  payload: Representation,
  cell: AwaitCell | null
): readonly string[] => {
  if (cell === null) return [`co_await ${promise};`]
  // A `Promise<void>` resumes with no value; the language's is `undefined`.
  if (payload.kind === 'void')
    return [`co_await ${promise};`, `${cell.name} = ${enteredText(ctx, site, undefinedCarrier, cell, 'gea::Undefined{}')};`]
  if (cppTypeOf(payload) === cppTypeOf(cell.carrier)) return [`${cell.name} = co_await ${promise};`]
  return [`{ auto gea_settled = co_await ${promise};`, `${cell.name} = ${enteredText(ctx, site, payload, cell, 'gea_settled')}; }`]
}

/** A value that resolves to itself still takes its one tick. */
const itselfInto = (ctx: ConversionSite, site: string, source: Representation, text: string, cell: AwaitCell | null): readonly string[] =>
  cell === null
    ? [`co_await gea::awaitValue(${text});`]
    : [`${cell.name} = co_await gea::awaitValue(${enteredText(ctx, site, source, cell, text)});`]

/**
 * An optional thenable or a union with a thenable arm: the live arm decides
 * which of the three resolutions runs. The value is copied into a local of the
 * frame first -- its text may name a temporary, and it is read again after a
 * suspension has let other jobs run.
 */
const armStatements = (
  ctx: ConversionSite,
  site: string,
  carrier: Extract<Representation, { kind: 'optional' | 'tagged-union' }>,
  text: string,
  cell: AwaitCell | null,
  depth: number
): readonly string[] => {
  const held = `gea_awaited_${depth}`
  const lines: string[] = [`{ auto ${held} = ${text};`]
  const resolveArm = (arm: Representation, armText: string): readonly string[] => {
    if (arm.kind === 'promise') return settleInto(ctx, site, armText, arm.value, cell)
    const nativePromise = nativePromiseCoroutineText(arm, armText)
    if (nativePromise !== null) return settleInto(ctx, site, nativePromise.text, nativePromise.payload, cell)
    if ((arm.kind === 'optional' || arm.kind === 'tagged-union') && holdsThenable(arm))
      return armStatements(ctx, site, arm, armText, cell, depth + 1)
    if (arm.kind === 'dynamic') return settleInto(ctx, site, dynamicResolutionText(armText), arm, cell)
    return itselfInto(ctx, site, arm, armText, cell)
  }
  if (carrier.kind === 'optional') {
    const absence: Representation = { kind: carrier.absence }
    const absenceText = cppConstantLiteral(carrier.absence, carrier.absence, absence)
    lines.push(`if (${held}.has_value()) {`, ...resolveArm(carrier.payload, `(*${held})`), '} else {')
    lines.push(...itselfInto(ctx, site, absence, absenceText, cell), '}')
  } else {
    const last = carrier.arms.length - 1
    carrier.arms.forEach((arm, index) => {
      const opener = index === 0 ? `if (${held}.is<${index}>()) {` : index === last ? '} else {' : `} else if (${held}.is<${index}>()) {`
      lines.push(...(last === 0 ? [] : [opener]), ...resolveArm(arm.value, `${held}.get<${index}>()`))
    })
    if (last > 0) lines.push('}')
  }
  lines.push('}')
  return lines
}
