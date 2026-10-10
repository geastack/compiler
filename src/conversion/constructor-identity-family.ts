import type { DeclarationId } from '../identity/ids.js'
import { abiKey, representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'

/**
 * `x.constructor` -- a `constructor-identity`, the class evaluation `x` was
 * allocated by -- stored where a `constructor-family` is declared.
 *
 * A library may hand `this.searchParams.constructor as any` to a mixin
 * factory's `typeof URLSearchParams` parameter; `new (item.constructor as
 * typeof Shape)(...)` clones are the commoner shape. The
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
  readonly target: Extract<Representation, { kind: 'constructor-family' }>
  /** Each class the identity can be, and whether its construct thunk must be upcast into the family's result. */
  readonly members: readonly { readonly declaration: DeclarationId; readonly upcast: boolean }[]
}

/** One family member's construct entry into the family carrier -- see `constructorIdentityFamilyPlan`. */
const memberEntryOf = (
  target: Extract<Representation, { kind: 'constructor-family' }>,
  candidate: { readonly declaration: DeclarationId; readonly construct: CallableAbi | null }
): { declaration: DeclarationId; upcast: boolean } | null => {
  const result = target.abi.result
  if (result.kind !== 'class-ref' || candidate.construct === null) return null
  const built = candidate.construct.result
  if (built.kind !== 'class-ref' || built.ownership !== result.ownership) return null
  const same = representationKey(built) === representationKey(result)
  if (!same && !built.ancestors.includes(result.declaration)) return null
  if (abiKey({ ...candidate.construct, result }) !== abiKey(target.abi)) return null
  return { declaration: candidate.declaration, upcast: !same }
}

/**
 * A constructor carried by its convention alone -- `responseType?:
 * ResponseConstructor`, a structural construct signature -- read where the
 * checker names a class family: `(responseType ?? BaseResponse).make(bytes)`,
 * whose subtype reduction answers `typeof BaseResponse`.
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
  if (target.abi.receiver !== null || target.abi.result.kind !== 'class-ref' || target.members.length === 0) return null
  const members: { declaration: DeclarationId; upcast: boolean }[] = []
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
  if (source.kind !== 'constructor-identity' || target.kind !== 'constructor-family') return null
  if (target.abi.receiver !== null || target.abi.result.kind !== 'class-ref') return null
  const subtree = layouts.classSubtreeOf?.(source.declaration) ?? null
  if (subtree === null || subtree.length === 0) return null
  const members: { declaration: DeclarationId; upcast: boolean }[] = []
  for (const candidate of subtree) {
    if (!target.members.includes(candidate.declaration)) return null
    const entry = memberEntryOf(target, candidate)
    if (entry === null) return null
    members.push(entry)
  }
  return { target, members }
}
