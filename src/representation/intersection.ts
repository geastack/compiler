import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { StructuralShape } from '../semantics/model/structural-types.js'
import type { Representation } from './model.js'
import { representationKey } from './model.js'

/**
 * The two rules an INTERSECTION needs that are about carriers rather than
 * about types.
 *
 * `&` is associative and the checker owns what a key of `A & B` holds
 * (`derive.ts`'s `resolved` branch reads that answer). What is left here is
 * the part the checker does not answer: which members are structurally the
 * same intersection, and -- for the self-referential retry, which has no
 * reconciliation to read -- how two carriers for one key reduce to one.
 */

/**
 * An intersection's members with any NESTED intersection spliced in.
 *
 * `&` is associative, so `A & (B & C)` and `A & B & C` are the same type and
 * must reach the same carrier. They did not: a member that is itself an
 * intersection -- almost always because a NAME stands for one, and
 * `structural-declared-body.ts` interns a named intersection's body as an
 * `intersection` shape rather than expanding it -- has no object shape of
 * its own, so `intersectionMemberShape` answered `null` and the whole
 * intersection refused for having a member that "is not a record shape".
 * mongodb's `WithId<TSchema> = EnhancedOmit<TSchema, '_id'> & { _id:
 * InferIdType<TSchema> }` is the case, and it is a member of nearly every
 * collection type the driver declares.
 *
 * A member whose declaration a plugin binds to a NATIVE carrier is never
 * spliced: `deriveIntersection`'s own first rule says a host's name outranks
 * the structure it erases to, and splicing such a member would erase exactly
 * the name that rule exists to keep.
 *
 * The `seen` set is what makes this terminate on a self-referential alias
 * (`type Loop = Loop & { x: number }` is writable), and re-entering a member
 * already spliced contributes nothing new in any case.
 */
export const createIntersectionFlattener = (
  shapeOf: (id: StructuralTypeId) => StructuralShape | null,
  isNativeBound: (declaration: DeclarationId) => boolean
): ((members: readonly StructuralTypeId[], seen?: Set<StructuralTypeId>) => readonly StructuralTypeId[]) => {
  const flattenedIntersectionMembers = (
    members: readonly StructuralTypeId[],
    seen: Set<StructuralTypeId> = new Set()
  ): readonly StructuralTypeId[] =>
    members.flatMap((member) => {
      if (seen.has(member)) return []
      const shape = shapeOf(member)
      const declaration = shape?.kind === 'intersection' || shape?.kind === 'declared' ? shape.declaration : null
      if (declaration && isNativeBound(declaration)) return [member]
      const nested = shape?.kind === 'intersection' ? shape : shape?.kind === 'declared' && shape.body !== null ? shapeOf(shape.body) : null
      if (nested?.kind !== 'intersection') return [member]
      seen.add(member)
      return flattenedIntersectionMembers(nested.members, seen)
    })
  return flattenedIntersectionMembers
}

/**
 * The physical carrier for a property that TWO intersection members both
 * constrain, computed the way the language itself computes `A & B` for a
 * property present in both -- not by demanding the two members already
 * derived to the identical carrier.
 *
 * `A & B` means a value is BOTH, so for a shared key the correct type is
 * the intersection of the two members' property types, which TypeScript
 * already reduces on its own: `false & (boolean | undefined)` is `false`,
 * not a disagreement, because an intersection value has no `undefined`
 * arm left for it to be absent through once one member requires it
 * present. This deriver has no checker to ask
 * `getTypeOfPropertyOfType` directly (see this file's own module
 * comment: it reads nothing but the sealed structural table), so it
 * recovers the same reduction structurally: an `optional` carrier peels
 * to its `payload` exactly when that payload matches -- recursively --
 * the other member's own carrier for the same key, which is the
 * representation-level statement of "the other member proves this value
 * present". The merge loop below already tracks presence independently,
 * in the `RecordField`'s own `required` bit, so peeling never has to
 * touch it. Two carriers that do not reduce to one this way still refuse
 * by name below, exactly as before -- this recovers a real TypeScript
 * reduction, it does not relax the guard.
 */
export const intersectPropertyRepresentations = (a: Representation, b: Representation): Representation | null => {
  if (representationKey(a) === representationKey(b)) return a
  if (a.kind === 'optional') return intersectPropertyRepresentations(a.payload, b)
  if (b.kind === 'optional') return intersectPropertyRepresentations(a, b.payload)
  // A `tagged-union` is the same reduction one level up: `derive.ts`'s
  // `deriveUnion` builds one instead of an `optional` exactly when a
  // union carries BOTH absent values alongside a present arm (`T | null
  // | undefined`), per `model.ts`'s own comment on `optional`. Its arms
  // are proven pairwise disjoint, so at most one can ever match the
  // other member's own carrier -- peeling to that one arm is the same
  // "the other member proves which case is live" reduction as the
  // `optional` case above, just against more than one absent arm at
  // once (`null: PixelFormat_Options.internalFormat` reducing `null &
  // (PixelFormat | null | undefined)` to `null`).
  if (a.kind === 'tagged-union') {
    for (const arm of a.arms) {
      const reconciled = intersectPropertyRepresentations(arm.value, b)
      if (reconciled) return reconciled
    }
    return null
  }
  if (b.kind === 'tagged-union') {
    for (const arm of b.arms) {
      const reconciled = intersectPropertyRepresentations(a, arm.value)
      if (reconciled) return reconciled
    }
    return null
  }
  return null
}

/** Resolve a structural id to its shape; the deriver's own table lookup. */
type ShapeLookup = (id: StructuralTypeId) => StructuralShape | null

/**
 * What an intersection member that is not a record shape actually is.
 *
 * Purely diagnostic. The refusal names the member by id, which says nothing
 * about WHY it is not a record, and an id is a table index that cannot be
 * resolved back from a log. A declared name reports the kind of the body it
 * stands for, because "declared" on its own is never the answer -- the
 * interesting fact is what the declaration resolves to.
 */
export const intersectionMemberKindOf = (shapeOf: ShapeLookup, member: StructuralTypeId): string => {
  const shape = shapeOf(member)
  if (!shape) return 'no shape'
  if (shape.kind === 'literal') return `literal ${shape.primitive} ${shape.text}`
  if (shape.kind !== 'declared') return shape.kind
  if (!shape.body) return 'declared, no body'
  return `declared -> ${shapeOf(shape.body)?.kind ?? 'no shape'}`
}

/**
 * Whether a member is a PRIMITIVE VALUE -- one whose carrier is a scalar,
 * including a literal type, which is a scalar pinned to one value.
 *
 * Asked through the declared wrapper for the same reason the deriver's
 * nominal-class test is: an alias reaches the deriver as a `declared` shape
 * over the body it names.
 */
export const isPrimitiveValueShape = (shapeOf: ShapeLookup, member: StructuralTypeId): boolean => {
  const shape = shapeOf(member)
  if (!shape) return false
  if (shape.kind === 'primitive' || shape.kind === 'literal') return true
  if (shape.kind !== 'declared' || shape.body === null) return false
  const body = shapeOf(shape.body)?.kind
  return body === 'primitive' || body === 'literal'
}
