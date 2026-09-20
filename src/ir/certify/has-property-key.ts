import type { Representation } from '../../representation/model.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import type { StructuralTypeId } from '../../identity/ids.js'
import { staticKeyPresenceOf } from '../../representation/record-fields.js'

/**
 * The obligation key for `k in o`, ECMA-262 13.10.1's `[[HasProperty]]`.
 *
 * `in` is unlike the other computation forms in that neither operand alone
 * decides whether a backend can answer it. `'value' in descriptor` over a
 * closed struct is settled before the program runs; `k in descriptor` over the
 * same struct is not settled at all, because a C++ struct has no runtime key
 * table to consult; and `k in table` over a dictionary is a real lookup that
 * needs no static key. So the key names BOTH halves -- what the key operand is,
 * and what the receiver carries -- rather than the operator, which is always
 * the word `in` and therefore says nothing (the same reasoning
 * `runtime-helper-key.ts` already applies to `typeof`, whose old flat
 * `computation:in:in` spelling this replaces).
 *
 * Two narrowings matter and are folded into the receiver half here, following
 * `preflight/property-access.ts`'s own `native-record-ref(no-index-sidecar)`
 * precedent -- resolve the named shape through the one deriver this compilation
 * built, then state what was found:
 *
 * - `record(own-field)` -- the static key names a REQUIRED field of the
 *   receiver's own layout. A required field is present on every instance of
 *   that layout, so `in` is the constant `true`.
 * - `record(optional-field)` -- the static key names a field whose carrier
 *   states its own presence, so `in` is that flag. This proves the key IS
 *   there when the flag is set, which needs no prototype reasoning at all: a
 *   prototype can only ever add keys, never remove one.
 * - `record(sidecar)` -- an otherwise-unknown static key on a compiler-owned
 *   shared object. Its generated field dispatcher and identity-keyed expando
 *   table together answer the runtime own-property question; known prototype
 *   members are handled separately.
 * - `record(unproven)` -- everything else, and ABSENCE ALWAYS. `in` walks the
 *   prototype chain, so a key no layout names is not thereby missing:
 *   `'toString' in o` is `true` for every ordinary object, and a `class-ref`'s
 *   prototype carries the class's own methods. Even a plain struct is not
 *   enough, because getting a value into one can SLICE a class instance down
 *   to the declared fields -- see `staticKeyPresenceOf`'s own note and
 *   `test/fixtures/in-operator-class-through-interface.ts`, which is what a version
 *   of this that DID answer absence compiled to a wrong answer. Presence is
 *   proven; absence is not.
 */

/**
 * A resolved record layout answers only for a required own field. A
 * `record-with-index`'s open half is deliberately not claimed here either: its
 * dictionary sidecar really could answer. This field-only helper still leaves
 * the receiver unproven; `hasPropertyHelperKey` upgrades a compiler-owned
 * shared carrier to the exact runtime sidecar answer after prototype members
 * have been settled.
 */
export const recordAnswerFor = (layout: Representation, key: string | null): string => {
  const fields = layout.kind === 'record' || layout.kind === 'record-with-index' ? layout.fields : null
  const presence = staticKeyPresenceOf(fields, key)
  if (presence === 'present') return 'record(own-field)'
  return presence === 'flagged' ? 'record(optional-field)' : 'record(unproven)'
}

/**
 * The named-shape resolution `receiverLayoutOf` already applies to the
 * top-level receiver, applied again to a NESTED representation -- an
 * `optional`'s payload, in practice, since that is the one place a name gets
 * discovered a second layer in.
 */
export const resolvedLayoutOf = (representation: Representation, deriver: RepresentationDeriver): { readonly layout: Representation } => {
  if (representation.kind !== 'native-record-ref' && representation.kind !== 'class-ref') return { layout: representation }
  return { layout: deriver.layoutOf(representation.shapeId as StructuralTypeId) }
}

/** A compiler-owned object carrier whose shared identity can key the native dynamic-property sidecar. */
export const generatedSharedObjectCarrier = (representation: Representation): boolean => {
  if (representation.kind === 'record' || representation.kind === 'record-with-index' || representation.kind === 'class-ref') {
    return representation.ownership === 'shared-refcount'
  }
  return representation.kind === 'native-record-ref' && representation.native === null && representation.ownership === 'shared-refcount'
}

/**
 * A compiler-emitted record has an identity-keyed expando table even when the
 * key is only known at runtime.  Classes deliberately stay out of this
 * predicate: an arbitrary string can name an inherited program method, and
 * that prototype question is not recoverable from the record sidecar.
 */
export const generatedSharedRecordCarrier = (representation: Representation): boolean =>
  (representation.kind === 'record' || representation.kind === 'record-with-index') && representation.ownership === 'shared-refcount'

/** Any compiler-owned ordinary object carrier, including by-value records with no expando identity. */
export const generatedObjectCarrier = (representation: Representation): boolean =>
  representation.kind === 'record' ||
  representation.kind === 'record-with-index' ||
  representation.kind === 'class-ref' ||
  (representation.kind === 'native-record-ref' && representation.native === null)

/**
 * The `computation:in:*` answer suffix for one resolved layout, factored out
 * so `optional` can ask it of its own payload without a second copy of the
 * record/dictionary rules.
 *
 * `k in maybeNull` is answerable, and exactly as far as the payload's own
 * layout is: 13.10.1 throws a TypeError before `[[HasProperty]]` runs when
 * the receiver is absent (the language's own answer, rendered by
 * `emit-in.ts`), and when it is present the question is the identical one
 * this function already asks of any other receiver -- so a receiver the
 * checker left nullable is not a fourth case, it is the same three cases one
 * presence test away. Missing this left the fallback below leak the bare
 * word "optional" as the whole claim, which is never installed anywhere:
 * every `in` over a nullable receiver refused, even ones whose payload is a
 * required own field.
 */
export const layoutAnswerSuffix = (layout: Representation, key: string | null, deriver: RepresentationDeriver): string => {
  if (layout.kind === 'record' || layout.kind === 'record-with-index') return recordAnswerFor(layout, key)
  // A dictionary's KEY DOMAIN is part of the receiver half: `gea::Dictionary`
  // is keyed by `std::string` and `gea::NumericDictionary` by `double`, two
  // genuinely different containers (`types.ts`'s own note), so one claim
  // covering both would certify a string key against a numeric table.
  if (layout.kind === 'dictionary') return `dictionary(${layout.key})`
  if (layout.kind === 'optional') {
    return `optional(${layoutAnswerSuffix(resolvedLayoutOf(layout.payload, deriver).layout, key, deriver)})`
  }
  return layout.kind
}
