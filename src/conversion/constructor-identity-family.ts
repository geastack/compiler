import type { DeclarationId } from '../identity/ids.js'
import { abiKey, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'

/**
 * `x.constructor` -- a `constructor-identity`, the class evaluation `x` was
 * allocated by -- stored where a `constructor-family`, or a union of them
 * (`unionEntryOf`), is declared.
 *
 * `mongodb-connection-string-url` hands `this.searchParams.constructor as
 * any` to its mixin factory's `typeof URLSearchParams` parameter; `new
 * (item.constructor as typeof Shape)(...)` clones are the commoner shape. The
 * identity names a class and every class that extends it; the family names a
 * closed set of classes with one construct convention. The store is exact
 * when every class the identity can be -- each class of the table in that
 * subtree that some evaluation reaches and can instantiate -- is a family
 * member whose own `new` takes the family's parameters and builds a class
 * the family's result reaches. `semantics/constructor-slot-subclasses.ts`
 * records such a store as a write of each of those classes into the slot, so
 * the family derives with all of them.
 *
 * The member is chosen at run time by the evaluation's own declaration tag;
 * the environment is that evaluation, so `===` against the class still holds.
 */
export interface ConstructorIdentityFamilyPlan {
  readonly target: Extract<Representation, { kind: 'constructor-family' | 'tagged-union' }>
  /**
   * Each class the identity can be, the family it is stored as, whether its
   * construct thunk must be upcast into that family's result, and, under a
   * union target, the arm that family is.
   */
  readonly members: readonly ConstructorFamilyEntry[]
}

export interface ConstructorFamilyEntry {
  readonly declaration: DeclarationId
  readonly upcast: boolean
  readonly family: Extract<Representation, { kind: 'constructor-family' }>
  readonly arm: number | null
}

/** One family member's construct entry into the family carrier -- see `constructorIdentityFamilyPlan`. */
const memberEntryOf = (
  target: Extract<Representation, { kind: 'constructor-family' }>,
  candidate: { readonly declaration: DeclarationId; readonly construct: CallableAbi | null }
): ConstructorFamilyEntry | null => {
  const result = target.abi.result
  if (target.abi.receiver !== null || result.kind !== 'class-ref' || candidate.construct === null) return null
  const built = candidate.construct.result
  if (built.kind !== 'class-ref' || built.ownership !== result.ownership) return null
  const same = representationKey(built) === representationKey(result)
  if (!same && !built.ancestors.includes(result.declaration)) return null
  if (abiKey({ ...candidate.construct, result }) !== abiKey(target.abi)) return null
  return { declaration: candidate.declaration, upcast: !same, family: target, arm: null }
}

/**
 * A constructor carried by its convention alone -- `responseType?:
 * MongoDBResponseConstructor`, a structural construct signature -- read where
 * the checker names a class family: `(responseType ?? MongoDBResponse).make(
 * bson)`, whose subtype reduction answers `typeof MongoDBResponse`.
 *
 * Unlike `x.constructor`, nothing proves which classes the value can be: the
 * slot admits any constructor with that convention. So the conversion is a
 * CHECKED projection, not an exact store. The value's own environment is a
 * class evaluation stamped with its declaration token (or a host constructor's,
 * stamped with none); a token naming a family member installs that member's
 * construct thunk over the same environment -- so `===` and every static read
 * still see the same class -- and any other constructor is refused by name at
 * the conversion, never constructed through another class's body.
 */
export const constructorDispatchFamilyPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation
): ConstructorIdentityFamilyPlan | null => {
  if (source.kind !== 'constructor-value-dispatch' || target.kind !== 'constructor-family') return null
  if (target.members.length === 0) return null
  const members: ConstructorFamilyEntry[] = []
  for (const member of target.members) {
    const candidate = layouts.classSubtreeOf?.(member)?.find((entry) => entry.declaration === member)
    if (candidate === undefined) return null
    const entry = memberEntryOf(target, candidate)
    if (entry === null) return null
    members.push(entry)
  }
  return { target, members }
}

export const constructorIdentityFamilyPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation
): ConstructorIdentityFamilyPlan | null => {
  if (source.kind !== 'constructor-identity' || (target.kind !== 'constructor-family' && target.kind !== 'tagged-union')) return null
  const subtree = layouts.classSubtreeOf?.(source.declaration) ?? null
  if (subtree === null || subtree.length === 0) return null
  const members: ConstructorFamilyEntry[] = []
  for (const candidate of subtree) {
    const entry = target.kind === 'tagged-union' ? unionEntryOf(target, candidate) : familyEntryOf(target, candidate)
    if (entry === null) return null
    members.push(entry)
  }
  return { target, members }
}

const familyEntryOf = (
  target: Extract<Representation, { kind: 'constructor-family' }>,
  candidate: { readonly declaration: DeclarationId; readonly construct: CallableAbi | null }
): ConstructorFamilyEntry | null => (target.members.includes(candidate.declaration) ? memberEntryOf(target, candidate) : null)

/**
 * The arm of a union of class families a class is stored in: three's
 * LightsNode looks a light's node class up by `light.constructor` under
 * NodeLibrary's `typeof Light | typeof PointLight | ...` key. A class two arms
 * admit -- `typeof Light` names every light class stored into it as its
 * subclass, `typeof PointLight` names `PointLight` -- goes to the arm whose
 * family builds the most derived class, its own where the union names it, so
 * it is the arm a direct store of the class selects. Arms whose results are
 * unrelated have no such choice, and the conversion is refused.
 */
const unionEntryOf = (
  target: Extract<Representation, { kind: 'tagged-union' }>,
  candidate: { readonly declaration: DeclarationId; readonly construct: CallableAbi | null }
): ConstructorFamilyEntry | null => {
  const entries = target.arms.flatMap((arm, index) => {
    const entry = arm.value.kind === 'constructor-family' ? familyEntryOf(arm.value, candidate) : null
    return entry === null ? [] : [{ ...entry, arm: index }]
  })
  const builds = (entry: ConstructorFamilyEntry) => entry.family.abi.result as Extract<Representation, { kind: 'class-ref' }>
  const nearest = entries.filter((entry) =>
    entries.every((other) => other === entry || builds(entry).ancestors.includes(builds(other).declaration))
  )
  return nearest.length === 1 ? nearest[0]! : null
}
