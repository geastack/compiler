import { isNativeCallableCarrier, ownershipOfGeneratedCarrier, propertyKeyText } from '../emit-dynamic-properties.js'
import { intrinsicMemberValueOf } from './emit-host-object.js'
import { objectShapePrototypeMethods } from '../../../projection/callee.js'
import type { RecordField, Representation } from '../../../representation/model.js'
import { representationKey } from '../../../representation/model.js'
import type { GetOperation, IrOperand } from '../../../ir/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext, type PrototypeMethodRead } from '../emit-context.js'
import type { IrValueId } from '../../../identity/ids.js'
import { classMemberOf, lazyArrowFieldPlanOf, lazyMaterializedFieldText } from '../class-layout.js'
import { alignedValueText, widenedStoreText } from '../emit-narrowing.js'
import { memberAccessOperator } from '../emit-carrier-members.js'
import { declaredFieldRepresentationOf, enumerationOrdered, recordFieldsOfShape } from '../records.js'
import {
  cppRecordFieldAttributesName,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppStringLiteral,
  cppTypeOf
} from '../types.js'

/**
 * The object primitives every `Object` static is defined in terms of.
 *
 * ECMA-262 does not define ten independent operations. It defines three --
 * `[[OwnPropertyKeys]]` filtered by `[[Enumerable]]`, `Get(o, key)` and
 * `Set(o, key, v)` -- and then writes each static as a loop over them.
 * `Object.assign` is the clearest case (7.3.25 is literally "for each own
 * enumerable key of source: Set(target, key, Get(source, key))"), but
 * `Object.keys`, `values`, `entries`, `hasOwn` and `fromEntries` are the same
 * three in different arrangements, and so are `{...spread}`, rest
 * destructuring, `for...in` and `JSON.stringify` of a plain object.
 *
 * So this file states the three once and `emit-host-object.ts` spells each
 * member as the loop it is. The alternative -- which is what was here before
 * -- is ten renderers that each rediscover the receiver question, agree on the
 * refusal (`refuseObjectCarrier` was already shared) and disagree on
 * everything else: `keys` and `values` grew a static arm, `entries`, `assign`
 * and `defineProperty` refused every known shape outright, and the refusal
 * they printed explained enumeration even when the member was not enumerating
 * anything. `Object.assign(this, opts)` in hono's own constructor refused with
 * "a class instance's own enumerable keys are the fields its constructor
 * actually assigned" -- a true sentence about the SOURCE position, printed for
 * a failure in the TARGET position, where nothing enumerates the class at all.
 *
 * ## The two arms
 *
 * Each primitive has a static arm and a dynamic one, and neither is the
 * other's fallback.
 *
 * The static arm renders against a carrier whose fields the checker knows. The
 * key list is a compile-time constant, `Get` is a struct member read and `Set`
 * is a struct member store -- the loop is unrolled at emission because its
 * bounds are known, which is the same move `Object.values` already made when
 * it emitted a braced `std::vector` rather than a runtime walk.
 *
 * The dynamic arm renders against a value the program itself declared `any`.
 * There the loop belongs to the runtime, because its bounds are only known
 * there, and `gea::host::ObjectConstructor` states each member as one call.
 *
 * ## The third arm, which is not this file's
 *
 * Every struct this backend emits also carries the three primitives as
 * methods: `gea_ownFieldKeys`, `gea_readOwnField` and `gea_writeOwnField`
 * (`records.ts`'s `renderFieldDispatcher`). That is the same three operations
 * for the case where the OBJECT is statically known and the KEY is not, and it
 * shares this file's enumeration order through `enumerationOrdered` so the two
 * cannot answer a different key sequence for one struct. Nothing here calls
 * it: when the key is known too, a direct member access is what the dispatcher
 * would find anyway, without the round trip through `gea::Value` it takes to
 * carry a field past a `PropertyKey`.
 */

/** Whether a carrier is the genuine dynamic boundary these renderers walk a real table for. */
export const isDynamicCarrier = (representation: Representation): boolean => representation.kind === 'dynamic'

export const refuseObjectCarrier = (member: string, representation: Representation, detail: string): never => {
  // `Object.*` renders through this file's own [[OwnPropertyKeys]]/Get/Set
  // primitives, never through the (unreached) `own-property-keys` IR op, so
  // whether a carrier admits one of these statics is a target RULE over the
  // call -- the same shape as Atomics/JSON/Reflect's own `host-member-call`.
  throw createCppEmitBlockedError(
    `host-member-call:ObjectConstructor.${member}`,
    `"Object.${member}" of a "${representationKey(representation)}" carrier has no rendering: ${detail}`
  )
}

/**
 * A receiver whose own properties this file can name, or the dynamic object
 * whose table the runtime walks.
 *
 * `fields` is the static arm's whole subject: the key list, the read and the
 * store all come from it. `receiver`/`accessor` are how a field of it is
 * spelled, which differs by ownership and not by carrier kind -- a `record`, a
 * `native-record-ref` and a `class-ref` are all struct members behind either
 * `.` or `->`.
 */
export type ObjectView =
  | {
      readonly kind: 'known'
      readonly representation: Representation
      readonly fields: readonly RecordField[]
      readonly receiver: string
      readonly accessor: string
    }
  | { readonly kind: 'dynamic'; readonly receiver: string }
  /**
   * A `gea::Dictionary<V>` receiver -- the THIRD shape with a real
   * own-property enumeration, and the one this family used to refuse by name.
   *
   * That refusal read "gea::Dictionary is a std::map, so its keys are sorted
   * rather than kept in creation order", and it stopped being true when the
   * container was reimplemented as a `std::deque` of entries in creation order
   * with a position index beside it. The runtime states 10.1.11 order on the
   * container itself (`Dictionary::propertyKeys`, whose own comment points at
   * this file's refusal as the gap it was waiting for), so a dictionary
   * enumerates exactly as soundly as a record does -- and unlike a record it
   * needs no field list, because the keys are the table's runtime contents.
   *
   * `receiver` is already dereferenced to the table itself: every member here
   * passes it to a runtime overload taking `const gea::Dictionary<V>&`, and
   * whether the carrier held it behind a `gea::Ref` is not their question.
   */
  | {
      readonly kind: 'dictionary'
      readonly representation: Extract<Representation, { kind: 'dictionary' }>
      readonly receiver: string
      readonly value: Representation
    }

/**
 * A known shape's own field list, whichever way the carrier names it.
 *
 * A `record` carries its fields inline; a `native-record-ref` and a
 * `class-ref` carry a `shapeId` and nothing else (`representation/model.ts`),
 * so their list comes from `recordFieldsOfShape` -- the SAME authority
 * `cppRecordDeclarations` builds the struct body from. That identity is the
 * point: the C++ struct's members and the key list this enumerates have to be
 * one answer, and asking the deriver is what makes them one rather than two
 * that agree today.
 *
 * `native !== null` returns nothing on purpose. A host-stated struct's own
 * enumerable properties are the host's to define -- this compiler emits no
 * definition for it and cannot know whether the C++ members it was told about
 * are the JavaScript object's own keys -- so it refuses rather than reporting
 * a member list as a key list.
 */
const knownShapeFieldsOf = (ctx: EmitContext, representation: Representation): readonly RecordField[] | null => {
  if (representation.kind === 'record' || representation.kind === 'record-with-index') return representation.fields
  if (representation.kind === 'class-ref') return recordFieldsOfShape(ctx.deriver, representation.shapeId)
  if (representation.kind !== 'native-record-ref' || representation.native !== null) return null
  return recordFieldsOfShape(ctx.deriver, representation.shapeId)
}

/**
 * The refusal every member shares for a receiver that is neither a known shape
 * nor a declared dynamic value.
 *
 * Stated once so the ten members cannot drift into ten different explanations
 * of the same fact, and phrased as what is missing rather than as what was
 * asked -- a `dictionary` receiver is a gap in the container, not in the call.
 *
 * `position` names which of the call's objects failed, because these members
 * take more than one and a refusal that does not say which is a report nobody
 * can act on: `Object.assign(target, source)` refusing "of a class-ref
 * carrier" left a reader to guess whether the class was the thing being
 * enumerated or the thing being written into, and those have different cures.
 */
export const refuseObjectReceiver = (member: string, representation: Representation, position: string): never => {
  const at = position === '' ? '' : ` (the ${position})`
  // Every `dictionary` -- string-, number- and symbol-keyed alike -- gets a
  // view of its own from `objectViewFrom` and never reaches this function; a
  // member with no arm written for one refuses through `refuseDictionaryArm`
  // instead, which is the "sound but unwritten" channel and not this one.
  if (representation.kind === 'record-with-index') {
    return refuseObjectCarrier(
      member,
      representation,
      `the shape${at} carries named fields AND an index-signature sidecar, so its own keys are two lists that have to be ` +
        'interleaved in one creation order -- which neither half records, and picking either order would be a guess'
    )
  }
  if (representation.kind === 'native-record-ref' && representation.native !== null) {
    return refuseObjectCarrier(
      member,
      representation,
      `the struct${at} is the host's own ("${representation.native}"), so which of its C++ members are the JavaScript ` +
        "object's own enumerable keys is the host's to state and this compiler emits no definition for it"
    )
  }
  if (representation.kind === 'native-record-ref' || representation.kind === 'class-ref') {
    return refuseObjectCarrier(
      member,
      representation,
      `the shape "${representation.shapeId}"${at} derives no record layout, so there is no field list to enumerate -- ` +
        'the carrier it does derive is what says why'
    )
  }
  if (isNativeCallableCarrier(representation.kind)) {
    // A Function object DOES have an own-property table -- its identity's, the
    // one `callableDynamicGet`/`callableDynamicSet` already read and write --
    // so this is `refuseDictionaryArm`'s kind of gap: the carrier can carry the
    // operation and this member's arm for it is missing. Enumerating one is the
    // half nobody has written: `name`, `length` and `prototype` are installed
    // lazily by the runtime rather than being present from the start, so a key
    // list taken off the table today would report a different set depending on
    // what the program had already read.
    return refuseObjectCarrier(
      member,
      representation,
      `a Function object's own properties${at} live in its identity-owned table, which "Object.assign" writes into and this ` +
        'member has no arm for -- enumerating one additionally needs the lazily installed name/length/prototype facts to be ' +
        'materialised first, which nothing here does'
    )
  }
  return refuseObjectCarrier(
    member,
    representation,
    `only a record (whose fields the checker already knows) and a value the program itself declared dynamic have an ` +
      `own-property enumeration; nothing else${at} carries one, and inventing one would answer for a value that has no properties at all`
  )
}

/** The caller supplies the value produced by its certified conversion. */
export const setOwnCallableText = (receiver: string, key: string, value: string): string =>
  `gea::callableDynamicSet(${receiver}, gea::PropertyKey::string(${cppStringLiteral(key)}), ${value});`

/**
 * The receiver question, answered once.
 *
 * Every member of this family asks it and none of them may answer it
 * differently, which is the reason this returns a view rather than a boolean:
 * a member that tested `isDynamic` itself and then re-derived the field list
 * is two answers to one question, and that is how `assign` came to refuse a
 * shape `keys` renders.
 */
export const objectViewOf = (ctx: EmitContext, member: string, operand: IrOperand, position: string): ObjectView =>
  objectViewFrom(ctx, member, operand.representation, operandText(ctx, operand), position)

/**
 * The same question asked of a carrier and a spelling rather than an operand,
 * for the one caller that has neither: a TAGGED UNION receiver is enumerated
 * arm by arm (`emit-host-object.ts`'s `overCarrier`), and an arm is a
 * representation plus a `get<N>()` text, never an operand of its own.
 */
export const objectViewFrom = (
  ctx: EmitContext,
  member: string,
  representation: Representation,
  receiver: string,
  position: string
): ObjectView => {
  // `Object.getOwnPropertyDescriptor` (and every other call that mints
  // `T | undefined`) hands its own result STRAIGHT to a later `Object.*`
  // call -- `Object.getOwnPropertyNames(d)`, `hasOwnProperty.call(d, ...)` --
  // with no narrowing in between, since TypeScript's own ambient signatures
  // type the parameter as a bare object and `@ts-nocheck` (or a real type
  // error nobody who writes this pattern actually hits, because the value is
  // never really absent at that call site) suppresses the mismatch. A
  // property ACCESS already unwraps this the same way (`emit-context.ts`'s
  // `assertPresence`); this is that identical deref-or-throw, spelled as one
  // EXPRESSION rather than a statement, because this function hands back a
  // receiver TEXT with no statement list to push into. Recursing after the
  // unwrap means every arm below -- known, dynamic, dictionary -- sees the
  // PAYLOAD's own representation, never the optional wrapper.
  if (representation.kind === 'optional') {
    const payload = representation.payload
    const unwrapped = `(${receiver}.has_value() ? *${receiver} : gea::host::throwGetPropertyOfNullish<${cppTypeOf(payload)}>())`
    return objectViewFrom(ctx, member, payload, unwrapped, position)
  }
  if (isDynamicCarrier(representation)) return { kind: 'dynamic', receiver }
  if (representation.kind === 'dictionary') {
    // Dereferenced here, once: the runtime overloads take the table by
    // reference and a `shared-refcount` dictionary is held behind a `gea::Ref`.
    //
    // A NUMBER-keyed table is admitted here too, alongside string and symbol:
    // `gea::NumericDictionary<V>` stores each entry under its canonical
    // `Number::toString` spelling (`canonicalKey`, gea_runtime.h) the moment it
    // is written, via the SAME spec-correct `gea::host::detail::toString(double)`
    // this backend already uses for template-literal number interpolation --
    // 1e21, -0 and NaN included. So its own keys are exactly as sound to
    // enumerate as a string-keyed table's; there is no unrenderable spelling
    // left to refuse. What each MEMBER still needs is its own runtime overload
    // over `NumericDictionary<V>` (`ownEnumerableKeysText`/`valuesOfView`/
    // `entriesOfView` below) -- a member with none yet refuses through
    // `refuseDictionaryArm`, the "sound but unwritten" channel, rather than
    // through this file no longer being able to see the table at all.
    const table = memberAccessOperator(representation.ownership) === '->' ? `(*${receiver})` : receiver
    return { kind: 'dictionary', representation, receiver: table, value: representation.value }
  }
  const fields = knownShapeFieldsOf(ctx, representation)
  if (fields === null) return refuseObjectReceiver(member, representation, position)
  // Ownership rather than carrier kind decides `.` against `->`: the three
  // kinds `knownShapeFieldsOf` admits are all struct members, and only how the
  // struct is held differs between them.
  return { kind: 'known', representation, fields, receiver, accessor: memberAccessOperator(ownershipOfGeneratedCarrier(representation)) }
}

/**
 * The refusal for a member that HAS a sound dictionary rendering nobody has
 * written yet, stated by name.
 *
 * Kept apart from `refuseObjectReceiver` for the reason this file's header
 * gives about `freeze` and `defineProperty`: "this carrier cannot be
 * enumerated" and "this carrier can, and this member's arm for it is missing"
 * are different facts with different cures, and reporting the second as the
 * first sends a reader to the wrong one.
 */
export const refuseDictionaryArm = (member: string, view: Extract<ObjectView, { kind: 'dictionary' }>, detail: string): never =>
  refuseObjectCarrier(member, view.representation, `the receiver is a dictionary, whose own keys this backend CAN enumerate -- ${detail}`)

/** The C++ that names one field of a known view, with no unwrapping of any kind. */
const fieldText = (view: Extract<ObjectView, { kind: 'known' }>, field: RecordField): string =>
  `${view.receiver}${view.accessor}${cppRecordFieldName(field.key)}`

/**
 * PRIMITIVE 1a -- `[[Enumerable]]`: whether this field is an own key at all,
 * as C++ that answers at run time, or `null` when it statically is one.
 *
 * A field the declaration makes OPTIONAL is not statically present: `{ a: 1 }`
 * typed `{ a: number; b?: number }` has one own key, not two, and treating a
 * fixed list of both as the key set would report a property that is not there.
 * So an optional field answers from the independent presence bit emitted next
 * to its value. This remains exact for `undefined`, `null`, and dynamic value
 * carriers because none of those values doubles as property absence.
 */
export const ownKeyPresenceText = (member: string, view: Extract<ObjectView, { kind: 'known' }>, field: RecordField): string | null => {
  void member
  // A required TypeScript member starts present, but is still an ordinary
  // configurable data property until its descriptor says otherwise. Every
  // generated fixed field consequently has a physical bit; returning `null`
  // here would make a deleted required key reappear in Object.keys/hasOwn.
  return `${view.receiver}${view.accessor}${cppRecordFieldPresenceName(field.key)}`
}

/**
 * PRIMITIVE 1 -- `[[OwnPropertyKeys]]`, filtered to own enumerable string keys.
 *
 * ECMA-262 10.1.11.1 order, from the same authority the emitted struct's own
 * `gea_ownFieldKeys` uses (`enumerationOrdered`) -- two lists of one object's
 * own keys that could disagree is exactly the shape this compiler keeps
 * finding. A view whose fields are all statically present renders as a flat
 * constant; one with an optional field renders as the push loop, with the
 * optionals IN PLACE rather than appended after the required ones, since a
 * present optional occupies its own creation position.
 */
/** A known view's fields in enumeration order -- the one place that order is decided, so a member's keys and its values cannot disagree about it. */
export const ownKeyFields = (view: Extract<ObjectView, { kind: 'known' }>): readonly RecordField[] =>
  enumerationOrdered(view.fields, (field) => field.key)

export const ownEnumerableKeysText = (member: string, view: ObjectView, dynamicCall: string): string => {
  if (view.kind === 'dynamic') return `gea::host::ObjectConstructor::${dynamicCall}(${view.receiver})`
  // `keys` (7.3.23) and `getOwnPropertyNames` (10.1.11) are two calls over a
  // dictionary, and were one until the table could hold a non-enumerable key.
  // Their whole difference IS such a key, so while `Object.defineProperty` on
  // a dictionary could not retain one the two sequences were identical and
  // this arm answered both with the enumerable list -- correct then, and a
  // silently short `getOwnPropertyNames` the moment a table has one. Every
  // other carrier in `keysText` already splits on the member for this reason.
  if (view.kind === 'dictionary') {
    // Object.keys/getOwnPropertyNames are string-only. A SymbolDictionary has
    // real own keys, but none in this projection; returning an empty native
    // array preserves them for symbol-aware operations instead of converting
    // their descriptions into strings.
    if (view.representation.key === 'symbol') return 'gea::host::ObjectConstructor::staticKeys({})'
    return `gea::host::ObjectConstructor::${member === 'keys' ? 'keysOf' : 'ownPropertyNamesOf'}(${view.receiver})`
  }
  const ownership = ownershipOfGeneratedCarrier(view.representation)
  // Every generated shared object can acquire own properties through a
  // dynamic view. The runtime owns the complete enumeration because it joins
  // the struct dispatcher with that object's identity-keyed expando table;
  // emitting only the compile-time field list would make Object.keys disagree
  // with the reads and writes that already use the same sidecar.
  if (ownership === 'shared-refcount') {
    if (member === 'getOwnPropertyNames') {
      // This is intentionally a runtime-owned merge: generated slots and the
      // identity sidecar must be globally ordered before symbols are filtered.
      return `gea::host::ObjectConstructor::staticKeys(gea::nativeOwnPropertyNames(${view.receiver}))`
    }
    return `gea::host::ObjectConstructor::staticKeys(gea::nativeDynamicKeys(${view.receiver}))`
  }
  const ordered = ownKeyFields(view)
  const presences = ordered.map((field) => {
    const present = ownKeyPresenceText(member, view, field)
    const enumerable = `${view.receiver}${view.accessor}${cppRecordFieldAttributesName(field.key)}.enumerable`
    return { field, presence: present === null ? enumerable : `(${present} && ${enumerable})` }
  })
  const pushes = presences.map(({ field, presence }) => {
    const literal = cppStringLiteral(field.key)
    const push = `__gea_keys.push_back(${literal});`
    return `if (${presence}) ${push}`
  })
  return `([&]() { std::vector<std::string> __gea_keys; ${pushes.join(' ')} return gea::host::ObjectConstructor::staticKeys(__gea_keys); })()`
}

/**
 * PRIMITIVE 2 -- `Get(o, key)` for one own key of a known view.
 *
 * Presence is stored separately, so the field's value carrier comes through
 * unchanged. In particular, a present `undefined` stays `undefined`; it is not
 * unwrapped or confused with the missing-key state.
 *
 * There is no dynamic arm. A per-key get on a value the runtime owns is a
 * `gea::runtime::object::get` call, and no member here needs one: the dynamic
 * arm of every member in this family expresses its whole loop as a single
 * runtime call, so the iteration and the get stay on the same side.
 */
export const getOwnValue = (
  ctx: EmitContext,
  view: Extract<ObjectView, { kind: 'known' }>,
  field: RecordField
): { readonly text: string; readonly representation: Representation } => {
  const raw = fieldText(view, field)
  // A qualifying arrow-function class field's storage starts empty
  // (`class-layout.ts`'s `censusLazyArrowFields`) until something reads it.
  // `emit-properties.ts`'s ordinary property `get` is the choke point for a
  // normal access, but this function is the SAME choke point for every
  // `Object.*` static built out of it (`values`, `entries`, `assign`, spread,
  // `getOwnPropertyDescriptor`'s literal-key arm) -- each of those reads this
  // field's CURRENT value too, through this door instead, and would otherwise
  // hand back the empty sentinel a fresh instance starts with rather than the
  // real callable. `classMemberOf`'s owner is the DECLARING class, exactly as
  // `emit-properties.ts`'s own version of this lookup requires for an
  // inherited field.
  const site = view.representation.kind === 'class-ref' ? classMemberOf(ctx.classes, view.representation.declaration, field.key) : null
  const plan = site?.kind === 'field' ? lazyArrowFieldPlanOf(ctx.classes, site.owner, field.key) : null
  const text = plan === null ? raw : lazyMaterializedFieldText(view.receiver, view.accessor, field.key, plan)
  return { text, representation: field.value }
}

/**
 * Why a known target has no home for a key, in the target's own terms.
 *
 * A class says more about this than a record can: `classMemberOf` distinguishes
 * a key that resolves to an accessor (real storage exists, behind a call this
 * does not make), a method (on the prototype, never an own property), a class
 * whose members nothing published (a gap upstream, not a missing property) and
 * a key the chain genuinely does not declare. Collapsing those into one
 * "no such field" would send three different defects to the same wrong cure.
 */
const missingTargetKeyDetail = (ctx: EmitContext, view: Extract<ObjectView, { kind: 'known' }>, key: string): string => {
  if (view.representation.kind !== 'class-ref') {
    return (
      `the target declares no field "${key}", and ECMAScript's Set would CREATE an own property there -- a struct ` +
      'whose members are fixed at compile time has nowhere to put one, which is what a dynamic-property sidecar exists for'
    )
  }
  const site = classMemberOf(ctx.classes, view.representation.declaration, key)
  if (site === null) {
    return (
      `class ${view.representation.declaration} declares no "${key}" anywhere on its chain, and ECMAScript's Set ` +
      'would CREATE an own property there -- which a fixed-layout struct can only answer through a dynamic-property sidecar'
    )
  }
  if (site.kind === 'accessor') {
    return (
      `"${key}" is an accessor on class ${site.owner}, so writing it is a CALL rather than a store, and this renderer ` +
      'states the store only -- routing it through the setter is a real feature and not this one'
    )
  }
  if (site.kind === 'method') {
    return (
      `"${key}" is a method on class ${site.owner}'s prototype, which is not an own property of the instance at all, ` +
      'so a store into it would install a shadowing own field the language never had'
    )
  }
  return (
    `class ${site.owner} published no members, so whether it declares "${key}" is unknown here -- the gap is in what ` +
    'reached this stage, not in the program'
  )
}

/**
 * PRIMITIVE 3 -- `Set(o, key, v)` into one own key of a known view.
 *
 * The store's own carrier comes from `declaredFieldRepresentationOf`, the one
 * authority `emitFieldStore` and `emitFieldInits` already ask, so this cannot
 * become a second opinion about what a field holds; and the value is
 * reconciled against it through `convertedValueText`, the same one an ordinary
 * store uses. A pair with no installed conversion refuses by naming both
 * carriers rather than assigning across and leaving clang to reject it.
 *
 * There is no dynamic arm here either, and for the same reason as `Get`.
 */
export const setOwnText = (
  ctx: EmitContext,
  member: string,
  view: Extract<ObjectView, { kind: 'known' }>,
  key: string,
  value: { readonly text: string; readonly representation: Representation }
): string => {
  const held = declaredFieldRepresentationOf(ctx.deriver, view.representation, key, ctx.classes)
  if (held === null) {
    const ownership = ownershipOfGeneratedCarrier(view.representation)
    if (ownership === 'shared-refcount') {
      const boxed = widenedStoreText({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, value.representation, value.text)
      if (boxed !== null) {
        return `gea::nativeDynamicSet(${view.receiver}, gea::PropertyKey::string(${cppStringLiteral(key)}), ${boxed});`
      }
    }
    throw createCppEmitBlockedError(
      `property-access:${representationKey(view.representation)}:set:false`,
      `"Object.${member}" cannot store "${key}": ${missingTargetKeyDetail(ctx, view, key)}`
    )
  }
  const converted = alignedValueText(ctx, 'host/object-protocol.ts:468', value.representation, held, value.text)
  if (converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(value.representation)}->${representationKey(held)}`,
      `"Object.${member}" would store a "${representationKey(value.representation)}" into the field "${key}", which is held ` +
        `as "${representationKey(held)}", and no installed conversion performs that -- the two carriers are a disagreement ` +
        'upstream of this call, not something a store may paper over'
    )
  }
  const write = `${view.receiver}${view.accessor}${cppRecordFieldName(key)} = ${converted};`
  const field = view.fields.find((candidate) => candidate.key === key)
  const writes = field ? `${write} ${view.receiver}${view.accessor}${cppRecordFieldPresenceName(key)} = true;` : write
  const ownership = ownershipOfGeneratedCarrier(view.representation)
  if (ownership !== 'shared-refcount') return writes
  const present = field === undefined ? 'false' : `${view.receiver}${view.accessor}${cppRecordFieldPresenceName(key)}`
  const writable = field === undefined ? 'false' : `${view.receiver}${view.accessor}${cppRecordFieldAttributesName(key)}.writable`
  return `if ((${present} ? (${writable} && gea::nativeOwnFieldsWritable(${view.receiver})) : gea::nativeIsExtensible(${view.receiver}))) { ${writes} }`
}

/**
 * `hasOwnProperty`/`propertyIsEnumerable` reached as INSTANCE methods off a
 * known-shape receiver (`record`/`native-record-ref`/`class-ref`) -- the
 * method-call spelling of the identical question `Object.hasOwn` already
 * answers off the same layout (`hasOwnText` above).
 *
 * Left unclaimed, the checker still resolves `{ a: 1 }.hasOwnProperty` (every
 * object type structurally carries `Object.prototype`), and the record's own
 * field list has no member of that name -- so the generic dynamic-property
 * sidecar (`emit-dynamic-properties.ts`'s `nativeSidecarGetText`) answered it
 * instead, BOXING a statically known fact into a `gea::Value`-carried
 * `CallableObject` purely to call it once. That is the forbidden shortcut the
 * "no boxing" rule names: the record's own layout is a typed fact, and it has
 * no business inside a box just because the member that reads it is an
 * ambient `Object.prototype` declaration rather than one the record's own
 * shape states.
 *
 * Deferred exactly the way `dictionaryPrototypeMemberRead`
 * (`emit-carrier-members.ts`) defers `hasOwnProperty` off a dictionary: the
 * GET renders nothing, and the CALL that follows fuses receiver, key and
 * field list into one expression (`objectShapeCallText` below).
 *
 * The set itself lives in `projection/callee.ts`: the slot census's
 * `calleeRenderingOf` states the identical claim (a call through one of
 * these names renders from a template, not `Object.prototype`'s declared
 * convention) so the two do not drift into a printer that claims one set of
 * calls and a census that converts arguments for a different one.
 */

/**
 * The claim, asked at the `[[Get]]`.
 *
 * Gated on the receiver representation BEFORE `objectViewFrom` is ever asked:
 * that function THROWS for a receiver it cannot enumerate (a `dictionary`
 * already has its own claim; a `dynamic` receiver is a genuine boundary whose
 * `hasOwnProperty` really does need the runtime table), and this claim must
 * answer `false` for those rather than refuse a program this file was never
 * meant to gate.
 */
/**
 * Whether a known-shape receiver's `hasOwnProperty`/`propertyIsEnumerable` is
 * a deferred `Object.prototype` read, and what the call needs from it.
 *
 * Stated once; the renderer below and the prototype-read walk both ask it.
 * `objectViewFrom` is the authority for what a known shape's fields and member
 * accessor are, so it is asked here rather than re-derived -- with an empty
 * receiver TEXT, because the `known` arm's `fields` and `accessor` do not
 * depend on it and the receiver is spelled at the call from the operand this
 * record carries.
 */
export const deferredObjectShapeMethodClaim = (ctx: EmitContext, operation: GetOperation): PrototypeMethodRead | null => {
  const staticKey = ctx.staticKeyTexts.get(operation.key.value)
  if (staticKey === undefined || !objectShapePrototypeMethods.has(staticKey)) return null
  const representation = operation.receiver.representation
  const known =
    representation.kind === 'record' ||
    representation.kind === 'class-ref' ||
    (representation.kind === 'native-record-ref' && representation.native === null)
  if (!known) return null
  const view = objectViewFrom(ctx, staticKey, representation, '', 'receiver')
  if (view.kind !== 'known') return null
  return {
    receiverKind: 'object-shape',
    member: staticKey,
    receiver: { kind: 'operand', operand: operation.receiver },
    receiverElement: null,
    objectShapeFields: view.fields,
    objectShapeAccessor: view.accessor
  }
}

export const objectShapePrototypeMemberRead = (ctx: EmitContext, operation: GetOperation): boolean => {
  return deferredObjectShapeMethodClaim(ctx, operation) !== null
}

/**
 * The presence text `hasOwnText`'s own `ownKeyPresenceText` renders, spelled
 * without an `ObjectView`: the call site only carries the fields and accessor
 * `objectShapePrototypeMemberRead` snapshotted at the read, not the receiver's
 * full representation the view type demands.
 */
const shapeKeyPresenceText = (receiver: string, accessor: string, field: RecordField, member: string): string => {
  const present = `${receiver}${accessor}${cppRecordFieldPresenceName(field.key)}`
  return member === 'propertyIsEnumerable'
    ? `(${present} && ${receiver}${accessor}${cppRecordFieldAttributesName(field.key)}.enumerable)`
    : present
}

/**
 * The call text for a deferred `hasOwnProperty`/`propertyIsEnumerable` read.
 *
 * A literal key answers at compile time, exactly as `Object.hasOwn` does for
 * one. A key only known at runtime dispatches over the SAME finite field set
 * a static receiver's own computed key already switches over
 * (`emit-dynamic-properties.ts`'s `constructorFamilyComputedGetText` is the
 * reference for the shape): every field the layout declares gets one `if`
 * arm, and a key naming none of them is not an own property. Only a string
 * key is admitted -- ToPropertyKey of anything else is a question `hasOwnText`
 * above refuses too, and a record's fields are never symbol- or number-keyed.
 *
 * Presence and enumerability are separate native metadata. defineProperty
 * can make a present fixed field non-enumerable without moving its value to
 * a dynamic sidecar; the query must read that stored attribute too.
 */
export const objectShapeCallText = (
  ctx: EmitContext,
  member: string,
  receiver: string,
  accessor: string,
  fields: readonly RecordField[],
  args: readonly IrOperand[]
): string => {
  const key = args[0]
  if (key === undefined) {
    throw createCppEmitBlockedError(`host-member-call:Object.prototype.${member}`, `"Object.prototype.${member}" was called with no key`)
  }
  // A claim, not a fold: this decides whether the answer is the compile-time
  // constant below or the runtime switch further down, so it must not see a
  // key text `constantTexts` only holds because the render minted it (e.g. a
  // folded `typeof` result reaching here as the tested key).
  const spelled = ctx.staticKeyTexts.get(key.value)
  if (spelled !== undefined) {
    const field = fields.find((candidate) => candidate.key === spelled)
    return field === undefined ? 'false' : shapeKeyPresenceText(receiver, accessor, field, member)
  }
  if (key.representation.kind === 'symbol') {
    // The identical declared-field dispatch `records.ts`'s field dispatcher
    // uses for a computed `obj[k]` read: a program's own `unique symbol`
    // binding is not a compile-time text (`spelled` above only catches a
    // COMPUTED KEY the checker resolved at normalize time,
    // `properties.ts`'s `keyOf`/`symbolMemberKeyOf` -- an ordinary CALL
    // ARGUMENT such as `p.hasOwnProperty(keyA)` is never one), so a
    // symbol-keyed field is matched by the id its cell registered
    // (`gea::detail::registerDeclaredSymbol`) rather than by name.
    const symbolFields = fields.filter((field) => cppRecordFieldKeyIsSymbol(field.key))
    if (symbolFields.length > 0) {
      const keyText = propertyKeyText(ctx, key, `an "Object.prototype.${member}" call`)
      const arms = symbolFields
        .map(
          (field) =>
            `if (__gea_key.symbolId() == gea::detail::declaredSymbolId(${cppStringLiteral(field.key)})) return ` +
            `${shapeKeyPresenceText(receiver, accessor, field, member)};`
        )
        .join(' ')
      return `([&]() -> bool { const gea::PropertyKey __gea_key = ${keyText}; ${arms} return false; })()`
    }
  }
  if (key.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      `host-member-call:Object.prototype.${member}`,
      `"Object.prototype.${member}" received a key carried as "${representationKey(key.representation)}" rather than a ` +
        'string, and ToPropertyKey of anything else runs ToPrimitive, which this backend does not perform'
    )
  }
  if (fields.length === 0) return 'false'
  const runtimeKey = operandText(ctx, key)
  const arms = fields
    .map((field) => `if (__gea_key == ${cppStringLiteral(field.key)}) return ${shapeKeyPresenceText(receiver, accessor, field, member)};`)
    .join(' ')
  return `([&]() -> bool { const std::string& __gea_key = ${runtimeKey}; ${arms} return false; })()`
}

/**
 * `hasOwnProperty`/`propertyIsEnumerable` off a `native-handle` receiver
 * (`Math.hasOwnProperty(...)`, or `Object.prototype.hasOwnProperty.call(Math,
 * ...)` after the borrowed-call rewrite), for the SAME finite own-member list
 * `getOwnPropertyDescriptorText`'s native-handle arm reads
 * (`ctx.hosts.intrinsicMembers`) -- see that table's own comment for where it
 * comes from and why it is never hand-listed here.
 *
 * `propertyIsEnumerable` needs no key at all: ECMA-262 specifies every own
 * member of a host intrinsic non-enumerable, whether it is a data constant
 * (21.3.1) or a builtin method (10.2.4) -- so the honest answer is `false`
 * unconditionally, the same fact `emitNativeHandleEnumerateIterator`
 * (`emit-iterator.ts`) already renders as an always-empty `for`-`in` walk.
 * Asking `hasOwnProperty` first and `false` never matters because
 * `propertyIsEnumerable` of an ABSENT key is `false` too -- one constant
 * covers both cases of ECMA-262 20.1.3.7's own two-step definition.
 *
 * `hasOwnProperty` is real membership: a literal key folds against the list
 * at compile time, and a runtime key becomes a switch over it, mirroring
 * `objectShapeCallText`'s own two arms for a record receiver.
 */
/**
 * `fn.hasOwnProperty(k)` / `fn.propertyIsEnumerable(k)`: the callable's own
 * properties are its one shared function-object table, with the `name`/
 * `length` facts installed first so both answer for them (10.2.10: present,
 * non-enumerable) exactly as `callableDynamicGet` sees them.
 */
export const callableShapeCallText = (ctx: EmitContext, member: string, receiver: string, args: readonly IrOperand[]): string => {
  const key = args[0]
  if (key === undefined) {
    throw createCppEmitBlockedError(`host-member-call:Object.prototype.${member}`, `"Object.prototype.${member}" was called with no key`)
  }
  const site = `"Object.prototype.${member}" of a callable`
  const test = member === 'propertyIsEnumerable' ? '__gea_own != nullptr && __gea_own->enumerable' : '__gea_own != nullptr'
  return (
    `([&]() -> bool { const auto& __gea_callable = ${receiver}; ` +
    'gea::installCallableOwnFacts(__gea_callable.functionObjectIdentity(), __gea_callable.name(), __gea_callable.length()); ' +
    `const gea::PropertyDescriptor* __gea_own = __gea_callable.functionObjectIdentity()->properties->ownProperty(${propertyKeyText(ctx, key, site)}); ` +
    `return ${test}; })()`
  )
}

export const nativeHandleShapeCallText = (ctx: EmitContext, member: string, protocol: string, args: readonly IrOperand[]): string => {
  if (member === 'propertyIsEnumerable') return 'false'
  const members = ctx.hosts.intrinsicMembers.get(protocol) ?? []
  const key = args[0]
  if (key === undefined) {
    throw createCppEmitBlockedError(`host-member-call:Object.prototype.${member}`, `"Object.prototype.${member}" was called with no key`)
  }
  const site = `"Object.prototype.${member}" of a host intrinsic`
  // A claim, not a fold: this decides whether a non-configurable member folds
  // to a compile-time constant below or falls through to the sidecar dispatch,
  // so it must not see a key text `constantTexts` only holds because the
  // render minted it (e.g. a folded `typeof` result reaching here as the key).
  const spelled = ctx.staticKeyTexts.get(key.value)
  const named = spelled === undefined ? undefined : members.find((candidate) => candidate.name === spelled)
  // A non-configurable member can neither be deleted nor overridden, so its
  // membership is a compile-time fact. Every other key -- a configurable
  // member, or a name the table lacks -- is answered by the intrinsic's
  // dynamic-property sidecar first (`hostIntrinsicSidecar`, gea_runtime.h):
  // test262's `isConfigurable` deletes the member and then asks exactly this
  // question, and an answer read off the static table alone would say the
  // deleted member is still there.
  if (named !== undefined && !intrinsicMemberValueOf(ctx, protocol, named, site).configurable) return 'true'
  if (members.length === 0) return 'false'
  const arms = members.map((candidate) => `__gea_name == ${cppStringLiteral(candidate.name)}`).join(' || ')
  return (
    `([&]() -> bool { const gea::PropertyKey __gea_key = ${propertyKeyText(ctx, key, site)}; ` +
    `auto& __gea_side = gea::detail::hostIntrinsicSidecar(${cppStringLiteral(protocol)}); ` +
    `if (__gea_side.hasOverride(__gea_key)) return true; if (__gea_side.isRemoved(__gea_key)) return false; ` +
    `if (__gea_key.isSymbol()) return false; const std::string& __gea_name = __gea_key.text(); return ${arms}; })()`
  )
}

/**
 * `hasOwnProperty` off a receiver the program itself declared dynamic (a
 * `--dynamic-fallback` boxed value carrying a real `gea::DynamicObject`).
 *
 * `objectShapePrototypeMemberRead` above deliberately answers `false` for one
 * of these (`known` excludes `'dynamic'`) rather than claim it, and its own
 * comment says why: "a `dynamic` receiver is a genuine boundary whose
 * `hasOwnProperty` really does need the runtime table". This is that table --
 * `gea::runtime::object::hasOwnProperty` (gea_runtime.h) already implements
 * 20.1.3.7's OWN-half-only membership test for an arbitrary `gea::Value`
 * receiver, generically, for any key. Left unclaimed, this member falls
 * through to `dynamicGetText` (`emit-dynamic-properties.ts`), which reads
 * "hasOwnProperty" as an ordinary property THROUGH the object's real
 * `[[Prototype]]` chain -- correct for a program-defined member, but wrong
 * for this one, because this runtime never links a `DynamicObject` to an
 * `Object.prototype` analogue: the chain a user constructor builds
 * (`instance` -> `Ctor.prototype` -> `null`) has no entry that could ever
 * answer an ambient `Object.prototype` method, so the read comes back
 * `undefined` and calling it aborts.
 *
 * `propertyIsEnumerable` is deliberately left unclaimed here: nothing in this
 * file states which `PropertyDescriptor.enumerable` bit a THIRD idiom
 * (`Object.prototype.propertyIsEnumerable.call(...)`) should read against a
 * `DynamicObject`, and no probe in this codebase exercises it yet -- adding
 * it un-exercised would be a guess, not an answer.
 */
export const dynamicObjectPrototypeMethods: ReadonlySet<string> = new Set(['hasOwnProperty'])

/** The claim, asked at the `[[Get]]` -- the dynamic-receiver twin of `objectShapePrototypeMemberRead` above. */
export const deferredDynamicObjectMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || !dynamicObjectPrototypeMethods.has(staticKey)) return null
  if (receiver.representation.kind !== 'dynamic') return null
  return { receiverKind: 'dynamic-object', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

export const dynamicObjectPrototypeMemberRead = (ctx: EmitContext, operation: GetOperation): boolean =>
  deferredDynamicObjectMethodClaim(ctx.staticKeyTexts, operation.receiver, operation.key) !== null

/**
 * The call text for a deferred `hasOwnProperty` read off a dynamic receiver.
 *
 * Only a string key is admitted, for the identical reason `objectShapeCallText`
 * and `nativeHandleShapeCallText` above refuse anything else: ToPropertyKey of
 * a non-string runs ToPrimitive, which this backend does not perform.
 */
export const dynamicObjectCallText = (ctx: EmitContext, member: string, receiver: string, args: readonly IrOperand[]): string => {
  const key = args[0]
  if (key === undefined) {
    throw createCppEmitBlockedError(`host-member-call:Object.prototype.${member}`, `"Object.prototype.${member}" was called with no key`)
  }
  return `gea::runtime::object::hasOwnProperty(${receiver}, ${propertyKeyText(ctx, key, `"Object.prototype.${member}" of a dynamic receiver`)})`
}
