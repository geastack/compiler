import type { StructuralTypeId } from '../identity/ids.js'
import { primitiveDomainOf } from './primitive-domain.js'
import type { StructuralShape } from '../semantics/model/structural-types.js'
import type { Representation, TaggedUnionArm } from './model.js'
import { representationKey } from './model.js'
import { optionalOf } from './optional.js'
import { primitiveCarrier, storedCarrier, unresolved } from './primitives.js'

/**
 * What the deriver a union needs from the deriver that owns it.
 *
 * A union's carrier is built out of its members' carriers, so this cannot be a
 * free function: it has to ask the same memoized, cycle-guarded `derive` its
 * caller is in the middle of, or a self-referential union would re-derive its
 * own members forever. Handing those two answers in keeps the recursion the
 * owner's, and keeps this file from becoming a second deriver.
 */
export interface UnionDeriverContext {
  readonly shapeOf: (id: StructuralTypeId) => StructuralShape | null
  readonly derive: (id: StructuralTypeId) => Representation
  /** Whether no value can have this type -- the deriver's own answer, so an arm rule and the carrier rule agree. */
  readonly isNeverType: (id: StructuralTypeId) => boolean
}

/**
 * The carrier of a union type.
 *
 * Three answers, in order of how much the members prove: an `Optional<T>` when
 * exactly one arm is an absence value, the primitive itself when every arm is a
 * literal of one primitive, and a `TaggedUnion` otherwise -- discriminated by a
 * literal key the arms share when they have one, and by arm position when they
 * do not.
 */
export const createUnionDeriver = (
  context: UnionDeriverContext
): ((shape: Extract<StructuralShape, { kind: 'union' }>) => Representation) => {
  const { shapeOf, derive, isNeverType } = context

  /** The literal text discriminating each arm, when one member key does so. */
  const discriminantOf = (arms: readonly StructuralTypeId[]): { key: string; tags: readonly string[] } | null => {
    const shapes = arms.map(shapeOf)
    const objects = shapes.flatMap((shape) => (shape && shape.kind === 'object' ? [shape] : []))
    if (objects.length !== arms.length) return null
    const first = objects[0]
    if (!first) return null
    for (const member of first.members) {
      if (member.key.kind !== 'string' || member.optional) continue
      const key = member.key.value
      const tags: string[] = []
      for (const shape of objects) {
        const candidate = shape.members.find((other) => other.key.kind === 'string' && other.key.value === key)
        if (!candidate || candidate.optional) break
        const tagShape = shapeOf(candidate.type)
        if (!tagShape || tagShape.kind !== 'literal') break
        tags.push(tagShape.text)
      }
      // Distinct literals at one required key is what makes the arms provably
      // disjoint at runtime. Anything weaker would produce a union whose arms
      // cannot be told apart, which is a mis-selection, not a conservative one.
      if (tags.length === objects.length && new Set(tags).size === tags.length) return { key, tags }
    }
    return null
  }

  /** The carrier an arm holds -- the same `storedCarrier` rule `derive.ts` applies to every other stored position. */
  const deriveStored = (id: StructuralTypeId): Representation => storedCarrier(derive(id))

  /**
   * Runtime identity carried by a union arm in addition to its physical
   * payload.  A callable ABI is not an identity: unrelated functions may
   * share it, so only a checker-closed FunctionId set is executable evidence.
   */
  const runtimeDiscriminatorOf = (value: Representation): TaggedUnionArm['runtimeDiscriminator'] => {
    switch (value.kind) {
      case 'function':
        return { kind: 'callable-membership', members: [value.functionId] }
      case 'function-family':
      case 'function-value-family':
        return value.members.length > 0
          ? { kind: 'callable-membership', members: [...new Set(value.members)].sort() }
          : { kind: 'unverifiable-callable' }
      case 'function-value-dispatch':
      case 'function-and-constructor':
      case 'constructor-family':
      case 'constructor-value-dispatch':
      case 'generic-function-set':
        return { kind: 'unverifiable-callable' }
      case 'dynamic':
        // A broad Function value retains the already-dynamic box and claims
        // every callable.  The Function tag can distinguish it from a string,
        // number, object, etc.; it cannot distinguish it from another callable
        // arm, which boxDiscriminantsOfArm's pairwise collision check refuses.
        return value.reason === 'untyped-callable' ? { kind: 'callable-tag' } : { kind: 'carrier' }
      default:
        return { kind: 'carrier' }
    }
  }

  const armOf = (tag: string, value: Representation, semanticType: StructuralTypeId): TaggedUnionArm => ({
    tag,
    value,
    semanticType,
    runtimeDiscriminator: runtimeDiscriminatorOf(value)
  })

  // The deriver's own `isNeverType`, not a shape test of this file's own: an
  // arm can be uninhabited without SPELLING `never` -- `number & null`, the
  // arm a monomorphized copy makes of the checker's `T & null` (see
  // `derive.ts`'s `isUninhabitedPrimitiveIntersection`) -- and the carrier
  // rule and this arm rule must answer that from one place.
  const isNever = (id: StructuralTypeId): boolean => isNeverType(id)

  const deriveUnion = (shape: Extract<StructuralShape, { kind: 'union' }>): Representation => {
    // `never` contributes no arm. It is the empty type, so `T | never` is `T`
    // -- TypeScript's own union normalization says so, and the checker usually
    // applies it before this deriver ever sees the members. It does not always:
    // a generic default (`class Base<RootElement = never>`, then `RootElement |
    // null`) reaches here with the member still in place. Keeping it built an
    // arm out of a type that names no value, which then had to be given some
    // carrier -- and `null | never` came out as a sum of two absences, a
    // carrier one flag cannot discriminate, so a field that is plainly just
    // `null` was refused.
    const stated = [...new Set(shape.members)]
    const members = stated.filter((member) => !isNever(member))
    if (members.length === 0) return { kind: 'void' }
    const absent = members.filter((member) => absenceOf(member) !== null)
    const present = members.filter((member) => absenceOf(member) === null)
    // How many DISTINGUISHABLE absences the union states, not how many members
    // state one: `Response | void | undefined` states exactly one, because
    // `void` and `undefined` are the same stored value.
    const absences = new Set(absent.map((member) => absenceOf(member)))

    if (present.length === 0) {
      const only = absent[0]
      if (absent.length === 1 && only) return derive(only)
      // `null | undefined` is two distinguishable values, not one absence.
      if (absences.size === 1 && only) return deriveStored(only)
      return { kind: 'tagged-union', arms: absenceArms(absent) }
    }

    const payload = derivePresent(present)
    if (absent.length === 0) return payload
    const sole = absences.size === 1 ? [...absences][0] : null
    if (sole) return optionalOf(payload, sole)
    // Both absence values are present, so a single absence tag cannot encode
    // which one a value is; the sum keeps them apart. `payload` already
    // distinguishes every present arm on its own -- `derivePresent` builds a
    // tagged union of them whenever more than one exists -- so wrapping it
    // behind one `'present'` tag nests that distinction instead of
    // discarding it, exactly the way `optionalOf` above already nests a
    // multi-arm payload under a single absence flag. There is nothing special
    // about exactly one present arm: the construction below only ever needed
    // `payload` and `presentType`, both of which already exist for any
    // `present.length >= 1`.
    const presentType = present[0]
    if (presentType) {
      return { kind: 'tagged-union', arms: [...absenceArms(absent), armOf('present', payload, presentType)] }
    }
    return unresolved('no primitive for a union carrying both absence values alongside several present arms')
  }

  /**
   * Which absence a union member states, or `null` for a member that states a
   * value.
   *
   * `void` answers `'undefined'`, and that is the whole of what this adds over
   * reading the primitive directly. A stored `void` IS the `undefined`
   * carrier -- `storedCarrier` (`primitives.ts`) already says so, and says why
   * at length: `void` is a completed evaluation with no value, which is
   * exactly the value `undefined` names once anything KEEPS it. A union arm is
   * a stored position, so `T | void` and `T | undefined` are one carrier.
   *
   * They were two. `T | undefined` collapsed to `optional(T, undefined)` while
   * `T | void` became `tagged-union(undefined | T)`, and the two spellings met
   * at hono's `defineWebSocketHelper`: the handler slot is
   * `Response | void | Promise<Response | void>`, whose promise arm derived
   * `promise(tagged-union(undefined | class-ref(Response)))`, while the async
   * arrow the program passes returns `Promise<Response | undefined>` and
   * derived `promise(optional(class-ref(Response), undefined))`. One carrier,
   * two names, and therefore no conversion between them -- the
   * `CallExpression|1065` slot drift on `websocket.ts`.
   */
  const absenceOf = (id: StructuralTypeId): 'null' | 'undefined' | null => {
    const member = shapeOf(id)
    if (member?.kind !== 'primitive') return null
    if (member.primitive === 'null') return 'null'
    return member.primitive === 'undefined' || member.primitive === 'void' ? 'undefined' : null
  }

  const absenceArms = (absent: readonly StructuralTypeId[]): readonly TaggedUnionArm[] =>
    absent.flatMap((member): TaggedUnionArm[] => {
      const absence = absenceOf(member)
      if (absence === null) return []
      const value: Representation = absence === 'null' ? { kind: 'null' } : { kind: 'undefined' }
      return [armOf(absence, value, member)]
    })

  /**
   * The fallback carrier for a union whose arms share no literal discriminant.
   *
   * ECMAScript gives such a union -- `string | number`, or two record types
   * with disjoint keys -- no property to read that names which arm is live:
   * there is no discriminant to find because none exists, not because this
   * deriver failed to find one. The generic answer is still a sum, just tagged
   * by the arm's own position in this union's canonical member list instead of
   * by a literal the source published. That position is exactly the same
   * identity `discriminantOf`'s tags already use above, so this is the same
   * primitive with a compiler-assigned tag rather than a different one.
   *
   * Every arm must resolve on its own before it is admitted: embedding an
   * unresolved arm here would trade one honest `unresolved` union for a
   * tagged-union that only fails later, at `verify.ts`'s generic walk, instead
   * of naming its own gap where it occurred.
   */
  /**
   * One member per distinct carrier, in the order the union first states each.
   *
   * A member that does not resolve is kept rather than dropped: it has no
   * carrier to be equal to anything by, and removing it would silently shrink
   * the union. Whichever path consumes this list then reports that gap by name
   * -- `armIndexUnion` and the discriminated path both derive every member they
   * are handed -- instead of this collapse swallowing it.
   */
  const canonicalMembersOf = (present: readonly StructuralTypeId[]): readonly StructuralTypeId[] => {
    const byCarrier = new Map<string, StructuralTypeId>()
    const unresolvedMembers: StructuralTypeId[] = []
    for (const member of present) {
      const value = deriveStored(member)
      if (value.kind === 'unresolved') {
        unresolvedMembers.push(member)
        continue
      }
      const key = representationKey(value)
      if (!byCarrier.has(key)) byCarrier.set(key, member)
    }
    return [...withoutNominallySubsumed([...byCarrier.values()]), ...unresolvedMembers]
  }

  /**
   * A class-ref member an ANCESTOR of its own is also a member of carries
   * nothing the ancestor does not already carry, so it contributes no arm.
   *
   * This is the same rule one line up -- "members that derive to ONE carrier
   * are ONE arm" -- asked of a nominal family instead of a structural key. A
   * `Derived` allocation answers TRUE to the `Base` arm's nominal test as well
   * as its own (`classIdentityExtends` admits descendants, which is what lets a
   * `Derived` reach a `Base` slot at all), so `Base | Derived` built as a
   * two-arm sum is a sum whose arms are NOT pairwise disjoint: no runtime test
   * can say which is live, and picking by declaration order would put a
   * `Derived` in the `Base` arm on one path and its own on another. The
   * conversion algebra already refuses such a union by name
   * (`conversion/derive.ts`'s `classRefDomainsOverlap` check) -- correctly, but
   * the defect is here, where the undiscriminable sum was built.
   *
   * Collapsing loses no physical fact: `Base | Derived` and `Base` are one
   * `Ref<Base>` holding the same allocation, and the derived-only members stay
   * reachable exactly where TypeScript already requires them to be -- behind an
   * `instanceof`, whose narrowing is the checked class-family downcast this
   * backend already renders over a single base carrier.
   *
   * `@hono/node-server` reaches this through `request[incomingKey] as
   * IncomingMessage | Http2ServerRequest`, where the node shim's
   * `Http2ServerRequest extends IncomingMessage`.
   *
   * Ownership is part of the test: two carriers that disagree on it are two
   * different physical handles, and neither subsumes the other.
   */
  const withoutNominallySubsumed = (members: readonly StructuralTypeId[]): readonly StructuralTypeId[] => {
    const classRefs = members.map((member) => {
      const value = deriveStored(member)
      return value.kind === 'class-ref' ? value : null
    })
    if (classRefs.filter((value) => value !== null).length < 2) return members
    return members.filter((_, index) => {
      const value = classRefs[index]
      if (!value) return true
      return !classRefs.some(
        (other) => other !== null && other !== value && other.ownership === value.ownership && value.ancestors.includes(other.declaration)
      )
    })
  }

  const armIndexUnion = (present: readonly StructuralTypeId[]): Representation => {
    const arms: TaggedUnionArm[] = []
    for (const [position, member] of present.entries()) {
      const value = deriveStored(member)
      if (value.kind === 'unresolved') return unresolved(`no primitive for union arm ${member}: ${value.reason}`)
      arms.push(armOf(String(position), value, member))
    }
    return { kind: 'tagged-union', arms }
  }

  /** The carrier for the non-absent arms of a union. */
  const derivePresent = (present: readonly StructuralTypeId[]): Representation => {
    const only = present[0]
    if (present.length === 1 && only) return deriveStored(only)

    // A union of literals of one primitive is that primitive: the arms differ in
    // value, not in carrier, so a sum would add a tag that discriminates nothing.
    // `primitiveDomainOf` is the one authority for "these values are all this
    // primitive" -- `value-records.ts` asks it of a record's field.
    const primitives = new Set(present.map((member) => primitiveDomainOf(shapeOf(member))))
    if (primitives.size === 1 && !primitives.has(null)) {
      const [primitive] = [...primitives]
      const carrier = primitive ? primitiveCarrier(primitive) : null
      if (carrier) return carrier
    }

    // Members that derive to ONE carrier are ONE arm.
    //
    // `gea::TaggedUnion` is documented as "a sum whose arms are proven pairwise
    // disjoint at runtime", and two arms of the same carrier are not.
    // `OrientationLock | OrientationLock[]` is the shape that proves it: the
    // checker flattens it to seven string literals beside one array, the rule
    // above cannot fire because not every member is a literal, and tagging each
    // literal separately builds a union of seven identical `std::string` arms
    // whose discriminant no runtime test could ever set correctly -- seven arms
    // that read back the same bytes, distinguished only by an index nothing
    // observes. This is that same rule -- a union of literals of one primitive
    // IS that primitive -- applied to a union that is only PARTLY literals.
    //
    // The group's first member is the one cited as the arm's `semanticType`.
    // Every member of a group derives to the identical carrier, so every one of
    // them answers the arm's member census identically; which of them is named
    // changes no physical fact.
    const canonical = canonicalMembersOf(present)
    const single = canonical.length === 1 ? canonical[0] : undefined
    if (single) return deriveStored(single)

    const discriminant = discriminantOf(canonical)
    if (!discriminant) return armIndexUnion(canonical)
    const arms = canonical.flatMap((member, position): TaggedUnionArm[] => {
      const tag = discriminant.tags[position]
      if (tag === undefined) return []
      const value = deriveStored(member)
      return [armOf(tag, value, member)]
    })
    if (arms.length !== canonical.length) return unresolved('discriminant tag census did not cover every union arm')
    return { kind: 'tagged-union', arms }
  }

  return deriveUnion
}
