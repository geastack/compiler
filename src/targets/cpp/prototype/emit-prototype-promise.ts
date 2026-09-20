import { representationKey, type Representation } from '../../../representation/model.js'
import { optionalOf } from '../../../representation/optional.js'
import { type ConversionSite, alignedValueText } from '../emit-narrowing.js'
import { cppConstantLiteral } from '../types.js'

/**
 * Resolving a value the way `await` and `Promise.all` both do.
 *
 * ECMA-262 27.2.4.7.1 `PromiseResolve` is the one operation behind both: a
 * thenable is adopted, and anything else resolves to ITSELF. `Awaited<T>` is
 * TypeScript's name for the same fact, which is why `await 1` is `1`.
 *
 * `gea::Promise<V>` is a settled-value box with no job queue (see its own doc
 * comment in `runtime/gea_runtime.h`), so adoption is reading the value now --
 * `.awaited()` -- rather than a suspension this substrate has no coroutine
 * primitive for.
 *
 * The case this exists for is the THIRD one, which neither half of that
 * sentence covers on its own: a union of both. `string | Promise<string>` is
 * what every `Promise.all` argument and every conditionally-async helper is
 * made of (hono's `utils/html.ts` is exactly that), and it is neither "a
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
  if (carrier.kind === 'promise') return `${text}.awaited()`
  if (carrier.kind === 'optional') return awaitedOptionalText(ctx, site, carrier, text, target)
  if (carrier.kind !== 'tagged-union') return null
  if (!carrier.arms.some((arm) => arm.value.kind === 'promise')) return null
  // Every arm is accounted for, not just the promise ones: an arm that is not
  // a thenable resolves to itself, so it contributes its own payload. The last
  // arm is the fall-through and is never tested, because the union holds one
  // of its arms by construction and a test with no `else` has nothing to
  // answer -- the same shape `taggedUnionArmText` (emit-narrowing.ts) uses.
  const armTexts = carrier.arms.map((arm, index) =>
    arm.value.kind === 'promise' ? `${text}.get<${index}>().awaited()` : `${text}.get<${index}>()`
  )
  const last = armTexts[armTexts.length - 1]
  if (last === undefined) return null
  let chain = last
  for (let index = armTexts.length - 2; index >= 0; index -= 1) {
    chain = `${text}.is<${index}>() ? ${armTexts[index]} : (${chain})`
  }
  return `(${chain})`
}

/**
 * The FOURTH shape: a thenable that may also be ABSENT.
 *
 * `PromiseResolve` resolves a non-thenable to itself, and `undefined` is a
 * non-thenable, so `await (Promise<T> | undefined)` is `T | undefined` -- and
 * the carrier for such a value is an `optional` WRAPPER around the thing that
 * may be a promise, never a promise or a union of one. Asking only the three
 * kinds above therefore passed it through untouched, and the result cell was
 * then told it held the payload while it was handed the wrapper: five of the
 * @hono/node-server stores clang refused were exactly that
 * (`responseViaCache`'s `await writeFromReadableStream(...)?.catch(...)`,
 * `Optional<Promise<undefined>>`, and `responseViaResponseObject`'s
 * `await options.errorHandler(err)`, an optional over a union).
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
  const present = awaitedText(ctx, site, carrier.payload, `(*${text})`)
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
 * What `awaitedText` resolves a carrier TO -- the carrier's `Awaited<T>`.
 *
 * Stated beside the render rather than derived by a caller, so the two cannot
 * disagree about which arms survive. A union of promises over one payload
 * resolves to that payload; a union mixing a payload with a promise of the
 * same payload resolves to the payload as well, which is the ordinary case.
 * `null` when the arms do not agree, which is a real hole rather than a
 * missing recipe: `string | Promise<number>` resolves to `string | number`,
 * a union this cannot mint without the census's own arm ordering.
 */
export const awaitedRepresentation = (carrier: Representation): Representation | null => {
  if (carrier.kind === 'promise') return carrier.value
  // An absence survives the resolution -- `PromiseResolve(undefined)` is
  // `undefined` -- so the wrapper is kept over whatever the payload resolves
  // to. Through `optionalOf` rather than a literal wrapper because the payload
  // may already carry its own absence (a refcounted instance, a handle, a box,
  // or a second optional), and stacking a flag onto one of those is the carrier
  // the census forbids rather than a type this backend can spell.
  if (carrier.kind === 'optional') {
    const payload = awaitedRepresentation(carrier.payload)
    return payload === null ? null : optionalOf(payload, carrier.absence)
  }
  if (carrier.kind !== 'tagged-union') return carrier
  const resolved = carrier.arms.map((arm) => (arm.value.kind === 'promise' ? arm.value.value : arm.value))
  const [first, ...rest] = resolved
  if (!first) return null
  return rest.every((entry) => representationKey(entry) === representationKey(first)) ? first : null
}
