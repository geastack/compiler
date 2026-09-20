import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { PropertyKeyShape, StructuralShape } from '../model/structural-types.js'

/**
 * `keyof T`, answered from the sealed structural table.
 *
 * Its own module because it needs exactly one thing -- the table -- out of the
 * large closure the rest of normalization shares. A resolver that reads back
 * what is already interned is a different job from the walk that interns it,
 * and keeping them apart is what stops the second one growing a shortcut into
 * the first.
 */

/**
 * A resolved key type, or the reason no key set could be named.
 *
 * Explicitly tagged, and that is the whole point of this type existing. The
 * previous answer was `StructuralTypeId | string`, discriminated at the one
 * call site by `typeof outcome === 'string'` -- and `StructuralTypeId` IS a
 * string (`identity/ids.ts` brands it at the type level only, which erases at
 * runtime). So that test was true for BOTH arms: every `keyof` this resolver
 * answered exactly was then wrapped as `unresolved(<the id>)` by its own
 * caller, and the reason string a reader saw was the id of the correct answer.
 * A union whose arms a runtime test cannot tell apart is not a union; the tag
 * is what makes the two answers distinguishable at all.
 */
export type KeyofOutcome =
  { readonly kind: 'resolved'; readonly id: StructuralTypeId } | { readonly kind: 'unmodelled'; readonly reason: string }

const resolved = (id: StructuralTypeId): KeyofOutcome => ({ kind: 'resolved', id })
const unmodelled = (reason: string): KeyofOutcome => ({ kind: 'unmodelled', reason })

export const createKeyofResolver = (table: StructuralTypeTable): ((id: StructuralTypeId) => KeyofOutcome) => {
  /** The literal (or unique-symbol) key type `keyof` contributes for one member. */
  const literalKeyShapeOf = (key: PropertyKeyShape): StructuralShape =>
    key.kind === 'symbol'
      ? { kind: 'unique-symbol', declaration: key.declaration }
      : key.kind === 'number'
        ? { kind: 'literal', primitive: 'number', text: String(key.value) }
        : { kind: 'literal', primitive: 'string', text: key.value }

  const anyKeyDomain = (): StructuralTypeId =>
    table.intern({
      kind: 'union',
      members: [
        table.intern({ kind: 'primitive', primitive: 'string' }),
        table.intern({ kind: 'primitive', primitive: 'number' }),
        table.intern({ kind: 'primitive', primitive: 'symbol' })
      ]
    })

  /**
   * `keyof T`'s shape, read back from `T`'s own already-interned shape rather
   * than re-derived from the checker.
   *
   * By the time `typeOf` is asked for a genuine `keyof` node at all, `T`'s
   * keys were *not* statically enumerable to the checker: whenever they are,
   * TypeScript collapses `keyof T` into an ordinary union of literal key
   * types before this layer ever sees it (verified against the checker
   * directly -- `keyof` of a closed interface, of a union, and of an
   * intersection of two closed interfaces all arrive already resolved to a
   * plain `UnionType`, matched by the earlier `type.isUnion()` branch, not by
   * this one). So the honest cases here are: `T` is a bare type parameter (no
   * member set exists to name yet), `T` is `any`/`unknown`/`never` (whose
   * `keyof` is a fixed answer the language states outright, not derived from
   * any member list), or `T` is some other deferred construct this layer does
   * not expand. Everything else -- a plain record reached through some other
   * path that still left it deferred -- is resolved exactly, by reading the
   * same member keys the record's own shape already published: a symbol key
   * becomes the identical `unique-symbol` anchor its member carries, so two
   * mentions of `keyof` on the same shape and a direct read of that member's
   * key stay one identity instead of acquiring two.
   */
  const keyofOfShapeId = (id: StructuralTypeId): KeyofOutcome => {
    const shape = table.get(id).shape
    switch (shape.kind) {
      case 'object': {
        // An index signature's own key domain, unioned with the literal keys
        // the declared members contribute -- which is what the language
        // answers, not an approximation of it. `keyof { [k: string]: V }` is
        // `string | number`: TypeScript admits a numeric key wherever a string
        // index does, because a property access `x[0]` on such a type is legal
        // and its key stringifies. A NUMBER index alone admits only `number`,
        // and a symbol index only `symbol`.
        //
        // A literal member key is dropped when an index already covers its
        // domain, for the same reason TypeScript reduces `string | "a"` to
        // `string`: keeping both would publish a union whose arms overlap, and
        // an overlapping union is what a tagged-union carrier cannot discriminate.
        //
        // This used to be refused outright. The refusal was honest about the
        // risk (a silently narrow key domain) but it is not narrow to state the
        // domain the language states, and mongodb's `Document` -- an index
        // signature with no declared members -- put it behind 78 of the probe's
        // mandatory obligations.
        const indexed = (key: 'string' | 'number' | 'symbol'): boolean => shape.index.some((one) => one.key === key && !one.finite)
        const primitive = (name: 'string' | 'number' | 'symbol'): StructuralTypeId => table.intern({ kind: 'primitive', primitive: name })
        const domain: StructuralTypeId[] = []
        if (indexed('string')) domain.push(primitive('string'), primitive('number'))
        else if (indexed('number')) domain.push(primitive('number'))
        if (indexed('symbol')) domain.push(primitive('symbol'))
        const absorbed = (key: PropertyKeyShape): boolean =>
          key.kind === 'symbol' ? indexed('symbol') : key.kind === 'number' ? indexed('number') || indexed('string') : indexed('string')
        const memberIds = shape.members
          .filter((member) => !absorbed(member.key))
          .map((member) => table.intern(literalKeyShapeOf(member.key)))
        const keys = [...new Set([...domain, ...memberIds])]
        if (keys.length === 0) return resolved(table.intern({ kind: 'primitive', primitive: 'never' }))
        const [only] = keys
        return resolved(keys.length === 1 && only ? only : table.intern({ kind: 'union', members: keys }))
      }
      case 'declared':
      case 'class-instance':
        return shape.body
          ? keyofOfShapeId(shape.body)
          : unmodelled(`keyof of declaration ${shape.declaration} without a structural body is not modelled`)
      case 'primitive':
        // `keyof any` and `keyof never` both name the entire key domain --
        // nothing is known about the value, so every property-key type is
        // admissible. `keyof unknown` is the opposite extreme: nothing can be
        // read off an `unknown` value at all, so its key domain is empty.
        if (shape.primitive === 'any' || shape.primitive === 'never') return resolved(anyKeyDomain())
        if (shape.primitive === 'unknown') return resolved(table.intern({ kind: 'primitive', primitive: 'never' }))
        return unmodelled(`keyof of primitive ${shape.primitive} is not modelled`)
      case 'type-parameter':
        return unmodelled(`keyof of type parameter ${shape.declaration} without a resolved base is not modelled`)
      default:
        // A union, an intersection, an array/tuple, a signature, and an
        // already-`unresolved` base all have a real `keyof` answer in the
        // language (distributed key intersection/union for the first two, the
        // element/prototype key set for the rest) that this layer does not
        // derive; naming the base's own kind is what tells a caller which
        // capability is missing, rather than folding every one of them into
        // one opaque "not modelled" reason.
        return unmodelled(`keyof of a ${shape.kind} base is not modelled`)
    }
  }

  return keyofOfShapeId
}
