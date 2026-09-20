/**
 * Whether a key's known constant text spells a canonical array index --
 * ECMA-262 6.1.7's own definition, the same one `gea::ArrayObject::isIndex`
 * applies at runtime for a key that is not a compile-time constant.
 *
 * `keyOf` (semantics/normalize/producers/properties.ts) records a numeric
 * *and* a string literal key identically -- `ToPropertyKey` turns `0` into the
 * String `"0"`, so `a[0]` and `a["0"]` reach here as the same constant text --
 * which means a constant key on an Array is never provably "not an index" by
 * its syntax alone; the value has to be parsed the same way a computed key's
 * runtime value would be, so a literal and a computed key never disagree on
 * whether the same value is an index.
 */
export const canonicalIndexLiteral = (text: string): string | null => {
  const value = Number(text)
  return Number.isInteger(value) && value >= 0 && value < 4294967295 && String(value) === text ? text : null
}
