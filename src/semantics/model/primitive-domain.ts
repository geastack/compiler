import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralShape } from './structural-types.js'

/**
 * The one primitive every value of a shape belongs to, or `null`.
 *
 * Literal and unique-symbol shapes are single values of their primitive,
 * and a primitive shape is that primitive. An object, an
 * array or a handle is not a primitive value however few of them there are.
 *
 * The one authority for this question. `representation/union.ts` decides a
 * union of literals of one primitive IS that primitive, because the arms differ
 * in value and not in carrier; `representation/value-records.ts` asks the same
 * question of a record's field, because a field that is a primitive value is
 * one a copy of the record cannot share. Answering it twice is how the two come
 * apart -- a field the deriver carries as `std::string` being judged a
 * reference, or the reverse.
 */
export const primitiveDomainOf = (shape: StructuralShape | null | undefined): string | null =>
  shape?.kind === 'unique-symbol'
    ? 'symbol'
    : shape?.kind === 'literal'
      ? shape.primitive
      : shape?.kind === 'primitive'
        ? shape.primitive
        : null

/**
 * The domain every member of a union shares, or `null` when they share none.
 *
 * `'front' | 'back' | 'external'` is one `std::string`; `string | number` is
 * two carriers and a real sum. A non-union shape answers for itself, so a
 * caller with a field of unknown shape needs only this.
 */
export const sharedPrimitiveDomainOf = (
  shapeOf: (id: StructuralTypeId) => StructuralShape | null | undefined,
  shape: StructuralShape | null | undefined
): string | null => {
  if (shape?.kind !== 'union') return primitiveDomainOf(shape)
  return joinedPrimitiveDomainOf(new Set(shape.members.map((member) => primitiveDomainOf(shapeOf(member)))))
}

const integerWidths: readonly string[] = ['int32', 'int64']

/**
 * The one domain a set of member domains joins to, or `null` when they join to
 * none.
 *
 * One domain is itself. Several join only when every one is a Number: `int`
 * and `i32` are Numbers the program opted into holding as machine integers
 * (`declared-integers.ts`), so `0 | int` -- what TypeScript infers for a
 * callback returning `0` on one path and an `int` on another -- names Number
 * values of one carrier, not a sum. A sum of `double` and `int64_t` arms has
 * no runtime test that could tell its arms apart, and the emitter has no `+`
 * over it. Every member a declared integer joins to the widest of them; any
 * other Number member (`number`, a literal) joins to `number`, the carrier
 * that holds every value of each.
 */
export const joinedPrimitiveDomainOf = (domains: ReadonlySet<string | null>): string | null => {
  if (domains.has(null) || domains.size === 0) return null
  const [only] = [...domains]
  if (domains.size === 1) return only ?? null
  if (![...domains].every((domain) => domain === 'number' || (domain !== null && integerWidths.includes(domain)))) return null
  if (domains.has('number')) return 'number'
  return domains.has('int64') ? 'int64' : 'int32'
}
