import type { DeclarationId } from '../../identity/ids.js'
import type { ClassLayout } from '../../projection/classes.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import type { Representation } from '../../representation/model.js'
import { toNumberText } from './emit-tonumber.js'
import { toStringText } from './emit-tostring.js'

/**
 * `+` with exactly one `dynamic` side -- the one mixed-carrier operator the
 * slot census leaves raw (`projection/slots.ts`'s `binarySlot`), because the
 * language's answer depends on a runtime fact only the dynamic side knows:
 * ECMA-262 ApplyStringOrNumericBinaryOperator (13.15.3) concatenates when the
 * dynamic operand's ToPrimitive turns out to be a String and adds otherwise,
 * and `gea::dynamicToPrimitive` is the only thing that can find out.
 *
 * Every OTHER mixed-carrier operator is a compile-time conversion the census
 * states before the operator runs -- `ToNumber`/`ToString` coercion nodes
 * (`conversion/nodes.ts` `coercionFor`) rendered by `emit-coercion.ts` -- so
 * this file no longer decides IsLessThan's string-or-numeric split or the
 * ToNumeric pair: the operands reach `emit.ts` already in one carrier and
 * take the same-carrier spelling everything else does.
 */

/**
 * `+` when exactly one side is `dynamic` and the other is an ordinary typed
 * carrier this backend already converts (`toStringText`/`toNumberText`) --
 * `parsed + 1` where `parsed` came from `JSON.parse`, or either side a
 * declared `any` never narrowed. The checker's own published result is
 * `dynamic` here specifically BECAUSE it cannot rule out the dynamic side
 * turning out to hold a string at runtime -- if it *could* rule that out (the
 * typed side is provably `string`, so the result is `string` regardless of
 * the dynamic side), `emit.ts`'s own string branch answers it first, ahead of
 * this one, through `toStringText`'s existing `dynamic` case; what reaches
 * here is the genuinely ambiguous remainder.
 *
 * The typed operand's ToPrimitive has no runtime choice to make -- it is
 * already the exact carrier `toStringText`/`toNumberText` name, computed once
 * at compile time -- so only the DYNAMIC side needs a runtime discriminant,
 * and the typed side is never boxed to obtain one: this is the "keep
 * `gea::dynamicAdd` for dynamic+dynamic only" half of this file's contract.
 * `gea::dynamicToPrimitive` is called exactly once (captured in a local
 * inside the IIFE) because ECMA-262 ToPrimitive may run user code
 * (`valueOf`/`toString`) for a genuine dynamic object, and calling it twice
 * would run that code twice.
 *
 * `null` when the typed side has no ToString or ToNumber this backend
 * implements (a BigInt domain, chiefly) -- the caller falls back to the
 * boxed `gea::dynamicAdd` path rather than silently dropping one arm.
 */
export const mixedDynamicPlusText = (
  dynamicSide: { readonly text: string },
  typedSide: { readonly text: string; readonly representation: Representation },
  dynamicIsLeft: boolean,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): string | null => {
  const typedAsString = toStringText(typedSide.text, typedSide.representation, classes, deriver)
  const typedAsNumber = toNumberText(typedSide.text, typedSide.representation)
  if (typedAsString === null || typedAsNumber === null) return null
  const concatenated = dynamicIsLeft
    ? `gea::host::detail::toString(__gea_dyn_prim) + (${typedAsString})`
    : `(${typedAsString}) + gea::host::detail::toString(__gea_dyn_prim)`
  const added = dynamicIsLeft
    ? `gea::dynamicToNumber(__gea_dyn_prim) + (${typedAsNumber})`
    : `(${typedAsNumber}) + gea::dynamicToNumber(__gea_dyn_prim)`
  return (
    `([&]() -> gea::Value { ` +
    `const gea::Value __gea_dyn_prim = gea::dynamicToPrimitive(${dynamicSide.text}); ` +
    `if (__gea_dyn_prim.tag() == gea::Value::Tag::String) return gea::Value::box(gea::Value::Tag::String, (${concatenated})); ` +
    `return gea::Value::box(gea::Value::Tag::Number, (${added})); ` +
    `}())`
  )
}
