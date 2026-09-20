import type { IrOperand, IrResult } from '../../ir/model.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, defineValue, operandText, type EmitContext } from './emit-context.js'

/**
 * ToNumber of a value, spelled from the carrier it actually arrived in --
 * `emit-tostring.ts`'s sibling for ECMA-262 7.1.4.
 *
 * Kept as its own table rather than folded into the ToString one because the
 * two abstract operations disagree on exactly the cases that matter here:
 * `String(null)` is `"null"` and `Number(null)` is `0`, `String(undefined)` is
 * `"undefined"` and `Number(undefined)` is `NaN`. One table answering both
 * would have to carry that split anyway, and a single shared "absence" answer
 * is precisely the bug this file was written to remove.
 *
 * v1's own conversion suite lives in the `value_*` family, which is v1's boxed
 * runtime -- `gea::runtime::coerce::to_number` dispatches on a
 * `gea_cpp_value`'s runtime tag. The *algorithm* is ported here re-typed over
 * v2's native carriers: the tag switch becomes a compile-time dispatch on the
 * representation, and the per-case answers (0 for null, NaN for undefined,
 * 1/0 for booleans, StringToNumber for strings) are v1's, unchanged. The
 * string case itself is already in `runtime/gea_runtime.h` as
 * `gea::host::detail::toNumber(const std::string&)`, ported verbatim from v1
 * there with its own comments.
 *
 * `null` is returned for a carrier this has no conversion for; the caller
 * names the refusal.
 */
export const toNumberText = (text: string, carrier: Representation): string | null => {
  // Wrapped in `std::string(...)` even when `text` is already one: a STRING
  // CONSTANT's text is a bare C++ literal (`"10"`, type `const char*`), and
  // `toNumber` is overloaded on `bool` as well as `const std::string&` --
  // `const char*` -> `bool` is a standard (pointer-to-bool) conversion, which
  // overload resolution ranks ABOVE the user-defined `std::string` converting
  // constructor, so an unwrapped literal silently calls `toNumber(bool)` and
  // reads any non-null string as `1`. Reproduced with `"10" < 5`, which
  // returned `true` (`toNumber(true) == 1 < 5`) instead of the correct
  // `false` (`toNumber("10") == 10 < 5`) before this wrap.
  if (carrier.kind === 'string') return `gea::host::detail::toNumber(std::string(${text}))`
  if (carrier.kind === 'null') return 'gea::host::detail::toNumberNull()'
  if (carrier.kind === 'undefined') return 'gea::host::detail::toNumberUndefined()'
  // A dynamic operand has no one static domain. Its ToNumber is the runtime's
  // complete dynamic operation -- including ToPrimitive for objects and the
  // language's Symbol/BigInt errors -- rather than a tag assertion or the
  // narrower postfix ToNumeric lowering below.
  if (carrier.kind === 'dynamic') return dynamicToNumberText(text)
  if (carrier.kind === 'scalar') {
    if (carrier.domain === 'boolean') return `gea::host::detail::toNumber(static_cast<bool>(${text}))`
    // ToNumber of a BigInt is a TypeError in the language, and the separate
    // `ToNumeric` path that does convert one needs arbitrary-precision digits
    // this backend has not got. Neither is guessed at.
    if (carrier.domain === 'bigint') return null
    // Already a number: ECMAScript's ToNumber of a Number is the identity, so
    // only the widening every numeric domain does to reach `double` is left.
    return `static_cast<double>(${text})`
  }
  // The optional's `absence` tag is the whole point. `Number(null)` is `0` and
  // `Number(undefined)` is `NaN`, and `Representation`'s `optional` variant
  // states which of the two it carries -- so an absent `optional(string,null)`
  // is `0` and an absent `optional(string,undefined)` is `NaN`, each exactly
  // once. `text` is an SSA name (`vN`), so reading it twice in one conditional
  // has no effect to duplicate.
  if (carrier.kind === 'optional') {
    const present = toNumberText(`(*${text})`, carrier.payload)
    if (present === null) return null
    const absent = carrier.absence === 'null' ? 'gea::host::detail::toNumberNull()' : 'gea::host::detail::toNumberUndefined()'
    return `(${text}.has_value() ? static_cast<double>(${present}) : static_cast<double>(${absent}))`
  }
  // A tagged union is a finite set of statically known arms plus a runtime
  // discriminant, so ToNumber is that discriminant selecting one arm's own
  // conversion -- the same shape `emit-tostring.ts` renders, over `double`
  // instead of `std::string`. The last arm is the `else`: the discriminant is
  // always one of `0..arity-1`.
  if (carrier.kind === 'tagged-union') {
    const arms: string[] = []
    for (const [index, arm] of carrier.arms.entries()) {
      const converted = toNumberText(`${text}.get<${index}>()`, arm.value)
      if (converted === null) return null
      arms.push(`static_cast<double>(${converted})`)
    }
    const last = arms[arms.length - 1]
    if (last === undefined) return null
    let chain = last
    for (let index = arms.length - 2; index >= 0; index -= 1) {
      chain = `${text}.is<${index}>() ? ${arms[index]} : ${chain}`
    }
    return `(${chain})`
  }
  return null
}

/**
 * The carrier that actually has no ToNumber -- the same descent
 * `emit-tostring.ts`'s `unconvertibleToStringCarrier` makes, and for the same
 * reason: an `optional`/`tagged-union` converts through its payload/arms, so
 * naming the wrapper in the refusal would state something false about what
 * this backend can convert.
 */
const unconvertibleToNumberCarrier = (carrier: Representation): Representation => {
  if (carrier.kind === 'optional') return unconvertibleToNumberCarrier(carrier.payload)
  if (carrier.kind === 'tagged-union') {
    for (const arm of carrier.arms) {
      if (toNumberText('x', arm.value) === null) return unconvertibleToNumberCarrier(arm.value)
    }
  }
  return carrier
}

/** Why a carrier has no ToNumber, for a refusal message. */
export const toNumberRefusal = (outer: Representation): string => {
  const carrier = unconvertibleToNumberCarrier(outer)
  const within = representationKey(carrier) === representationKey(outer) ? '' : ` (inside a "${representationKey(outer)}")`
  return carrier.kind === 'scalar' && carrier.domain === 'bigint'
    ? `ToNumber of a bigint${within} is a lossy conversion the language defines separately, and it is not implemented`
    : `ToNumber of a "${representationKey(carrier)}" carrier${within} needs ToPrimitive, which can call user code and is ` +
        'not implemented'
}

/**
 * ToNumeric of a BOXED value, landing on `scalar(number)` -- the postfix
 * `x++`/`x--` half `ir/lower.ts`'s `coercion` case mints for a `dynamic`
 * operand (`ComputeOperation` form `'unary'`, operator `'ToNumeric'`; see
 * that file's own comment on why this is the one non-identity coercion this
 * backend lowers at all).
 *
 * Deliberately NOT `unboxedLoadText` (`emit-narrowing.ts`): that primitive is
 * an ASSERTION -- it checks the box holds one DECLARED tag and aborts on any
 * other, which is the right answer for a program-stated `as`-cast and the
 * wrong one here. `ToNumeric` does not assert what a `dynamic` value is; it
 * CONVERTS whatever tag the box actually holds, per ECMA-262 7.1.4/3.1.13 --
 * the identity for Number, `1`/`0` for Boolean, `StringToNumber` for String,
 * `0` for Null, `NaN` for Undefined. Object/Function/Symbol/BigInt have no
 * conversion this backend can perform without either running arbitrary user
 * code (ToPrimitive) or arbitrary-precision arithmetic (BigInt) -- both
 * genuinely unimplemented, so those tags fall through to
 * `gea::detail::unboxValue<double>` asking for `Tag::Number`, which is
 * exactly the tag they are not: a LOUD runtime refusal by name, never a
 * silently wrong `NaN` standing in for "this program hit a case nobody
 * proved sound".
 *
 * Every primitive named here is public, pre-existing runtime API this file
 * already calls (`gea::host::detail::toNumber`/`toNumberNull`/
 * `toNumberUndefined`, all used above) or that `emit-narrowing.ts` already
 * calls the identical way (`gea::detail::unboxValue`, `Value::tag()`) --
 * nothing new is added to `runtime/gea_runtime.h` for this.
 */
const dynamicToNumericText = (text: string): string => {
  const site = 'a ToNumeric coercion of a dynamic value'
  const unbox = (type: string, tag: string): string => `gea::detail::unboxValue<${type}>(${text}, gea::Value::Tag::${tag}, "${site}")`
  return (
    `(${text}.tag() == gea::Value::Tag::Number ? ${unbox('double', 'Number')}` +
    ` : ${text}.tag() == gea::Value::Tag::Boolean ? gea::host::detail::toNumber(${unbox('bool', 'Boolean')})` +
    ` : ${text}.tag() == gea::Value::Tag::String ? gea::host::detail::toNumber(${unbox('std::string', 'String')})` +
    ` : ${text}.tag() == gea::Value::Tag::Null ? gea::host::detail::toNumberNull()` +
    ` : ${text}.tag() == gea::Value::Tag::Undefined ? gea::host::detail::toNumberUndefined()` +
    ` : ${unbox('double', 'Number')})`
  )
}

/** The one runtime authority for dynamic ECMAScript ToNumber. */
const dynamicToNumberText = (text: string): string => `gea::dynamicToNumber(${text})`

/**
 * `emit.ts`'s `emitCompute` entry point for the `unary`/`'ToNumeric'` shape
 * `ir/lower.ts` mints -- kept here, not inline in that file's own `unary`
 * dispatch, purely to leave `emit.ts` its documentation budget under the
 * architecture gate's line cap; the dispatch itself is one `operator ===
 * 'ToNumeric'` check there, unchanged.
 */
export const emitToNumericCoercion = (ctx: EmitContext, lines: string[], operand: IrOperand, result: IrResult): void => {
  if (operand.representation.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      'runtime-helper:computation:coercion:ToNumeric',
      `a "ToNumeric" coercion over a "${operand.representation.kind}" carrier has no C++ spelling here`
    )
  }
  lines.push(`${defineValue(ctx, result)} = ${dynamicToNumericText(operandText(ctx, operand))};`)
}
