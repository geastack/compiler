import type { CoercionOperation } from '../../conversion/registry.js'
import { toStringOnlyObjectKinds } from '../../projection/coercions.js'
import type { Representation } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { toNumberText } from './emit-tonumber.js'
import { toStringTextOver } from './emit-tostring.js'
import { isDateCarrier } from './prototype/emit-prototype-date.js'

/**
 * The text of one abstract operation over one carrier -- the renderer behind
 * every `coercion` node the conversion census mints (`conversion/nodes.ts`
 * `coercionFor`), and the SAME function the registry's `coercion` entry
 * (`conversions.ts`) asks to decide whether the operation is installed at all.
 * One function answering both questions is what keeps a census that says
 * "convertible" and a printer that says "no text" from being two authorities.
 *
 * `ToString` is `emit-tostring.ts`'s table, wrapped in `std::string(...)`
 * because an object's answer can be a bare C++ string LITERAL (`const
 * char[N]`) and `+`/`<` over two of those is pointer arithmetic, not string
 * concatenation or comparison.
 *
 * `ToNumber` is `emit-tonumber.ts`'s table for every primitive carrier, and
 * for an object it is ECMA-262 7.1.4 step 1: ToNumber(ToPrimitive(obj,
 * number)). Every object this compiler carries except a Date has no own
 * `valueOf`, so OrdinaryToPrimitive falls through to its `toString` and the
 * number is ToNumber of that string (`1 - {}` is `NaN` through
 * `"[object Object]"`). A Date's own `@@toPrimitive` answers the timestamp
 * for hint "number", which no table here computes, so it is refused rather
 * than read through its printable string -- the wrong primitive.
 */
export const coercionText = (
  operation: CoercionOperation,
  text: string,
  source: Representation,
  layouts: RecordLayoutPolicy
): string | null => {
  if (operation === 'ToString') {
    const converted = toStringTextOver(text, source, layouts)
    return converted === null ? null : `std::string(${converted})`
  }
  const direct = toNumberText(text, source)
  if (direct !== null) return direct
  if (!toStringOnlyObjectKinds.has(source.kind) || isDateCarrier(source)) return null
  const primitive = toStringTextOver(text, source, layouts)
  return primitive === null ? null : `gea::host::detail::toNumber(std::string(${primitive}))`
}
