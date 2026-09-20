import type { RecordField, Representation } from './model.js'
import type { RepresentationDeriver } from './derive.js'
import type { StructuralTypeId } from '../identity/ids.js'

/**
 * The own enumerable fields of a value whose key set a STATIC list can
 * reproduce exactly, or `null` when it cannot.
 *
 * This is a stronger question than "what fields does this shape have", and the
 * difference is the whole point: a caller that copies or enumerates a value key
 * by key is wrong if the runtime object has one key more than the list, so a
 * carrier that admits keys beyond its declared fields must answer `null` rather
 * than answer partially.
 *
 *  - A `record` carries its fields inline; a `class-ref` and a
 *    `native-record-ref` carry only a `shapeId` (`model.ts`), so their list
 *    comes from the deriver -- the same authority `targets/cpp/records.ts`
 *    builds the C++ struct body from, so the struct's members and this list
 *    cannot be two answers that merely agree today.
 *  - ACCESSORS are absent, and that is the language's rule rather than an
 *    omission: a class's `get x()` lives on the PROTOTYPE, so it is not an own
 *    property of the instance and `{ ...instance }` never copies it. `fields`
 *    and `accessors` are separate arrays on a `record` for exactly this reason
 *    (`recordFieldsOf`, derive.ts).
 *  - An INDEX signature answers `null`: `record-with-index` says the value may
 *    hold keys nothing declared, and a static unroll would copy the declared
 *    ones and silently drop the rest.
 *  - A HOST-stated struct (`native !== null`) answers `null` too. Its own
 *    enumerable properties are the host's to define; this compiler emits no
 *    definition for it and cannot know whether the C++ members it was told
 *    about are the JavaScript object's own keys.
 *
 * It lives in `representation/` because both the preflight key that decides
 * whether an object spread can be rendered and the emitter that renders it must
 * ask the identical question -- a spread preflight admits and the emitter then
 * reads a different field list for is the certify-then-crash both exist to
 * prevent.
 */
export const staticOwnFieldsOf = (deriver: RepresentationDeriver, representation: Representation): readonly RecordField[] | null => {
  if (representation.kind === 'record') return representation.fields
  if (representation.kind === 'record-with-index') return null
  const shapeId =
    representation.kind === 'class-ref'
      ? representation.shapeId
      : representation.kind === 'native-record-ref' && representation.native === null
        ? representation.shapeId
        : null
  if (shapeId === null) return null
  const carrier = deriver.layoutOf(shapeId as StructuralTypeId)
  return carrier.kind === 'record' ? carrier.fields : null
}

/**
 * How a field's PRESENCE is decided when something copies or enumerates the
 * object key by key.
 *
 *  - `unconditional`: no test is rendered. A required field is always there.
 *  - `flagged`: generated record storage carries a presence bit independent of
 *    the value member.  Keeping the two separate is what distinguishes `{}`
 *    from `{ key: undefined }`, including when the value carrier is itself an
 *    optional or a tagged union containing `undefined`.
 *  - `unprovable` remains part of the answer type for non-record storage. A
 *    generated `RecordField`, however, is never in that state: its `required`
 *    fact is represented physically by the paired bit rendered in
 *    `targets/cpp/records.ts`.
 */
export type FieldPresence = 'unconditional' | 'flagged' | 'unprovable'

export const fieldPresenceOf = (field: RecordField): FieldPresence => {
  if (field.required) return 'unconditional'
  return 'flagged'
}

/**
 * The members `Object.prototype` itself declares.
 *
 * Core ECMAScript rather than anything a host installs, named outright for the
 * same reason `semantics/host-protocols.ts` names `Generator`, `Map` and `Set`:
 * there is no table to read it from, and the list is fixed by the language.
 *
 * It exists because `in` walks the PROTOTYPE CHAIN. "This layout declares no
 * such field" proves the key is not an OWN property, which is a different
 * statement from "the operator answers false" -- `'toString' in o` is true for
 * every ordinary object. A key on this list is therefore left unproven rather
 * than answered: the true answer is very probably `true`, but a physical struct
 * has no prototype object for the question to be about, and claiming either
 * answer would be stating something this compiler has not modelled.
 */
export const objectPrototypeMemberNames: ReadonlySet<string> = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
])

/** What a layout can prove about one statically-written key: `[[HasProperty]]`'s answer, or that it has none. */
export type StaticKeyPresence = 'present' | 'flagged' | 'unprovable'

/**
 * Whether a statically-written key is a property of a value with this layout.
 *
 * Only PRESENCE is ever proven. A prototype can add keys and never removes
 * one, so "this layout has the field" settles the answer no matter what is
 * behind the value -- except for a key `Object.prototype` itself declares,
 * where an absent flag would still read `true` at runtime, so those are
 * excluded by name.
 *
 * ⛔ ABSENCE IS NOT PROVEN HERE, and the reason is measured rather than
 * cautious. An earlier version of this function answered `absent` when a
 * `record` (or a compiler-emitted `native-record-ref`) declared no such field,
 * reasoning that such a carrier is a plain struct with `Object.prototype`
 * behind it. It is -- and the answer was still wrong, because getting there
 * can SLICE. `test/fixtures/in-operator-class-through-interface.ts` is the case:
 * passing `new Box()` to a parameter typed as the interface `Shape` emits
 * `gea_record_type_8{v2->size}`, a fresh struct holding one field, so the
 * `Box`'s `describe` is gone at the boundary. `'describe' in shape` then
 * compiled to `false` where JavaScript answers `true` -- a program that
 * compiled, ran and returned the opposite of the language's answer, where
 * before it had simply refused. Proving absence needs a whole-program fact
 * (nothing converts a class instance into this shape), which is a real proof
 * this layer does not have and must not fake.
 */
export const staticKeyPresenceOf = (fields: readonly RecordField[] | null, key: string | null): StaticKeyPresence => {
  if (fields === null || key === null || objectPrototypeMemberNames.has(key)) return 'unprovable'
  const field = fields.find((candidate) => candidate.key === key)
  if (!field) return 'unprovable'
  const presence = fieldPresenceOf(field)
  return presence === 'unconditional' ? 'present' : presence === 'flagged' ? 'flagged' : 'unprovable'
}
