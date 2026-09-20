import ts from 'typescript'

/**
 * Whether a type can never be `null` or `undefined`.
 *
 * `any`/`unknown` do not count: neither rules out either value, so a proof
 * built on them is not a proof. `void` does not count either -- a `void` in a
 * stored position is `undefined`, and treating it as a non-nullish type is how
 * an absent value passes for a present one.
 *
 * Two questions in this compiler turn on it, and they must agree. A property
 * access asks it of a receiver to decide whether the `[[Get]]` can throw
 * (`properties.ts`), and both halves of an optional chain ask it of a declared
 * type to decide whether the `undefined` the checker put on their result is the
 * operator's own -- and so removable -- or the declaration's, and not.
 */
export const excludesNullish = (type: ts.Type): boolean => {
  const constituents = type.isUnion() ? type.types : [type]
  const nullishOrUnproven =
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Conditional |
    ts.TypeFlags.IndexedAccess
  return constituents.every((member) => (member.flags & nullishOrUnproven) === 0)
}
