import type { StructuralTypeId } from '../identity/ids.js'
import type { StructuralShape } from '../semantics/model/structural-types.js'
import type { Representation } from './model.js'
import { representationKey } from './model.js'
import { unresolved } from './primitives.js'
import type { KeyedCollectionFamily, OwnershipPolicy } from './policies.js'

/**
 * The carrier for the language's four keyed collections.
 *
 * Its own module rather than a case inside `derive.ts` for the architecture
 * gate's 800-line ceiling, and it stays one function: `derive.ts`'s
 * `'declared'` case hands it the already-resolved family plus the two things
 * it cannot compute for itself -- the deriver's stored-position carrier (which
 * is recursive, and belongs to the deriver's own memo/cycle bookkeeping) and
 * the ownership policy.
 */

/**
 * Whether a carrier is physically a POINTER, so two values of it can be
 * compared by reference identity.
 *
 * The question a weak collection asks of its key, and the only honest way to
 * ask it here: `targets/cpp/types.ts`'s `cppOwnershipWrap` spells exactly
 * these kinds as `std::shared_ptr<...>` when their own ownership is
 * `shared-refcount`, and spells them as a bare value otherwise -- so the
 * ownership is as load-bearing as the kind. A `record` held `owned` is a
 * struct by value, and two copies of it are two objects with two addresses;
 * using one as a weak key would look up a different entry every time.
 * A tagged union qualifies only when every arm qualifies: its discriminant
 * selects one arm's pointer without changing that object's identity.
 *
 * Stated here rather than in `model.ts` beside `alwaysTruthyKinds` because it
 * is a fact about one BACKEND's spelling, and a target that carried these
 * kinds differently would need a different answer. It is enforced at
 * derivation rather than at emission for the ordinary fail-closed reason: a
 * `WeakMap<number, T>` has no correct lowering at all, so it must never reach
 * a certificate.
 */
export const hasReferenceIdentity = (representation: Representation): boolean => {
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => hasReferenceIdentity(arm.value))
  switch (representation.kind) {
    case 'class-ref':
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'array-object':
    case 'dictionary':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'keyed-collection':
      return representation.ownership === 'shared-refcount'
    // A `dynamic` key is admitted, and `gea::Value::identity()` is why: it is
    // the address of the held payload, which for an object-tagged box is
    // exactly the reference identity ECMA-262 asks for, shared by every box
    // of that same object. `weakKeySame<Value>` in `runtime/gea_runtime.h`
    // reads it. The divergence, stated rather than hidden: a box holding a
    // PRIMITIVE has a per-box address, so `weakMap.has(1)` answers `false`
    // where ECMA-262 24.3.3.3 throws a TypeError -- a wrong answer only for a
    // program that is already illegal, and the alternative was to refuse
    // `WeakMap<object, T>` outright, since `object` carries dynamically.
    case 'dynamic':
      return true
    default:
      return false
  }
}

/**
 * `Map<K, V>` / `Set<T>` / `WeakMap<K, V>` / `WeakSet<T>` over the concrete
 * key and value carriers, or a NAMED refusal.
 *
 * This is the port of v1's `typedJsCollectionCarrierRule`
 * (`compiler/packages/geatsc/src/targets/cpp/driver/type-carriers/typed-js-collections.ts`),
 * and it keeps that rule's three real decisions:
 *
 * - all-or-nothing over the type arguments, exactly like `records.ts` /
 *   `unions.ts` / `arrays.ts` there and `deriveTuple` here: one argument
 *   that proves no carrier refuses the whole collection rather than
 *   half-sealing it;
 * - the key is the strict position. It participates in the collection's own
 *   SameValueZero comparison, so a key with no proven equality has no
 *   proven lookup;
 * - a Set/WeakSet's element is a key, not a payload, and is held to the
 *   same standard.
 *
 * A `dynamic` key or value RESOLVES here, and that is deliberate. `dynamic`
 * is not a box over a static type -- `deriveStored` reaches it only for a
 * position the program itself declared `any`/`unknown` and never narrowed,
 * which is a genuine dynamic boundary and gets the real dynamic carrier. The
 * one thing that must never happen is the reverse: a key or value the program
 * DID give a type to must stay that type, and it does, because nothing here
 * widens. Refusing the declared-`any` case instead was measurably wrong --
 * `unresolved` is lattice bottom ("normalization could not name the shape"),
 * so stating it for a shape that is perfectly well named made every consumer
 * downstream fail closed on a carrier that had an answer; it accounted for
 * 107 of 133 unmet obligations in the reactive runtime on its own. The C++
 * side of admitting it is three explicit specializations in
 * `runtime/gea_runtime.h` -- `sameValueZero<Value>`, `canonicalKey<Value>`
 * and `weakKeySame<Value>` -- so a dynamic key is compared by the SAME
 * ECMA-262 rules a static one is, not by a looser stand-in.
 *
 * The type-argument COUNT is checked against the family rather than assumed:
 * a `Map` reached in its open generic form (the library's own declaration,
 * which has type PARAMETERS and no arguments) has nothing concrete to
 * specialize over, and mistaking that for a zero-argument instantiation is
 * how a carrier for "some Map" would get minted. Same guard as v1's
 * `checkerArguments.length !== TYPE_ARGUMENT_COUNT[family]`.
 */
export const deriveKeyedCollection = (
  family: KeyedCollectionFamily,
  shape: Extract<StructuralShape, { kind: 'declared' }>,
  /** The interned identity of `shape`, which the ownership policy is keyed by. */
  id: StructuralTypeId,
  /** The deriver's own stored-position carrier for one type id -- see `derive.ts`'s `deriveStored`. */
  deriveStored: (id: StructuralTypeId) => Representation,
  ownership: OwnershipPolicy
): Representation => {
  const pair = family === 'map' || family === 'weak-map'
  const expected = pair ? 2 : 1
  if (shape.typeArguments.length !== expected) {
    return unresolved(`${family} reached representation with ${shape.typeArguments.length} type argument(s) and needs exactly ${expected}`)
  }
  // `deriveStored`, not `derive`: both positions are STORED inside the
  // collection, so they take the same storage promotion every record field
  // and array element takes. v1 spelled this as its own
  // `typedJsCollectionMapValueCarrier`/`typedJsCollectionSetElementCarrier`
  // promotion for the identical reason (a record or callable held in a
  // collection has exactly one legal physical storage form).
  const key = deriveStored(shape.typeArguments[0]!)
  const value = pair ? deriveStored(shape.typeArguments[1]!) : null
  if (key.kind === 'unresolved') return unresolved(`a ${family} key carries no representation: ${key.reason}`)
  if (value?.kind === 'unresolved') return unresolved(`a ${family} value carries no representation: ${value.reason}`)
  // A weak collection's key must be a REFERENCE. ECMA-262 24.3/24.4 admit
  // only objects (and, since ES2023, unregistered symbols) as weak keys, and
  // this runtime's weak families compare keys by pointer identity -- so a
  // key carried by value (a `double`, a `std::string`) has no pointer to
  // compare and would silently become an ordinary equality map wearing the
  // weak name. See `gea::WeakMap` in `runtime/gea_runtime.h`.
  if ((family === 'weak-map' || family === 'weak-set') && !hasReferenceIdentity(key)) {
    return unresolved(
      `a ${family} key carried as "${representationKey(key)}" has no reference identity; ECMA-262 24.3/24.4 admit only ` +
        'objects as weak keys, and this runtime compares a weak key by pointer'
    )
  }
  return { kind: 'keyed-collection', family, key, value, ownership: ownership.forShape(shape, id) }
}
