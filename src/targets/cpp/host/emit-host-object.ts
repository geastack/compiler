import type { CallableAbi, Ownership, RecordField, Representation } from '../../../representation/model.js'
import { passingOf, representationKey } from '../../../representation/model.js'
import { hostMemberTemplateOf } from '../../../representation/host-templates.js'
import type { FixedDataDefinitionRecipe } from '../../../ir/fixed-data-definition.js'
import type { CallOperation, IrOperand } from '../../../ir/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { canonicalIndexLiteral, memberAccessOperator } from '../emit-carrier-members.js'
import { classMemberOf, lazyArrowFieldPlanOf } from '../class-layout.js'
import { alignedValueText, recipeText } from '../emit-narrowing.js'
import {
  getOwnValue,
  objectViewFrom,
  objectViewOf,
  type ObjectView,
  ownEnumerableKeysText,
  ownKeyFields,
  ownKeyPresenceText,
  refuseDictionaryArm,
  refuseObjectCarrier,
  setOwnCallableText,
  setOwnText
} from './object-protocol.js'
import { hostIntrinsicLengthOf, hostMemberOf } from './host-members.js'
import { hostFunctionValueText, hostPrototypeMethodValueText } from './emit-host-value.js'
import { armAt, armIs } from '../emit-union-properties.js'
import { recordFieldsOfShape, recordIndexesOfShape } from '../records.js'
import type { HostIntrinsicMember } from '../../../semantics/host-protocols.js'
import {
  cppArrayExtensionStructName,
  cppBodyName,
  cppRecordFieldAttributesName,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppStringLiteral,
  cppTypeOf,
  cppUndefinedValue
} from '../types.js'
import { isNativeCallableCarrier, propertyKeyText as propertyKeyOperandText, stringKeyPreludeText } from '../emit-dynamic-properties.js'
import { regexpRoleOf } from '../prototype/emit-prototype-regexp.js'

/**
 * `Object`'s statics -- the call-site half of the `ObjectConstructor@1`
 * boundary.
 *
 * Its own module rather than another block in `emit-host-invoke.ts` because
 * every member here answers the same question that file's other renderers do
 * not have to: *what is the receiver's carrier*. `Promise.resolve` renders
 * from the result's payload and `Symbol.for` from a literal's text, but
 * `Object.keys(x)` is two completely different programs depending on whether
 * the checker knows `x`'s shape -- and the split runs through all ten members,
 * so it is one file's subject rather than ten paragraphs in someone else's.
 *
 * ## Every member is a loop over three primitives
 *
 * The receiver question, the key list, the read and the store are not this
 * file's -- they are `object-protocol.ts`'s, which states them once as
 * `objectViewOf`, `ownEnumerableKeysText`, `getOwnValue` and `setOwnText`.
 * What is left here is what each member actually IS in terms of them, which is
 * the shape ECMA-262 gives it: `keys` is primitive 1, `values` is 1 then 2 per
 * key, `assign` is 1 then 2 then 3 per key, `hasOwn` is membership in 1.
 *
 * Before that split, each member rediscovered the receiver question and they
 * had drifted: `keys` and `values` grew a static arm, `entries`, `assign` and
 * `defineProperty` refused every known shape, and `values` enumerated in
 * DECLARATION order while `keys` enumerated in ECMA-262 10.1.11.1 order -- two
 * answers about one object's keys, which is the defect this whole file exists
 * to avoid.
 *
 * ## What still refuses, and why each refusal is its own
 *
 * A member whose static arm needs a capability beyond the three primitives
 * refuses NAMING THAT CAPABILITY rather than borrowing the enumeration
 * refusal. `freeze` needs an integrity level a C++ struct has no slot for;
 * `getOwnPropertyDescriptor` needs a descriptor synthesized from a field;
 * `defineProperty` needs the non-default attributes its own semantics install.
 * Those are three different missing features, and reporting all three as "this
 * carrier has no own-key enumeration" sent them to one wrong cure.
 */

/** A `dynamic` carrier, built where a member has to state the box it widens a known field into. */
const dynamicCarrier: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

const objectValueConversionText = (
  ctx: EmitContext,
  operation: CallOperation,
  role: 'descriptor-value' | 'callable-property',
  argument: number,
  field: string,
  source: Representation,
  text: string
): string => {
  const citation = operation.objectValueConversions?.find(
    (value) => value.role === role && value.argument === argument && value.field === field
  )
  const node = citation && ctx.conversions.nodeById(citation.conversion)
  if (!citation || !node || representationKey(citation.source) !== representationKey(source))
    throw createCppEmitBlockedError('call-abi:object-value-conversions', 'Object field value has no matching certified conversion citation')
  const rendered = recipeText(ctx, node, text)
  if (rendered === null)
    throw createCppEmitBlockedError(`conversion:${citation.conversion}`, 'Object field value conversion has no rendering')
  return rendered
}

/**
 * The receiver's argument, or a refusal naming the member that has no
 * receiver to work on.
 *
 * Every member here takes its target as the FIRST argument -- `Object` itself
 * is the callee, not the receiver -- so this is the one shape check they share.
 *
 * The argument is read THROUGH the box lowering put in front of it. The
 * declared parameter is `any`, so the slot census answers `dynamic` and
 * lowering converts a typed receiver (`Math`, an array, a callable) into a
 * `gea::Value` before this renderer sees it. The arms below are not callers of
 * that `any` parameter: each expands the member over the receiver's own
 * carrier (the intrinsic's member table, the array's elements, the function's
 * own properties), and only the arm for a receiver nothing else names goes
 * through the runtime's boxed entry point. Rendering the box instead of the
 * source lost the Math member table: `Object.getOwnPropertyDescriptor(Math,
 * "abs")` boxed `Math` to a `Value` with no own properties and answered
 * `undefined`. Until the census names these calls as expansions of the
 * receiver (Phase 3's `CallOperation.target`), the source is looked up the way
 * `emit-jsx.ts` looks up a slot's history -- `EmitContext.conversionSources`.
 */
const targetOf = (ctx: EmitContext, member: string, operation: CallOperation): IrOperand => {
  const target = operation.arguments[0]
  if (target === undefined) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" takes a target object, and this call passes none`
    )
  }
  if (target.representation.kind !== 'dynamic') return target
  const source = ctx.conversionSources.get(target.value)
  return source !== undefined && source.representation.kind !== 'dynamic' ? source : target
}

/**
 * THE ENUMERATION OF A UNION IS THE ENUMERATION OF WHICHEVER ARM IS LIVE.
 *
 * A `tagged-union` receiver has no own properties of its own -- it is a
 * discriminated carrier over several shapes, each of which answers the
 * receiver question by itself. So the member renders once PER ARM and
 * dispatches on the discriminant, exactly as `emit-union-properties.ts`
 * renders a `get` over one: the arms all produce the member's own result type
 * (an `ArrayObject` of keys, of values, of entry structs), so the conditional
 * chain is well typed whatever mix of records and dictionaries the union
 * holds.
 *
 * hono's `#newResponse` is the measured case: `Object.entries( headers )`
 * where `headers: HeaderRecord` is `Record<'Content-Type', BaseMime> |
 * Record<ResponseHeader, string> | Record<string, string>` -- two records and
 * a dictionary, and refusing the union outright refused a program in which
 * every arm on its own is renderable.
 *
 * An arm that CANNOT be enumerated still refuses, and now says which arm and
 * why rather than reporting the union as one unenumerable carrier.
 */
const overCarrier = (ctx: EmitContext, member: string, operation: CallOperation, render: (view: ObjectView) => string): string => {
  const target = targetOf(ctx, member, operation)
  const representation = target.representation
  if (representation.kind !== 'tagged-union') return render(objectViewOf(ctx, member, target, 'object'))
  const receiver = operandText(ctx, target)
  const arms = representation.arms.map((arm, index) => render(objectViewFrom(ctx, member, arm.value, armAt(receiver, index), 'object')))
  const dispatched = arms.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiver, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a tagged union with no arms has nothing to enumerate`
    )
  }
  return arms.length > 1 ? `(${dispatched})` : dispatched
}

/** `Object.keys` / `Object.getOwnPropertyNames` -- primitive 1 alone, because a record has no non-enumerable member for the two to differ over. */
const keysText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  const target = targetOf(ctx, member, operation)
  const keysOf = (representation: Representation, receiver: string): string => {
    if (representation.kind === 'scalar' || representation.kind === 'symbol') {
      return `((void)(${receiver}), gea::host::ObjectConstructor::staticKeys({}))`
    }
    if (representation.kind === 'native-handle') {
      // `Object.keys` answers empty: ECMA-262 declares every one of a host
      // intrinsic's own members non-enumerable (21.3.1's constants, 10.2.4's
      // builtin methods), the identical fact `emitNativeHandleEnumerateIterator`
      // (emit-iterator.ts) already renders as an always-empty `for`-`in` walk.
      // `Object.getOwnPropertyNames` is NOT enumerable-filtered (6.1.7.1) --
      // it answers every own key regardless -- so it reads the full static
      // list `nativeHandleShapeCallText`'s own `hasOwnProperty` reads
      // (`ctx.hosts.intrinsicMembers`), never a hand-listed name.
      const protocol = representation.native ?? representation.protocol
      const names = member === 'keys' ? [] : (ctx.hosts.intrinsicMembers.get(protocol) ?? []).map((found) => found.name)
      return `((void)(${receiver}), gea::host::ObjectConstructor::staticKeys({${names.map((name) => cppStringLiteral(name)).join(', ')}}))`
    }
    if (representation.kind === 'array-object') {
      const helper = member === 'keys' ? 'arrayOwnEnumerableKeys' : 'arrayOwnPropertyNames'
      return `gea::host::ObjectConstructor::staticKeys(gea::${helper}(${receiver}))`
    }
    if (regexpRoleOf(representation) === 'pattern') {
      const helper = member === 'keys' ? 'nativeDynamicKeys' : 'nativeOwnPropertyNames'
      return `gea::host::ObjectConstructor::staticKeys(gea::${helper}(${receiver}))`
    }
    return ownEnumerableKeysText(
      member,
      objectViewFrom(ctx, member, representation, receiver, 'object'),
      member === 'keys' ? 'keys' : 'getOwnPropertyNames'
    )
  }
  if (target.representation.kind !== 'tagged-union') return keysOf(target.representation, operandText(ctx, target))
  const receiver = operandText(ctx, target)
  const arms = target.representation.arms.map((arm, index) => keysOf(arm.value, armAt(receiver, index)))
  const dispatched = arms.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiver, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null)
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a tagged union with no arms has nothing to enumerate`
    )
  return arms.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * `Object.values` -- primitive 1 for the order, primitive 2 for each entry.
 *
 * The static arm needs one more agreement than `keys` does: every field has to
 * carry the array's own element type, because a `std::vector<E>` has one
 * element type and a record's fields need not share one. A heterogeneous
 * record's `Object.values` is typed `(number | string)[]` by the checker, whose
 * element carrier is a `tagged-union` -- and building one arm-by-arm from a
 * struct field is a conversion per field this does not write, so it refuses
 * with the disagreement named instead of picking an arm.
 */
const valuesText = (ctx: EmitContext, operation: CallOperation): string =>
  overCarrier(ctx, 'values', operation, (view) => valuesOfView(ctx, operation, view))

const valuesOfView = (ctx: EmitContext, operation: CallOperation, view: ObjectView): string => {
  if (view.kind === 'dynamic') return `gea::host::ObjectConstructor::values(${view.receiver})`
  const result = operation.result?.representation
  if (view.kind === 'dictionary') {
    if (view.representation.key === 'symbol') {
      if (result === undefined || result.kind !== 'array-object') {
        throw createCppEmitBlockedError(
          'host-member-call:Object.values',
          `"Object.values" of a symbol dictionary mints an empty array, and this call's result carries ` +
            `"${result === undefined ? 'nothing' : representationKey(result)}"`
        )
      }
      return `gea::detail::hostArrayResult(std::vector<${cppTypeOf(result.element)}>{})`
    }
    // A dictionary's values all carry ONE type -- the table's own `V` -- so
    // the per-field disagreement the known-shape arm below refuses on cannot
    // arise. What has to agree is the result's element with that `V`; a
    // program whose `Object.values` result was typed wider than the table
    // would need a per-entry conversion, which is a real feature and not this
    // one.
    if (result === undefined || result.kind !== 'array-object' || representationKey(result.element) !== representationKey(view.value)) {
      return refuseDictionaryArm(
        'values',
        view,
        `its values all carry "${representationKey(view.value)}" and this call's result carries ` +
          `"${result === undefined ? 'nothing' : representationKey(result)}" -- converting each entry into a different ` +
          'element carrier is a per-entry conversion this arm does not write'
      )
    }
    return `gea::host::ObjectConstructor::valuesOf(${view.receiver})`
  }
  if (result === undefined || result.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.values',
      `"Object.values" of a known shape mints an array, and this call's result carries ` +
        `"${result === undefined ? 'nothing' : representationKey(result)}"`
    )
  }
  const element = representationKey(result.element)
  const ordered = ownKeyFields(view)
  for (const field of ordered) {
    if (!field.required) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.values',
        `"Object.values" cannot include the optional field "${field.key}": an absent field contributes no element, and ` +
          'the length of the array would then depend on a presence flag this arm does not test'
      )
    }
    if (representationKey(field.value) !== element) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.values',
        `"Object.values" would build a std::vector<${cppTypeOf(result.element)}> from the field "${field.key}", which ` +
          `carries "${representationKey(field.value)}" -- one array has one element type, and converting each field into ` +
          "the result's element carrier is a per-field conversion this arm does not write"
      )
    }
  }
  const reads = ordered.map((field) => getOwnValue(ctx, view, field).text)
  return `gea::detail::hostArrayResult(std::vector<${cppTypeOf(result.element)}>{${reads.join(', ')}})`
}

type EntryCarrier =
  | { readonly kind: 'array'; readonly element: Representation; readonly value: Representation }
  | {
      readonly kind: 'record'
      readonly name: string
      readonly element: Representation
      readonly value: Representation
      readonly shared: boolean
    }

/** Consume the representation already selected for the entry's [string, T] tuple. */
const entryCarrierOf = (ctx: EmitContext, operation: CallOperation): EntryCarrier => {
  const result = operation.result?.representation
  if (result === undefined || result.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.entries',
      `"Object.entries" mints an array of entries, and this call's result carries ` +
        `"${result === undefined ? 'nothing' : representationKey(result)}"`
    )
  }
  const element = result.element
  // Homogeneous tuples share the native Array carrier with their array views.
  // The first entry position is always a string, so this carrier is valid only
  // when the value position is also a string. No record layout is invented.
  if (
    element.kind === 'array-object' &&
    element.element.kind === 'string' &&
    element.ownership === 'shared-refcount' &&
    element.extension === null &&
    !element.recursive
  ) {
    return { kind: 'array', element, value: element.element }
  }
  const fields =
    element.kind === 'record'
      ? element.fields
      : element.kind === 'native-record-ref' && element.native === null
        ? recordFieldsOfShape(ctx.deriver, element.shapeId)
        : null
  // A host-stated name wins where there is one -- `records.ts` emits no
  // definition for such a shape, so minting a `gea_record_type_N` name for it
  // would name a struct nothing declares.
  const name =
    element.kind === 'native-record-ref'
      ? (element.native ?? cppRecordStructName(element.shapeId))
      : element.kind === 'record'
        ? cppRecordStructName(element.shapeId)
        : null
  if (fields === null || name === null || fields.length !== 2) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.entries',
      `"Object.entries" builds each entry as the two-position tuple the checker typed it, and this call's element carries ` +
        `"${representationKey(element)}", which is not a two-field record`
    )
  }
  const [first, second] = fields
  if (!first || !second || first.key !== '0' || second.key !== '1') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.entries',
      `"Object.entries" expects its entry record to be keyed by tuple position ("0", "1"); this one is keyed ` +
        `"${fields.map((field) => field.key).join('", "')}"`
    )
  }
  // The KEY has to be a string -- `OwnPropertyKeys` yields one and there is
  // nothing to convert it into. The VALUE slot is whatever the checker typed
  // it: `dynamic` for a target the program declared `any`, and a real carrier
  // wherever the source's own values have one -- hono's `HeaderRecord` entries
  // are `[string, string | string[]]`, a tagged union and not a box. Demanding
  // `dynamic` here refused that program for having stated MORE than the arm
  // expected; each value is reconciled into the slot by `convertedValueText`
  // instead, which answers the `dynamic` case with the same widen this used to
  // require and every other case with the conversion it needs.
  if (first.value.kind !== 'string') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.entries',
      `"Object.entries" yields a string key, and this call's entry carries "${representationKey(first.value)}" in its first ` +
        `position (its second carries "${representationKey(second.value)}")`
    )
  }
  // `->` when the element is held behind a pointer, `.` when it is a value:
  // the same ownership question every other struct write in this backend asks,
  // and the reason the allocation differs too.
  const ownership = element.kind === 'record' || element.kind === 'native-record-ref' ? element.ownership : 'owned'
  return { kind: 'record', name, element, value: second.value, shared: memberAccessOperator(ownership) === '->' }
}

/** One entry, with both positions already converted to their selected carriers. */
const entryText = (entry: EntryCarrier, key: string, value: string): string => {
  if (entry.kind === 'array') return `return gea::arrayOf<${cppTypeOf(entry.value)}>({${key}, ${value}});`
  // `gea::makeRef` and not `std::make_shared`: `gea::Ref` is its own handle
  // (gea_runtime.h), a `shared_ptr` does not convert to one, and every other
  // allocation in this backend already spells it this way -- so the entry
  // struct was the one place that built a handle no `std::vector<gea::Ref<T>>`
  // would take.
  const allocate = entry.shared ? `auto __gea_entry = gea::makeRef<${entry.name}>();` : `${entry.name} __gea_entry{};`
  const write = entry.shared ? '__gea_entry->' : '__gea_entry.'
  return `${allocate} ${write}${cppRecordFieldName('0')} = ${key}; ${write}${cppRecordFieldName('1')} = ${value}; return __gea_entry;`
}

/**
 * `Object.entries` -- primitive 1 for the keys, primitive 2 for each value.
 *
 * The static arm's one extra obligation is the entry's second slot: whatever
 * the checker typed it, each own value has to be reconciled into it. That is
 * `convertedValueText` -- a widen where the slot really is `dynamic` (the
 * target the program declared `any`), an arm store where the source's values
 * have a type of their own, and a refusal by name where neither is licensed.
 *
 * An optional field refuses for the same reason it does in `values`: an absent
 * key contributes no entry, so the array's LENGTH would depend on a presence
 * flag, and a `std::vector` built from a brace list has its length fixed
 * before any flag is read.
 */
const entriesText = (ctx: EmitContext, operation: CallOperation): string =>
  overCarrier(ctx, 'entries', operation, (view) => entriesOfView(ctx, operation, view))

const entriesOfView = (ctx: EmitContext, operation: CallOperation, view: ObjectView): string => {
  const entry = entryCarrierOf(ctx, operation)
  /**
   * One own value, reconciled into the entry's second slot.
   *
   * `convertedValueText` and not `widenedStoreText`: the slot is `dynamic`
   * only where the program declared the target `any`, and a widen is then
   * exactly what this returns -- but a typed source has a typed slot, and
   * `HeaderRecord`'s `string | string[]` needs an arm store rather than a box.
   */
  const intoSlot = (source: Representation, text: string, describe: string): string => {
    const converted = alignedValueText(ctx, 'host/emit-host-object.ts:371', source, entry.value, text)
    if (converted !== null) return converted
    throw createCppEmitBlockedError(
      'host-member-call:Object.entries',
      `"Object.entries" would put ${describe}, carried as "${representationKey(source)}", into an entry's value slot ` +
        `carried as "${representationKey(entry.value)}", and no conversion between those is licensed`
    )
  }
  if (view.kind === 'dynamic') {
    const value = intoSlot(dynamicCarrier, '__gea_value', 'a dynamic own value')
    return (
      `gea::host::ObjectConstructor::entriesAs<${cppTypeOf(entry.element)}>(${view.receiver}, ` +
      `[](std::string __gea_key, gea::Value __gea_value) { ${entryText(entry, '__gea_key', value)} })`
    )
  }
  if (view.kind === 'dictionary') {
    if (view.representation.key === 'symbol') {
      return `gea::detail::hostArrayResult(std::vector<${cppTypeOf(entry.element)}>{})`
    }
    // The same maker the dynamic arm passes, over the table's own entries: the
    // key comes from `propertyKeys()` (10.1.11 order, stated on the container)
    // and the value keeps the table's own `V` right up to the entry slot.
    const value = intoSlot(view.value, '__gea_value', 'a dictionary entry')
    return (
      `gea::host::ObjectConstructor::entriesOf<${cppTypeOf(entry.element)}>(${view.receiver}, ` +
      `[](std::string __gea_key, ${cppTypeOf(view.value)} __gea_value) { ${entryText(entry, '__gea_key', value)} })`
    )
  }
  const built = ownKeyFields(view).map((field) => {
    if (!field.required) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.entries',
        `"Object.entries" cannot include the optional field "${field.key}": an absent key contributes no entry, and the ` +
          'length of the array would then depend on a presence flag a braced vector has already fixed'
      )
    }
    const read = getOwnValue(ctx, view, field)
    const value = intoSlot(read.representation, read.text, `the field "${field.key}"`)
    return `[&]() { ${entryText(entry, cppStringLiteral(field.key), value)} }()`
  })
  return `gea::detail::hostArrayResult(std::vector<${cppTypeOf(entry.element)}>{${built.join(', ')}})`
}

/**
 * A property key argument, as `gea::PropertyKey`.
 *
 * ECMA-262 6.1.7 admits a string or a symbol and nothing else, and
 * ToPropertyKey of anything else is a conversion that can run user code
 * (`ToPrimitive`), which this backend does not perform anywhere. So a `number`
 * key -- legal in the language, and `o[0]` really is the string key `"0"` --
 * refuses here rather than being spelled through a `std::to_string` that would
 * be right for an integer and wrong for `1e21`, `-0` and `NaN`.
 */
const propertyKeyText = (ctx: EmitContext, member: string, key: IrOperand): string => {
  return propertyKeyOperandText(ctx, key, `Object.${member}`)
}

/**
 * The native object expression for a generated record index sidecar.
 *
 * Enumeration still needs a single interleaved creation-order stream and is
 * deliberately not claimed for this carrier. Descriptor operations do not:
 * they address exactly one own key, so they can use the generated record's
 * authenticated index hooks without inventing an enumeration contract.
 */
const indexedRecordReceiver = (ctx: EmitContext, member: string, representation: Representation, receiver: string): string | null => {
  const indexed =
    representation.kind === 'record-with-index' ||
    (representation.kind === 'native-record-ref' &&
      representation.native === null &&
      recordIndexesOfShape(ctx.deriver, representation.shapeId).length > 0)
  if (!indexed) return null
  const ownership = representation.ownership
  if (ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a "${representationKey(representation)}" carrier needs an object identity for its descriptor sidecar, ` +
        `but this receiver is "${ownership}" rather than shared-refcount`
    )
  }
  return receiver
}

/** A generated shared record's fixed slots and typed index sidecar share one native [[DefineOwnProperty]] dispatch. */
const generatedRecordReceiver = (representation: Representation, receiver: string): string | null => {
  const generated =
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'class-ref' ||
    (representation.kind === 'native-record-ref' && representation.native === null)
  return generated && representation.ownership === 'shared-refcount' ? receiver : null
}

/**
 * A literal key naming a declared fixed field of one of `generatedRecordReceiver`'s
 * own four carrier kinds -- asked directly against the shape rather than through
 * `objectViewOf`, which answers identically for these but can also THROW for a
 * fifth case that predicate matches (a `native-record-ref` deriving no record
 * layout at all), which must fall through to the generic dispatch below unchanged
 * rather than refuse.
 *
 * `definePropertyText` asks this BEFORE `generatedRecordReceiver`'s own
 * unconditional match: a key naming a declared field belongs to
 * `fixedFieldDefinePropertyText`'s per-field typed store (the one place that
 * knows the field's real C++ carrier and its own `existing`-vs-new distinction),
 * never to the class's generic index-descriptor virtual dispatch
 * (`gea_matchesOwnField`/`gea_defineOwnField`) that dispatch was built for
 * OTHER keys -- an index-sidecar entry, or a runtime one this static check
 * cannot name. Every declared field also has a `gea_present_<key>` bit for
 * that generic dispatch, and it defaults to `true` for a required field
 * (correct for a field a plain initializer or a `this.x =` sets before any
 * other code observes it) -- but a field established ONLY by
 * `Object.defineProperty` has no such write, so treating it as already
 * present there applies 6.2.5.6's REDEFINE rule to what is really a FIRST
 * definition, and a generic descriptor stating only "value" then short-circuits
 * against a `NativeIndexAttributes` default of writable/enumerable/configurable
 * all `true` -- silently granting three attributes the call never stated.
 */
const declaredFixedFieldOf = (ctx: EmitContext, representation: Representation, key: string): RecordField | null => {
  const fields =
    representation.kind === 'record' || representation.kind === 'record-with-index'
      ? representation.fields
      : representation.kind === 'class-ref'
        ? recordFieldsOfShape(ctx.deriver, representation.shapeId)
        : representation.kind === 'native-record-ref' && representation.native === null
          ? recordFieldsOfShape(ctx.deriver, representation.shapeId)
          : null
  return fields?.find((field) => field.key === key) ?? null
}

/**
 * Do not send a named native slot through nativeDynamicDefineProperty first:
 * a deleted configurable fixed field no longer reads as present, but it is
 * still a declared slot and must be redefined there rather than shadowed in
 * the expando. The generated match hooks retain that distinction.
 */
const generatedDefineOwnText = (receiver: string, key: string, descriptor: string): string =>
  `([&]() -> bool { const gea::PropertyKey __gea_key = ${key}; ` +
  `if (${receiver}->gea_matchesOwnField(__gea_key)) return ${receiver}->gea_defineOwnField(__gea_key, ${descriptor}, gea::nativeIsExtensible(${receiver})); ` +
  `if (${receiver}->gea_matchesOwnIndex(__gea_key)) return ${receiver}->gea_defineOwnIndex(__gea_key, ${descriptor}, gea::nativeIsExtensible(${receiver})); ` +
  `return gea::nativeDynamicDefineProperty(${receiver}, __gea_key, ${descriptor}); })()`

/**
 * `Object.freeze` / `Object.isFrozen` -- the two members of this family that
 * are NOT a loop over the three primitives.
 *
 * A generated shared object keeps this state in its identity-keyed native
 * sidecar. Static, computed and boxed writes all consult that same state, so
 * the object keeps its native carrier while `freeze` makes its declared fields
 * non-writable and its expando table non-extensible.
 */
const integrityText = (
  ctx: EmitContext,
  member: string,
  operation: CallOperation,
  call: 'freeze' | 'isFrozen' | 'isExtensible' | 'seal' | 'isSealed' | 'preventExtensions'
): string => {
  const target = targetOf(ctx, member, operation)
  if (target.representation.kind === 'array-object' && target.representation.ownership === 'shared-refcount') {
    if (call === 'seal' || call === 'isSealed' || call === 'preventExtensions') {
      return refuseObjectCarrier(member, target.representation, 'this array path has no native seal/preventExtensions implementation')
    }
    const helper = call === 'freeze' ? 'Freeze' : call === 'isFrozen' ? 'IsFrozen' : 'IsExtensible'
    return `gea::native${helper}(${operandText(ctx, target)})`
  }
  if (regexpRoleOf(target.representation) === 'pattern') {
    const receiver = operandText(ctx, target)
    const expando = `gea::detail::expandoFor(gea::refCastToVoid(${receiver}), true)`
    if (call === 'freeze') return `gea::nativeFreeze(${receiver})`
    if (call === 'isFrozen') return `gea::nativeIsFrozen(${receiver})`
    if (call === 'isExtensible') return `gea::nativeIsExtensible(${receiver})`
    if (call === 'preventExtensions') return `([&]() { ${expando}->preventExtensions(); return ${receiver}; })()`
    if (call === 'seal') {
      return (
        `([&]() { const auto __gea_sidecar = ${expando}; ` +
        'for (const auto& __gea_key : __gea_sidecar->ownKeys()) { gea::PropertyDescriptor __gea_update; __gea_update.hasConfigurable = true; __gea_update.configurable = false; ' +
        'if (!__gea_sidecar->defineOwnProperty(__gea_key, __gea_update)) gea::host::throwRuntimeError("TypeError", "Cannot seal Pattern own property"); } ' +
        `__gea_sidecar->preventExtensions(); return ${receiver}; })()`
      )
    }
    return (
      `([&]() -> bool { const auto __gea_sidecar = gea::detail::expandoFor(gea::refCastToVoid(${receiver}), false); ` +
      'if (!__gea_sidecar || __gea_sidecar->extensible()) return false; for (const auto& __gea_key : __gea_sidecar->ownKeys()) { ' +
      'const gea::PropertyDescriptor* __gea_descriptor = __gea_sidecar->ownProperty(__gea_key); if (__gea_descriptor != nullptr && __gea_descriptor->configurable) return false; } return true; })()'
    )
  }
  const view = objectViewOf(ctx, member, target, 'object')
  if (view.kind === 'dynamic') {
    if (call === 'seal' || call === 'isSealed' || call === 'preventExtensions') {
      return refuseObjectCarrier(member, target.representation, 'the dynamic Object runtime has no seal/preventExtensions member')
    }
    return `gea::host::ObjectConstructor::${call}(${view.receiver})`
  }
  if (
    view.kind === 'known' &&
    (view.representation.kind === 'record' ||
      view.representation.kind === 'record-with-index' ||
      view.representation.kind === 'native-record-ref' ||
      view.representation.kind === 'class-ref') &&
    view.representation.ownership === 'shared-refcount'
  ) {
    const generated =
      view.representation.kind === 'record' ||
      view.representation.kind === 'record-with-index' ||
      view.representation.kind === 'class-ref' ||
      (view.representation.kind === 'native-record-ref' && view.representation.native === null)
    const receiver = view.receiver
    const expando = `gea::detail::expandoFor(gea::refCastToVoid(${receiver}), true)`
    if (call === 'freeze') {
      const fields = generated ? `${receiver}->gea_freezeOwnFields(); ${receiver}->gea_freezeOwnIndex(); ` : ''
      return `([&]() { ${fields}gea::nativeFreeze(${receiver}); return ${receiver}; })()`
    }
    if (call === 'isFrozen') {
      const fields = generated ? `${receiver}->gea_ownFieldsFrozen() && ${receiver}->gea_ownIndexFrozen() && ` : ''
      return `${fields}gea::nativeIsFrozen(${receiver})`
    }
    if (call === 'isExtensible') return `gea::nativeIsExtensible(${receiver})`
    if (call === 'preventExtensions') return `([&]() { ${expando}->preventExtensions(); return ${receiver}; })()`
    if (call === 'seal') {
      const fields = generated ? `${receiver}->gea_sealOwnFields(); ${receiver}->gea_sealOwnIndex(); ` : ''
      return (
        `([&]() { ${fields}const auto __gea_sidecar = ${expando}; ` +
        'for (const auto& __gea_key : __gea_sidecar->ownKeys()) { gea::PropertyDescriptor __gea_update; __gea_update.hasConfigurable = true; __gea_update.configurable = false; ' +
        'if (!__gea_sidecar->defineOwnProperty(__gea_key, __gea_update)) gea::host::throwRuntimeError("TypeError", "Cannot seal native own property"); } ' +
        `__gea_sidecar->preventExtensions(); return ${receiver}; })()`
      )
    }
    const fields = generated ? `if (!${receiver}->gea_ownFieldsSealed() || !${receiver}->gea_ownIndexSealed()) return false; ` : ''
    return (
      `([&]() -> bool { ${fields}const auto __gea_sidecar = gea::detail::expandoFor(gea::refCastToVoid(${receiver}), false); ` +
      'if (!__gea_sidecar || __gea_sidecar->extensible()) return false; for (const auto& __gea_key : __gea_sidecar->ownKeys()) { ' +
      'const gea::PropertyDescriptor* __gea_descriptor = __gea_sidecar->ownProperty(__gea_key); if (__gea_descriptor != nullptr && __gea_descriptor->configurable) return false; } return true; })()'
    )
  }
  return refuseObjectCarrier(
    member,
    view.representation,
    'an integrity level needs a stable object identity; this carrier is held by value, so no identity-keyed native ' +
      'sidecar can preserve the state across aliases'
  )
}

/**
 * `Object.getPrototypeOf(o)` -- the target's own `[[Prototype]]` slot
 * (ECMA-262 20.1.2.9), for the one receiver shape that actually HAS one at
 * runtime: a value the program declared `any`/`unknown`, whose own
 * `gea::DynamicObject` already carries and honours a real `[[Prototype]]`
 * link (`instanceof`/`in` already walk it). A statically typed receiver --
 * a record, a class instance -- has no such slot this backend models at all
 * (this compiler's classes carry no runtime prototype chain, per this file's
 * own header comment), so those refuse by name rather than fabricating
 * `null` or `Object.prototype`.
 */
const getPrototypeOfText = (ctx: EmitContext, operation: CallOperation): string => {
  const member = 'getPrototypeOf'
  const view = objectViewOf(ctx, member, targetOf(ctx, member, operation), 'object')
  if (view.kind === 'dynamic') return `gea::host::ObjectConstructor::getPrototypeOf(${view.receiver})`
  if (view.kind === 'dictionary') {
    return refuseDictionaryArm(member, view, 'a native Dictionary carries no [[Prototype]] slot this backend models')
  }
  return refuseObjectCarrier(
    member,
    view.representation,
    'this backend gives no statically typed carrier a runtime [[Prototype]] slot -- only a value the program itself ' +
      'declared dynamic carries one'
  )
}

/**
 * `Object.hasOwn(array, key)` for an Array exotic receiver -- its own
 * dedicated arm for the same reason `keysText` has one: an Array's own keys
 * are never a `RecordField` list `objectViewOf` could hand back, they are its
 * indices, `length`, and whatever the extended interface (`raw`) declares.
 *
 * Only a spelled-constant key answers: an index and `length` are exactly the
 * facts `arrayOwnPropertyNames` above already enumerates, checked here
 * directly rather than by building and scanning that list. `array->present`
 * is the same presence bit that distinguishes a `pushUndefined`-installed
 * cooked slot (present, valued `undefined`) from a hole -- ECMA-262's
 * invalid-escape cooked value is a real own property, not an absence, and
 * this has to agree with `Object.keys`/`getOwnPropertyNames` about that or
 * the two would disagree over the one array they both read.
 */
const arrayHasOwnText = (
  ctx: EmitContext,
  array: Extract<Representation, { kind: 'array-object' }>,
  receiver: string,
  key: IrOperand
): string => {
  const spelled = ctx.staticKeyTexts.get(key.value)
  if (spelled === undefined) {
    return refuseObjectCarrier(
      'hasOwn',
      array,
      "the key is not a constant this program spells, so the answer is a search over the array's own index/length/extension " +
        'keys, which is not installed'
    )
  }
  if (spelled === 'length') return 'true'
  const extensionField = array.extension?.find((field) => field.key === spelled)
  if (extensionField !== undefined) {
    if (extensionField.required) return 'true'
    const struct = cppArrayExtensionStructName(array.extension ?? [])
    return `${receiver}->template extensionFields<${struct}>().${cppRecordFieldPresenceName(extensionField.key)}`
  }
  const index = canonicalIndexLiteral(spelled)
  if (index === null) return 'false'
  return `(static_cast<std::size_t>(${index}) < ${receiver}->size() && ${receiver}->present(${index}))`
}

/**
 * `Object.hasOwn(o, key)` -- membership in primitive 1.
 *
 * With a literal key against a known shape the answer is a compile-time
 * constant, except for an optional field, where it is exactly the presence
 * test primitive 1 already uses to decide whether that key is in the list. A
 * key this program does not spell as a constant refuses: the answer would be
 * a search over the struct's key set, which is what the emitted struct's own
 * `gea_readOwnField` is for, and reaching it needs the receiver boxed.
 */
const hasOwnText = (ctx: EmitContext, operation: CallOperation): string => {
  const target = targetOf(ctx, 'hasOwn', operation)
  const key = operation.arguments[1]
  if (key === undefined)
    throw createCppEmitBlockedError('host-member-call:Object.hasOwn', '"Object.hasOwn" takes a property key, and this call passes none')
  if (regexpRoleOf(target.representation) === 'pattern') {
    return `gea::nativeDynamicHas(${operandText(ctx, target)}, ${propertyKeyText(ctx, 'hasOwn', key)})`
  }
  if (target.representation.kind === 'array-object') return arrayHasOwnText(ctx, target.representation, operandText(ctx, target), key)
  const view = objectViewOf(ctx, 'hasOwn', target, 'object')
  if (view.kind === 'dynamic') return `gea::host::ObjectConstructor::hasOwn(${view.receiver}, ${propertyKeyText(ctx, 'hasOwn', key)})`
  if (view.kind === 'dictionary') {
    // A dictionary answers membership itself, and for ANY key rather than only
    // a constant one: `has` is the table's own lookup, which is what
    // `HasOwnProperty` over an ordinary object with no prototype means.
    //
    // A number-keyed table's OWN Representation.kind is never literally
    // `'number'` -- there is no such carrier kind, a JS number is `scalar`
    // with `domain: 'number'` -- so it is matched by domain instead of by the
    // string/symbol carriers' direct kind equality below.
    const matches =
      view.representation.key === 'number'
        ? key.representation.kind === 'scalar' && key.representation.domain === 'number'
        : key.representation.kind === view.representation.key
    if (!matches) {
      return refuseDictionaryArm(
        'hasOwn',
        view,
        `the key carries "${representationKey(key.representation)}" rather than the table's "${view.representation.key}" key domain`
      )
    }
    return `${view.receiver}.has(${operandText(ctx, key)})`
  }
  // A claim, not a fold: this decides whether the key is a name this backend
  // can resolve at compile time or must refuse below, so it must not see a
  // key text `constantTexts` only holds because the render minted it (e.g. a
  // folded `typeof` result reaching here as the tested key).
  const spelled = ctx.staticKeyTexts.get(key.value)
  if (spelled === undefined) {
    return refuseObjectCarrier(
      'hasOwn',
      view.representation,
      "the key is not a constant this program spells, so the answer is a search over the struct's own key set -- which " +
        'its `gea_readOwnField` dispatcher performs, and reaching that needs the receiver to be the dynamic value it is not'
    )
  }
  const field = view.fields.find((candidate) => candidate.key === spelled)
  if (field === undefined) return 'false'
  return ownKeyPresenceText('hasOwn', view, field) ?? 'true'
}

/**
 * A Math-shaped host method, materialized as a genuine captureless callable
 * VALUE rather than called -- for `getOwnPropertyDescriptor`'s own `.value`,
 * ECMA-262's declared `any` position (6.1.7.1), one of the four boundaries
 * where boxing is the correct carrier rather than the forbidden shortcut.
 *
 * The ABI is SYNTHESIZED rather than read off any declared signature, because
 * `HostMember`'s own `'method'` row states only a spelling and an arity, not
 * C++ parameter/result types -- and every intrinsic this arm reaches today
 * (`Math`'s own methods) really is `(number...) -> number`, the assumption
 * `gea_runtime.h`'s whole `Math` namespace and every one of its
 * `host-members.ts` rows already bakes in. A future protocol whose methods
 * are NOT all-double would need real per-member ABI data threaded through
 * `HostIntrinsicMember` -- this does not invent one, and would produce C++
 * that fails to compile for such a member rather than a silently wrong value,
 * which `hostFunctionValueText` returning `null` for an unbuilt shape already
 * guarantees.
 */
const mathShapedHostMethodValueText = (arity: number, spelling: string): string | null => {
  const parameter: Representation = { kind: 'scalar', domain: 'number' }
  const abi: CallableAbi = {
    parameters: Array.from({ length: arity }, () => ({
      value: parameter,
      ownership: 'owned' as const,
      passing: passingOf(parameter, 'owned')
    })),
    result: parameter,
    receiver: null,
    restFrom: null
  }
  return hostFunctionValueText({ kind: 'function-value-dispatch', abi }, { kind: 'path', text: spelling })
}

/**
 * `Math.max`/`Math.min`/`Math.hypot` are the one exception `mathShapedHostMethodValueText`'s
 * own comment already flags as unbuilt: ECMA-262 declares each with a REST
 * parameter (`...values: number[]`), so `requiredArityOf` (host-protocols.ts)
 * correctly counts zero REQUIRED params -- but `gea_runtime.h` implements all
 * three as `gea::CallableObject<double(gea::Ref<gea::ArrayObject<double>>)>`
 * (`Math::max`/`min`/`hypot`, gea_runtime.h), one PACKED-ARRAY parameter, not
 * zero scalar ones. A zero-arity all-double wrapper compiles clean (nothing
 * checks a `CallableObject`'s signature against `arity` at build time) and
 * then fails to LINK the moment C++ actually resolves the call inside it --
 * `max_invoke`/`min_invoke`/`hypot_invoke` all take exactly one
 * `Ref<ArrayObject<double>>`, so `gea::host::Math::max()` (zero args) has no
 * overload. Named by protocol member rather than inferred from a signature
 * shape, for the same reason `mathShapedHostMethodValueText` does not invent
 * one: this is the one contained special case, not a general rule.
 */
const mathPackedRestMethods: ReadonlySet<string> = new Set(['max', 'min', 'hypot'])

const mathPackedRestHostMethodValueText = (spelling: string): string | null => {
  const element: Representation = { kind: 'scalar', domain: 'number' }
  const parameter: Representation = { kind: 'array-object', element, ownership: 'shared-refcount', extension: null }
  const abi: CallableAbi = {
    // `ownership` here is the ABI's own passing-mode override
    // (`cppAbiParameterType`, `types.ts`), separate from `parameter`'s own
    // representation ownership -- the real runtime signature takes a
    // `gea::Ref<gea::ArrayObject<double>>` (gea_runtime.h's own
    // `max`/`min`/`hypot` `CallableObject`), so this must match that
    // shared-refcount passing mode, not fall to `cppTypeOf`'s bare-value
    // default for `'owned'`.
    parameters: [{ value: parameter, ownership: 'shared-refcount' as const, passing: passingOf(parameter, 'shared-refcount') }],
    result: element,
    receiver: null,
    restFrom: null
  }
  return hostFunctionValueText({ kind: 'function-value-dispatch', abi }, { kind: 'path', text: spelling })
}

/**
 * The shared machinery `nativeHandleDescriptorText` and
 * `arrayObjectDescriptorText` both need: build the
 * `Object.getOwnPropertyDescriptor` result DIRECTLY in whatever record shape
 * the checker published for the call (`operation.result.representation` --
 * TS's own ambient `PropertyDescriptor | undefined`), rather than a native
 * `Descriptor` handle. Nothing converts a native record into the checker's
 * chosen shape (`hostResultText`, `emit-host-arity.ts`, only crosses
 * array/typed-array carriers), so building the wrong type here is a link
 * error, not a runtime one.
 *
 * A `record`/`record-with-index` carries its own `fields` inline; a
 * `native-record-ref` names a shape and goes through `recordFieldsOfShape`
 * instead, the same authority `knownDescriptorText` and
 * `cppRecordDeclarations` both read from (`records.ts`'s own header comment
 * on `recordFieldsOfShape`) -- so this is never a second, independently
 * drifting opinion about the descriptor's own layout.
 *
 * `aggregateOf`'s designated-init pattern mirrors `knownDescriptorText`'s
 * own a few lines below: every field not explicitly named defaults to its
 * declared type's own default (`gea::Optional<T>()` is absent, matching "no
 * accessor" for `get`/`set`, and "no id yet" for whichever `writable` /
 * `enumerable` / `configurable` field is not among the three passed).
 */
const descriptorAggregateBuilder = (
  ctx: EmitContext,
  resultRepresentation: Representation,
  contextLabel: string
): {
  readonly resultType: string
  readonly someText: (aggregate: string) => string
  readonly absentText: () => string
  readonly aggregateOf: (overrides: Readonly<Record<string, string>>, present: Readonly<Record<string, string>>) => string
  readonly convertValueField: (source: Representation, text: string) => string
  readonly attributeText: (key: string, has: string, value: string) => string
  readonly valueFieldRepresentation: Representation | null
} => {
  const optional = resultRepresentation.kind === 'optional' ? resultRepresentation : null
  const recordRepresentation = optional ? optional.payload : resultRepresentation
  const structNameAndFields = ((): {
    readonly structName: string
    readonly fields: readonly RecordField[]
    readonly ownership: Ownership
  } | null => {
    if (recordRepresentation.kind === 'record' || recordRepresentation.kind === 'record-with-index') {
      return {
        structName: cppRecordStructName(recordRepresentation.shapeId),
        fields: recordRepresentation.fields,
        ownership: recordRepresentation.ownership
      }
    }
    if (recordRepresentation.kind === 'native-record-ref') {
      const fields = recordFieldsOfShape(ctx.deriver, recordRepresentation.shapeId)
      if (fields === null) return null
      return {
        structName: recordRepresentation.native ?? cppRecordStructName(recordRepresentation.shapeId),
        fields,
        ownership: recordRepresentation.ownership
      }
    }
    return null
  })()
  if (structNameAndFields === null) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.getOwnPropertyDescriptor',
      `${contextLabel} builds the descriptor as a native record, and the call's own published result is carried as ` +
        `"${representationKey(recordRepresentation)}" instead`
    )
  }
  const { structName, fields, ownership } = structNameAndFields
  const resultType = cppTypeOf(resultRepresentation)
  const someText = (aggregate: string): string => (optional ? `${resultType}(${aggregate})` : aggregate)
  const absentText = (): string => {
    if (optional === null) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.getOwnPropertyDescriptor',
        `${contextLabel} whose result is not optional has no way to answer an absent key`
      )
    }
    return `${resultType}()`
  }
  // `records.ts`'s own struct-emission comment: presence bits follow every
  // value/index member "so existing aggregate initializers keep their
  // positional field layout; the conversion emitters that construct an
  // optional shape set these trailing bits explicitly after construction."
  // A field this arm actually populates (`value`/`writable`/`enumerable`/
  // `configurable` for a real descriptor) is meaningless without ALSO
  // setting its presence bit -- `d.value` and every other optional-field
  // read the emitter builds gates through `gea_present_<field>` before ever
  // looking at the value member (`emit-properties.ts`'s finite-record read),
  // so leaving it at its `= false` default answers `undefined` regardless of
  // what the value member holds. `present` states, per field key, the
  // boolean EXPRESSION its presence bit should hold (usually the literal
  // `'true'`, but a genuinely dynamic descriptor -- `dynamicDescriptorConversionText`
  // -- mirrors the native `Descriptor`'s own `hasX` flags instead).
  const aggregateOf = (overrides: Readonly<Record<string, string>>, present: Readonly<Record<string, string>>): string => {
    const fieldsText = fields
      .map((field) => `.${cppRecordFieldName(field.key)} = ${overrides[field.key] ?? `${cppTypeOf(field.value)}()`}`)
      .join(', ')
    const aggregate = `${structName}{${fieldsText}}`
    const built = ownership === 'shared-refcount' ? `gea::makeRef<${structName}>(${aggregate})` : aggregate
    // A field this record marks `required` was never given a presence bit at
    // all (`records.ts`'s own struct emission: `if (!field.required) ... bool
    // gea_present_<key>`), which is exactly the case for a descriptor whose
    // attributes are ALWAYS fully known -- an array's own "length", or a user
    // function's "name"/"length" -- so gate on the field's own required-ness,
    // not merely on whether `present` names it (every caller here states all
    // four keys in `present` unconditionally; a struct with no such member
    // would otherwise fail to compile, "no member named gea_present_<key>").
    const presentKeys = fields.filter((field) => present[field.key] !== undefined).map((field) => field.key)
    if (presentKeys.length === 0) return built
    const accessor = ownership === 'shared-refcount' ? '->' : '.'
    // `__gea_record`, not `__gea_desc`: the sidecar reader below binds
    // `const gea::PropertyDescriptor* __gea_desc` in the enclosing lambda and
    // then builds this record FROM it, so a same-named local here would shadow
    // the source inside its own initializer -- clang refuses "variable declared
    // with deduced type 'auto' cannot appear in its own initializer", which is
    // exactly how composed-field-descriptor.runtime.js failed to compile.
    const statements = presentKeys.map((key) => `__gea_record${accessor}${cppRecordFieldPresenceName(key)} = ${present[key]};`).join(' ')
    return `([&]() { auto __gea_record = ${built}; ${statements} return __gea_record; })()`
  }
  // The record's own `value` field carries whatever `objectDescriptorReturnTypeAt`
  // minted for the WHOLE call site -- a union across receivers when one call
  // (`describe`'s runtime key) reaches more than one arm here. A single arm's
  // own value text (a bare `double` cast, a boxed `gea::Value`, ...) carries a
  // narrower type than that union, so it must widen through the same
  // conversion `knownDescriptorText` already uses for its own "value" field,
  // rather than an implicit struct-literal conversion clang has none for.
  const valueField = fields.find((field) => field.key === 'value')
  const valueFieldRepresentation = valueField?.value ?? null
  // An attribute read back off a runtime `gea::PropertyDescriptor` (a
  // sidecar's own property) is a `bool` plus its presence flag. The record it
  // lands in spells the attribute either way: the ambient `PropertyDescriptor`
  // declares `writable?: boolean` (an `optional`, absent when the flag is
  // off), while the record `objectDescriptorReturnTypeAt` mints for an array
  // or object literal receiver declares it a required `boolean`. Only the
  // field's own carrier says which, so the spelling is read from it.
  const attributeText = (key: string, has: string, value: string): string => {
    const field = fields.find((candidate) => candidate.key === key)
    if (field === undefined || field.value.kind !== 'optional') return value
    const type = cppTypeOf(field.value)
    return `(${has} ? ${type}(${value}) : ${type}())`
  }
  const convertValueField = (source: Representation, text: string): string => {
    if (valueFieldRepresentation === null) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.getOwnPropertyDescriptor',
        `${contextLabel} descriptor names no "value" field to store into`
      )
    }
    if (representationKey(source) === representationKey(valueFieldRepresentation)) return text
    const converted = alignedValueText(ctx, 'host/emit-host-object.ts:853', source, valueFieldRepresentation, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.getOwnPropertyDescriptor',
        `${contextLabel} would store "${representationKey(source)}" into the descriptor's own "value" field carried as ` +
          `"${representationKey(valueFieldRepresentation)}", and no installed conversion performs that`
      )
    }
    return converted
  }
  return { resultType, someText, absentText, aggregateOf, convertValueField, attributeText, valueFieldRepresentation }
}

/**
 * The descriptor a native-handle intrinsic's own member answers
 * `getOwnPropertyDescriptor` with, from the SAME static table
 * `nativeHandleShapeCallText`'s `hasOwnProperty` reads
 * (`ctx.hosts.intrinsicMembers`) -- see that table's own comment for where it
 * comes from. The two ECMA-262 attribute sets this backend states (21.3.1's
 * value constants; 10.2.4's builtin methods) are exactly the two
 * `HostIntrinsicMember.kind` arms, so the classification IS the descriptor.
 *
 * The result is built DIRECTLY in whatever record shape the checker
 * published for this call (`operation.result.representation` -- TS's own
 * ambient `PropertyDescriptor | undefined`, e.g. `gea_record_type_50`),
 * never a native `Descriptor` handle: nothing converts that native shape
 * into the checker's record (`hostResultText` only crosses array/typed-array
 * carriers), so building the wrong type here is a link error, not a runtime
 * one. `aggregateOf` mirrors `knownDescriptorText`'s own designated-init
 * pattern a few lines below: every field not explicitly named defaults to
 * its declared type's own default (`gea::Optional<T>()` is absent, matching
 * "no accessor" for `get`/`set`).
 *
 * A literal key folds at compile time; a runtime key (every call this
 * program makes reaches here through `describe`'s shared, unioned parameter,
 * so its key is a runtime string, never a literal) becomes a switch over the
 * same finite list `nativeHandleShapeCallText` switches over.
 */
/**
 * One host intrinsic member as the runtime sees it: its value boxed as a
 * `gea::Value`, and the three attributes ECMA-262 gives it by default (a
 * 21.3.1-style constant is non-writable, non-enumerable, non-configurable; a
 * builtin's own method is writable, non-enumerable, configurable, 10.2.4).
 *
 * This is the ONE place a member's value spelling and its attribute defaults
 * are stated together, because two readers need both and must never
 * disagree: `Object.getOwnPropertyDescriptor(Math, k)` (the descriptor built
 * below) and a COMPUTED-key access -- `obj[name]`, `obj[name] = v`,
 * `delete obj[name]` over a namespace-shaped native-handle
 * (`emit-host-properties.ts`, `emit-dynamic-properties.ts`) -- where
 * test262's `verifyProperty` reads the member back, writes a fresh value to
 * probe writability and deletes it to probe configurability. Both answer from
 * this table; a member whose descriptor says non-writable and whose store
 * then succeeded would be a lie the harness detects.
 */
export interface IntrinsicMemberValue {
  readonly value: string
  readonly writable: boolean
  readonly enumerable: boolean
  readonly configurable: boolean
}

export const intrinsicMemberValueOf = (
  ctx: EmitContext,
  protocol: string,
  found: HostIntrinsicMember,
  site: string
): IntrinsicMemberValue => {
  const host = hostMemberOf(ctx.hosts.members, protocol, found.name)
  if (found.kind === 'value') {
    if (host?.kind !== 'property' || host.emit === null) {
      throw createCppEmitBlockedError(
        `host-invocation:${protocol}.${found.name}`,
        `${site}: "${protocol}.${found.name}" is a reflectable data member with no host property row to read its value from`
      )
    }
    return {
      value: `gea::Value::box(gea::Value::Tag::Number, static_cast<double>(${host.emit}))`,
      writable: false,
      enumerable: false,
      configurable: false
    }
  }
  if (host === undefined && protocol.endsWith('.prototype')) {
    const callable = hostPrototypeMethodValueText('void()', protocol, found.name, hostIntrinsicLengthOf(protocol, found.name, found.arity))
    return { value: `gea::Value::box(gea::Value::Tag::Function, ${callable})`, writable: true, enumerable: false, configurable: true }
  }
  const emit = host?.kind === 'property' ? host.emit : host?.kind === 'method' ? host.emit : null
  if (emit === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}.${found.name}`,
      `${site}: "${protocol}.${found.name}" is a reflectable method with no host row stating a callable spelling to build a value from`
    )
  }
  const arity = host?.kind === 'method' && typeof host.arity === 'number' ? host.arity : (found.arity ?? 0)
  const callable =
    protocol === 'Math' && mathPackedRestMethods.has(found.name)
      ? mathPackedRestHostMethodValueText(emit)
      : mathShapedHostMethodValueText(arity, emit)
  if (callable === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${protocol}.${found.name}`,
      `${site}: "${protocol}.${found.name}" has no callable-value rendering for its own value`
    )
  }
  return { value: `gea::Value::box(gea::Value::Tag::Function, ${callable})`, writable: true, enumerable: false, configurable: true }
}

const nativeHandleDescriptorText = (ctx: EmitContext, protocol: string, key: IrOperand, operation: CallOperation): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.getOwnPropertyDescriptor',
      `"Object.getOwnPropertyDescriptor" of "${protocol}" published no result to build a descriptor into`
    )
  }
  const { resultType, someText, absentText, aggregateOf, attributeText, convertValueField } = descriptorAggregateBuilder(
    ctx,
    resultRepresentation,
    `"Object.getOwnPropertyDescriptor" of "${protocol}"`
  )
  const absent = absentText()
  // Every value here is a box (a member's own boxed value, or the sidecar's
  // stored one); the published `value` field may be the union of the
  // intrinsic's member types with a boxed remainder, so each is converted
  // into the field's own carrier rather than assigned as a bare `gea::Value`.
  const boxed = (text: string): string => convertValueField(dynamicCarrier, text)
  const descriptorOf = (found: HostIntrinsicMember): string => {
    const member = intrinsicMemberValueOf(ctx, protocol, found, `"Object.getOwnPropertyDescriptor" of "${protocol}"`)
    return someText(
      aggregateOf(
        {
          value: boxed(member.value),
          writable: String(member.writable),
          enumerable: String(member.enumerable),
          configurable: String(member.configurable)
        },
        { value: 'true', writable: 'true', enumerable: 'true', configurable: 'true' }
      )
    )
  }
  const members = ctx.hosts.intrinsicMembers.get(protocol) ?? []
  const site = `"Object.getOwnPropertyDescriptor" of "${protocol}"`
  // A claim, not a fold: this decides whether a non-configurable member folds
  // to a compile-time descriptor below or falls through to the sidecar/switch
  // dispatch, so it must not see a key text `constantTexts` only holds because
  // the render minted it (e.g. a folded `typeof` result reaching here as the key).
  const spelled = ctx.staticKeyTexts.get(key.value)
  const named = spelled === undefined ? undefined : members.find((candidate) => candidate.name === spelled)
  // A non-configurable, non-writable member is the one own property nothing
  // can change, so its descriptor folds at compile time. Every other key is
  // asked of the intrinsic's dynamic-property sidecar first: a member
  // `delete`d through a runtime key is absent, and one overridden (or a key
  // `Object.defineProperty` added) answers with the descriptor the sidecar
  // holds -- `hasOwnProperty` (`object-protocol.ts`) consults the same table
  // in the same order, so the two never disagree about membership.
  if (named !== undefined) {
    const fixed = intrinsicMemberValueOf(ctx, protocol, named, site)
    if (!fixed.configurable && !fixed.writable) return descriptorOf(named)
  }
  if (members.length === 0) return absent
  const sidecarDescriptor = someText(
    aggregateOf(
      {
        value: boxed('__gea_own.value'),
        writable: attributeText('writable', '__gea_own.hasWritable', '__gea_own.writable'),
        enumerable: attributeText('enumerable', '__gea_own.hasEnumerable', '__gea_own.enumerable'),
        configurable: attributeText('configurable', '__gea_own.hasConfigurable', '__gea_own.configurable')
      },
      {
        value: '__gea_own.hasValue',
        writable: '__gea_own.hasWritable',
        enumerable: '__gea_own.hasEnumerable',
        configurable: '__gea_own.hasConfigurable'
      }
    )
  )
  const arms = members
    .map((candidate) => `if (__gea_name == ${cppStringLiteral(candidate.name)}) return ${descriptorOf(candidate)};`)
    .join(' ')
  return (
    `([&]() -> ${resultType} { const gea::PropertyKey __gea_key = ${propertyKeyOperandText(ctx, key, site)}; ` +
    `auto& __gea_side = gea::detail::hostIntrinsicSidecar(${cppStringLiteral(protocol)}); ` +
    `{ gea::PropertyDescriptor __gea_own; if (__gea_side.ownDescriptor(__gea_key, __gea_own)) return ${sidecarDescriptor}; } ` +
    `if (__gea_side.isRemoved(__gea_key) || __gea_key.isSymbol()) return ${absent}; ` +
    `const std::string& __gea_name = __gea_key.text(); ${arms} return ${absent}; })()`
  )
}

/**
 * The descriptor an `array-object` receiver answers with -- built the same
 * way `nativeHandleDescriptorText` builds its own, directly into whatever
 * record shape the checker published for this call rather than a native
 * `Descriptor` handle (see that function's own header comment for why).
 *
 * The TRUE intrinsic own-property set of an Array instance (ECMA-262
 * 10.4.1) is its numeric indices and its own `length`. `join`, `push`, and
 * every other `Array.prototype` member are inherited, never an array
 * INSTANCE's own property. Additional own properties installed through the
 * native identity sidecar (notably GetTemplateObject's non-enumerable `raw`)
 * are read from that same sidecar rather than being guessed absent.
 *
 * `Array.prototype` uses the same native array carrier. Its own method
 * descriptors are installed on its stable identity sidecar, so this lookup
 * also serves the intrinsic without guessing its origin from a source name.
 *
 * A canonical index literal (`arr[0]`, `arr.getOwnPropertyDescriptor(arr,
 * "0")`) answers a REAL data descriptor -- ECMA-262 10.4.1: `{writable: true,
 * enumerable: true, configurable: true}` -- guarded at runtime by
 * `ArrayObject::hasElement`, the exact presence test `elementAt` aborts on the
 * negation of (`emit-carrier-members.ts`'s own `absentCapableElementText`
 * uses the same pair for an ordinary `arr[i]` read), so "present" can never
 * drift between an ordinary element read and this descriptor. A runtime key
 * goes through the runtime's one canonical Array-index parser before the
 * identity sidecar fallback, so `"0"`, `"length"`, `"raw"`, and an absent
 * string key all observe the same own-property set as their literal forms.
 */
const arrayObjectDescriptorText = (
  ctx: EmitContext,
  receiver: string,
  representation: Extract<Representation, { kind: 'array-object' }>,
  key: IrOperand,
  operation: CallOperation
): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.getOwnPropertyDescriptor',
      '"Object.getOwnPropertyDescriptor" of an array published no result to build a descriptor into'
    )
  }
  const { resultType, someText, absentText, aggregateOf, convertValueField, attributeText, valueFieldRepresentation } =
    descriptorAggregateBuilder(ctx, resultRepresentation, '"Object.getOwnPropertyDescriptor" of an array')
  const absent = absentText()
  const accessor = memberAccessOperator(representation.ownership)
  const writable = `gea::nativeOwnFieldsWritable(${receiver})`
  const sidecarDescriptor = (): string => {
    const aggregate = aggregateOf(
      {
        value: convertValueField({ kind: 'dynamic', reason: 'opt-in-fallback' }, '__gea_native->value'),
        writable: attributeText('writable', '__gea_native->hasWritable', '__gea_native->writable'),
        enumerable: attributeText('enumerable', '__gea_native->hasEnumerable', '__gea_native->enumerable'),
        configurable: attributeText('configurable', '__gea_native->hasConfigurable', '__gea_native->configurable')
      },
      {
        value: '__gea_native->hasValue',
        writable: '__gea_native->hasWritable',
        enumerable: '__gea_native->hasEnumerable',
        configurable: '__gea_native->hasConfigurable'
      }
    )
    const call = `gea::nativeOwnPropertyDescriptor(${receiver}, ${propertyKeyText(ctx, 'getOwnPropertyDescriptor', key)})`
    return (
      `([&]() -> ${resultType} { const auto __gea_native = ${call}; ` +
      `if (!__gea_native.has_value()) return ${absent}; return ${someText(aggregate)}; })()`
    )
  }
  const lengthDescriptor = (): string => {
    // The raw read is always a plain `double` -- `length()`'s own C++ return
    // type -- widened into whatever the descriptor's own "value" field is
    // ACTUALLY carried as for this call (a bare `double` when this is the
    // only arm reaching the call site, a wider union when `describe`'s
    // runtime key also reaches an object/function arm).
    const value = convertValueField({ kind: 'scalar', domain: 'number' }, `static_cast<double>(${receiver}${accessor}length())`)
    // ECMA-262 10.4.1: an Array's own "length" is {writable: true, enumerable: false, configurable: false}.
    return someText(
      aggregateOf(
        { value, writable, enumerable: 'false', configurable: 'false' },
        { value: 'true', writable: 'true', enumerable: 'true', configurable: 'true' }
      )
    )
  }
  // ECMA-262 10.4.1: a numeric index is {writable: true, enumerable: true,
  // configurable: true} when present, absent (never a partial descriptor)
  // otherwise -- `hasElement` is the exact presence test `elementAt` aborts
  // on the negation of, so the guard and the read can never disagree.
  const indexDescriptor = (index: string): string => {
    const descriptorWith = (value: string): string =>
      someText(
        aggregateOf(
          { value, writable, enumerable: 'true', configurable: writable },
          { value: 'true', writable: 'true', enumerable: 'true', configurable: 'true' }
        )
      )
    const value = convertValueField(representation.element, `${receiver}${accessor}elementAt(${index})`)
    // A malformed escape creates a PRESENT index whose value is undefined.
    // `elementAt` intentionally refuses that value under the checker's
    // string-only indexed type, so reflection must consult the explicit bit
    // first and build the descriptor's dynamic value without reading the
    // placeholder string cell. That bit is only ever set on a template's
    // raw-strings array; a descriptor whose "value" field cannot hold
    // `undefined` at all (a `number[]` literal's own minted record) is one
    // no such array reaches, and the branch is not spelled for it.
    const undefinedValue =
      valueFieldRepresentation === null
        ? null
        : alignedValueText(ctx, 'host/emit-host-object.ts:1145', { kind: 'undefined' }, valueFieldRepresentation, cppUndefinedValue)
    if (undefinedValue === null) return descriptorWith(value)
    return `(${receiver}${accessor}elementIsUndefined(static_cast<std::size_t>(${index})) ? ${descriptorWith(undefinedValue)} : ${descriptorWith(value)})`
  }
  // A claim, not a fold: this decides whether the key is "length", a canonical
  // index, or falls through to the runtime prelude below, so it must not see a
  // key text `constantTexts` only holds because the render minted it (e.g. a
  // folded `typeof` result reaching here as the tested key).
  const spelled = ctx.staticKeyTexts.get(key.value)
  if (spelled !== undefined) {
    if (spelled === 'length') return lengthDescriptor()
    const index = canonicalIndexLiteral(spelled)
    return index === null ? sidecarDescriptor() : `(${receiver}${accessor}hasElement(${index}) ? ${indexDescriptor(index)} : ${absent})`
  }
  const prelude = stringKeyPreludeText(ctx, key, '"Object.getOwnPropertyDescriptor" of an array', absent)
  const runtimeIndex = 'static_cast<double>(__gea_index)'
  return (
    `([&]() -> ${resultType} { ${prelude} if (__gea_key == "length") return ${lengthDescriptor()}; ` +
    `std::size_t __gea_index = 0; if (gea::detail::arrayIndexOfKey(gea::PropertyKey::string(__gea_key), __gea_index)) ` +
    `return ${receiver}${accessor}hasElement(${runtimeIndex}) ? ${indexDescriptor(runtimeIndex)} : ${absent}; ` +
    `return ${sidecarDescriptor()}; })()`
  )
}

/**
 * `Object.getOwnPropertyDescriptor` over a KNOWN (record, class-instance)
 * receiver -- the static half `emit-dynamic-properties.ts`'s
 * `finiteRecordUnionGetText` already renders for an ordinary member read,
 * adapted to build the four-field descriptor
 * `objectDescriptorReturnTypeAt` (`normalize/producers/shared.ts`) minted
 * for THIS call, rather than a bare member value.
 *
 * A literal key naming a declared field answers from that field directly,
 * with the ECMA-262 default data-descriptor attributes a plain object
 * literal's own property gets (10.1.11: `{writable:true, enumerable:true,
 * configurable:true}` -- this arm never runs for a key a `defineProperty`
 * call gave non-default attributes, because such a key names no declared
 * field and takes the sidecar arm below instead), gated by the field's own
 * presence bit when the field is declared optional. A runtime key switches
 * over the receiver's declared fields the same way `finiteRecordUnionGetText`
 * does for a plain read. A key -- literal or runtime -- naming no declared
 * field falls through to the object's dynamic-property sidecar, the one
 * place a key `Object.defineProperty` added after the fact lives, and reads
 * its `gea::PropertyDescriptor` back field-for-field: that boxed `value` is
 * the one accepted, bounded exception this feature carries (matching the
 * sidecar's own storage, `objectDescriptorReturnTypeAt`'s own header), never
 * a widening of a field this compiler already knows the type of.
 */
const knownDescriptorText = (
  ctx: EmitContext,
  member: string,
  view: Extract<ObjectView, { kind: 'known' }>,
  key: IrOperand,
  operation: CallOperation
): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" published no result to build a descriptor into`
    )
  }
  const { resultType, someText, absentText, aggregateOf, convertValueField, attributeText } = descriptorAggregateBuilder(
    ctx,
    resultRepresentation,
    `"Object.${member}" of a known receiver`
  )
  const aggregateFor = (valueSource: Representation, valueText: string, attributes: string): string =>
    aggregateOf(
      {
        value: convertValueField(valueSource, valueText),
        writable: attributeText('writable', 'true', `${attributes}.writable`),
        enumerable: attributeText('enumerable', 'true', `${attributes}.enumerable`),
        configurable: attributeText('configurable', 'true', `${attributes}.configurable`)
      },
      { value: 'true', writable: 'true', enumerable: 'true', configurable: 'true' }
    )
  // `gea::PropertyDescriptor::value` (gea_runtime.h) is a bare `gea::Value` --
  // ECMA-262's own descriptor stores `value` as `any`, and `Object.defineProperty`
  // only ever reaches the sidecar for a key with no declared field to type it
  // from (`definePropertyText`'s "known" arm), so a boxed carrier is this
  // path's genuinely correct, bounded source.
  const dynamicValueRepresentation: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const sidecarText = (): string => {
    if (view.accessor !== '->') {
      throw createCppEmitBlockedError(
        `host-member-call:Object.${member}`,
        `"Object.${member}" of a "${representationKey(view.representation)}" carrier has an "owned" receiver; a ` +
          "dynamic-property sidecar needs the object's own shared identity to key on"
      )
    }
    const propertyKey = propertyKeyText(ctx, member, key)
    const fromDescriptor = aggregateOf(
      {
        value: convertValueField(dynamicValueRepresentation, '__gea_desc->value'),
        writable: attributeText('writable', '__gea_desc->hasWritable', '__gea_desc->writable'),
        enumerable: attributeText('enumerable', '__gea_desc->hasEnumerable', '__gea_desc->enumerable'),
        configurable: attributeText('configurable', '__gea_desc->hasConfigurable', '__gea_desc->configurable')
      },
      {
        value: '__gea_desc->hasValue',
        writable: '__gea_desc->hasWritable',
        enumerable: '__gea_desc->hasEnumerable',
        configurable: '__gea_desc->hasConfigurable'
      }
    )
    return (
      `([&]() -> ${resultType} { const auto __gea_expando = gea::detail::expandoFor(gea::refCastToVoid(${view.receiver}), false); ` +
      `if (!__gea_expando) return ${absentText()}; ` +
      `const gea::PropertyDescriptor* __gea_desc = __gea_expando->ownProperty(${propertyKey}); ` +
      `if (__gea_desc == nullptr) return ${absentText()}; ` +
      `return ${someText(fromDescriptor)}; })()`
    )
  }
  // A claim, not a fold: this decides whether the key names a declared field
  // below or falls through to the dynamic-property sidecar, so it must not see
  // a key text `constantTexts` only holds because the render minted it (e.g. a
  // folded `typeof` result reaching here as the tested key).
  const literalKey = ctx.staticKeyTexts.get(key.value)
  if (literalKey !== undefined) {
    const field = view.fields.find((candidate) => candidate.key === literalKey)
    if (field === undefined) return sidecarText()
    const { text, representation: valueSource } = getOwnValue(ctx, view, field)
    const attributes = `${view.receiver}${view.accessor}${cppRecordFieldAttributesName(field.key)}`
    const aggregate = someText(aggregateFor(valueSource, text, attributes))
    const presence = ownKeyPresenceText(member, view, field)
    return presence === null ? aggregate : `(${presence} ? ${aggregate} : ${absentText()})`
  }
  if (key.representation.kind !== 'string') {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a known receiver received a key carried as "${representationKey(key.representation)}" rather ` +
        'than a string, and ToPropertyKey of anything else runs ToPrimitive, which this backend does not perform'
    )
  }
  const fields = ownKeyFields(view)
  if (fields.length === 0) return sidecarText()
  const runtimeKey = operandText(ctx, key)
  const arms = fields
    .map((field) => {
      const { text, representation: valueSource } = getOwnValue(ctx, view, field)
      const attributes = `${view.receiver}${view.accessor}${cppRecordFieldAttributesName(field.key)}`
      const aggregate = someText(aggregateFor(valueSource, text, attributes))
      const presence = ownKeyPresenceText(member, view, field)
      const answer = presence === null ? aggregate : `(${presence} ? ${aggregate} : ${absentText()})`
      return `if (__gea_key == ${cppStringLiteral(field.key)}) return ${answer};`
    })
    .join(' ')
  return `([&]() -> ${resultType} { const std::string& __gea_key = ${runtimeKey}; ${arms} return ${sidecarText()}; })()`
}

/**
 * `Object.getOwnPropertyDescriptor` of a genuinely dynamic (boxed
 * `gea::Value`) receiver -- e.g. `Array.from`, built as a real boxed
 * function value by `dynamicHostFunctionValueText` because its call-site
 * arity has no fixed ABI (one of the four sanctioned dynamic boundaries).
 * The runtime answers with its OWN `gea::Optional<Descriptor>`
 * (`Descriptor` inherits `PropertyDescriptor`'s real fields, `gea_runtime.h`
 * ~line 7790) computed at RUNTIME, since a dynamic receiver's own property
 * set cannot be enumerated statically -- but every arm a single call site
 * dispatches across (via `describe`'s own unioned parameter, when Math,
 * Array.prototype AND a dynamic function value all reach the same
 * `getOwnPropertyDescriptor` call) must share ONE C++ return type, so this
 * converts that native descriptor into the SAME checker-published record
 * shape `nativeHandleDescriptorText`/`arrayObjectDescriptorText` build into,
 * field for field, off `Descriptor`'s own `hasX` presence flags (6.2.6:
 * "states false" and "states nothing" are different, so a bare `bool` read
 * would silently invent an attribute the descriptor never claimed).
 *
 * `get`/`set` are left at their default absent: converting a native
 * `std::function` accessor into this record's `Optional<CallableObject<...>>`
 * field needs a std::function-to-CallableObject bridge this arm does not
 * build, and no consumer in this probe reads a descriptor's accessors.
 */
const dynamicDescriptorConversionText = (
  ctx: EmitContext,
  member: string,
  receiver: string,
  key: IrOperand,
  operation: CallOperation
): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a dynamic receiver published no result to build a descriptor into`
    )
  }
  const { resultType, someText, absentText, aggregateOf, attributeText, convertValueField } = descriptorAggregateBuilder(
    ctx,
    resultRepresentation,
    `"Object.${member}" of a dynamic receiver`
  )
  const nativeCall = `gea::host::ObjectConstructor::${member}(${receiver}, ${propertyKeyText(ctx, member, key)})`
  const aggregate = aggregateOf(
    {
      // The runtime's own descriptor keeps `value` boxed (`gea::Value`) even
      // though the call-site result may have narrowed the field to a typed
      // carrier -- exactly the widening `nativeHandleDescriptorText`'s `boxed`
      // helper already performs for a host member's own value. Without this,
      // an unboxed `gea::Value` reaches a struct literal typed `double` or
      // `std::string` and clang refuses the initializer outright.
      value: convertValueField(dynamicCarrier, '__gea_native->value'),
      writable: attributeText('writable', '__gea_native->hasWritable', '__gea_native->writable'),
      enumerable: attributeText('enumerable', '__gea_native->hasEnumerable', '__gea_native->enumerable'),
      configurable: attributeText('configurable', '__gea_native->hasConfigurable', '__gea_native->configurable')
    },
    {
      value: '__gea_native->hasValue',
      writable: '__gea_native->hasWritable',
      enumerable: '__gea_native->hasEnumerable',
      configurable: '__gea_native->hasConfigurable'
    }
  )
  return (
    `([&]() -> ${resultType} { const auto __gea_native = ${nativeCall}; ` +
    `if (!__gea_native.has_value()) return ${absentText()}; ` +
    `return ${someText(aggregate)}; })()`
  )
}

/** The same descriptor projection for a native object that keeps its concrete carrier (Pattern's lastIndex is the measured case). */
const nativeDescriptorConversionText = (
  ctx: EmitContext,
  member: string,
  receiver: string,
  key: IrOperand,
  operation: CallOperation
): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a native receiver published no result to build a descriptor into`
    )
  }
  const { resultType, someText, absentText, aggregateOf, attributeText, convertValueField } = descriptorAggregateBuilder(
    ctx,
    resultRepresentation,
    `"Object.${member}" of a native receiver`
  )
  const aggregate = aggregateOf(
    {
      // Same widening `dynamicDescriptorConversionText` performs, for the
      // identical reason: `gea::nativeOwnPropertyDescriptor` answers with a
      // boxed `Descriptor` regardless of what typed carrier the call site's
      // own result narrowed "value" to.
      value: convertValueField(dynamicCarrier, '__gea_native->value'),
      writable: attributeText('writable', '__gea_native->hasWritable', '__gea_native->writable'),
      enumerable: attributeText('enumerable', '__gea_native->hasEnumerable', '__gea_native->enumerable'),
      configurable: attributeText('configurable', '__gea_native->hasConfigurable', '__gea_native->configurable')
    },
    {
      value: '__gea_native->hasValue',
      writable: '__gea_native->hasWritable',
      enumerable: '__gea_native->hasEnumerable',
      configurable: '__gea_native->hasConfigurable'
    }
  )
  return (
    `([&]() -> ${resultType} { const auto __gea_native = gea::nativeOwnPropertyDescriptor(${receiver}, ` +
    `${propertyKeyText(ctx, member, key)}); if (!__gea_native.has_value()) return ${absentText()}; return ${someText(aggregate)}; })()`
  )
}

/**
 * Every native callable carrier whose identity owns an ordinary Function
 * property table -- including the one that is nothing BUT that identity. A
 * builtin with no single calling convention (`Array.from`) is carried as
 * `callable-identity`, and the table a descriptor read walks is the same
 * table; only the step that reaches it differs, since there is no thunk to
 * ask for `name`/`length` and no callable to box as the accessor receiver.
 */
const callableObjectCarrier = (representation: Representation): boolean =>
  representation.kind === 'function' ||
  representation.kind === 'function-family' ||
  representation.kind === 'function-value-family' ||
  representation.kind === 'function-value-dispatch' ||
  representation.kind === 'function-and-constructor' ||
  representation.kind === 'callable-identity'

/**
 * `Object.getOwnPropertyDescriptor` over a callable's CURRENT identity-owned
 * property table.
 *
 * `name` and `length` begin with their 10.2.10 descriptors, but both are
 * configurable: delete/redefine must therefore be observed from the table,
 * not reconstructed from immutable thunk facts. The same lookup also covers
 * expandos and the non-configurable `prototype` installed for a carrier that
 * retains both [[Call]] and [[Construct]]. The callable itself never widens to
 * Value; only a descriptor's language-level `value: any` field is dynamic.
 */
const callableDescriptorText = (
  ctx: EmitContext,
  representation: Representation,
  receiver: string,
  key: IrOperand,
  operation: CallOperation
): string => {
  const resultRepresentation = operation.result?.representation ?? null
  if (resultRepresentation === null) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.getOwnPropertyDescriptor',
      '"Object.getOwnPropertyDescriptor" of a function published no result to build a descriptor into'
    )
  }
  const { resultType, someText, absentText, aggregateOf, convertValueField, attributeText } = descriptorAggregateBuilder(
    ctx,
    resultRepresentation,
    '"Object.getOwnPropertyDescriptor" of a function'
  )
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const aggregate = aggregateOf(
    {
      value: convertValueField(dynamic, '__gea_descriptor->value'),
      writable: attributeText('writable', '__gea_descriptor->hasWritable', '__gea_descriptor->writable'),
      enumerable: attributeText('enumerable', '__gea_descriptor->hasEnumerable', '__gea_descriptor->enumerable'),
      configurable: attributeText('configurable', '__gea_descriptor->hasConfigurable', '__gea_descriptor->configurable')
    },
    {
      value: '__gea_descriptor->hasValue',
      writable: '__gea_descriptor->hasWritable',
      enumerable: '__gea_descriptor->hasEnumerable',
      configurable: '__gea_descriptor->hasConfigurable'
    }
  )
  // The identity half arrives with its facts already installed (the runtime's
  // `builtinFunctionIdentity` installs them where the object is first made),
  // and has no thunk to read a `name`/`length` back off, so it walks straight
  // to the table every other arm reaches through its callable.
  if (representation.kind === 'callable-identity') {
    return (
      `([&]() -> ${resultType} { const auto& __gea_identity = ${receiver}; ` +
      `const gea::PropertyKey __gea_key = ${propertyKeyOperandText(ctx, key, '"Object.getOwnPropertyDescriptor" of a callable')}; ` +
      'const gea::PropertyDescriptor* __gea_descriptor = __gea_identity->properties->ownProperty(__gea_key); ' +
      `if (__gea_descriptor == nullptr) return ${absentText()}; return ${someText(aggregate)}; })()`
    )
  }
  const constructorSetup =
    representation.kind === 'function-and-constructor'
      ? 'if (!__gea_key.isSymbol() && __gea_key.text() == "prototype") gea::installCallableConstructorPrototype(__gea_callable); '
      : ''
  return (
    `([&]() -> ${resultType} { const auto& __gea_callable = ${receiver}; ` +
    // A heap-environment callable anchors its identity lazily in its
    // environment block (`gea_runtime.h`'s `EnvironmentIdentityHeader`), not
    // in the `functionObject` field itself, so the field is not necessarily
    // what `functionObjectIdentity()` just resolved -- bind its result
    // instead of re-reading `functionObject` directly afterward.
    'const auto& __gea_callable_identity = __gea_callable.functionObjectIdentity(); ' +
    'gea::installCallableOwnFacts(__gea_callable_identity, __gea_callable.name(), __gea_callable.length()); ' +
    `const gea::PropertyKey __gea_key = ${propertyKeyOperandText(ctx, key, '"Object.getOwnPropertyDescriptor" of a callable')}; ` +
    `${constructorSetup}const gea::PropertyDescriptor* __gea_descriptor = ` +
    `__gea_callable_identity->properties->ownProperty(__gea_key); ` +
    `if (__gea_descriptor == nullptr) return ${absentText()}; return ${someText(aggregate)}; })()`
  )
}

/** Descriptor reflection over one generated typed index entry. */
const indexedRecordDescriptorText = (
  ctx: EmitContext,
  member: string,
  representation: Representation,
  receiver: string,
  key: IrOperand,
  operation: CallOperation
): string | null => {
  const indexedReceiver = indexedRecordReceiver(ctx, member, representation, receiver)
  if (indexedReceiver === null) return null
  return nativeDescriptorConversionText(ctx, member, indexedReceiver, key, operation)
}

/** `Object.getOwnPropertyDescriptor` -- primitive 2 plus a descriptor this arm does not synthesize. */
export const getOwnPropertyDescriptorText = (ctx: EmitContext, operation: CallOperation): string => {
  const member = 'getOwnPropertyDescriptor'
  const target = targetOf(ctx, member, operation)
  const key = operation.arguments[1]
  if (key === undefined)
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" takes a property key, and this call passes none`
    )
  const renderArm = (representation: Representation, receiver: string): string => {
    if (representation.kind === 'array-object') return arrayObjectDescriptorText(ctx, receiver, representation, key, operation)
    if (representation.kind === 'native-handle') {
      return nativeHandleDescriptorText(ctx, representation.native ?? representation.protocol, key, operation)
    }
    if (callableObjectCarrier(representation)) return callableDescriptorText(ctx, representation, receiver, key, operation)
    if (regexpRoleOf(representation) === 'pattern') return nativeDescriptorConversionText(ctx, member, receiver, key, operation)
    const indexed = indexedRecordDescriptorText(ctx, member, representation, receiver, key, operation)
    if (indexed !== null) return indexed
    const view = objectViewFrom(ctx, member, representation, receiver, 'object')
    if (view.kind === 'dynamic') return dynamicDescriptorConversionText(ctx, member, view.receiver, key, operation)
    if (view.kind === 'dictionary') {
      return refuseDictionaryArm(
        member,
        view,
        'what is missing is the same thing the known-shape arm is missing -- minting the `gea::PropertyDescriptor` result, ' +
          'and the `undefined` a key the table does not hold answers with'
      )
    }
    return knownDescriptorText(ctx, member, view, key, operation)
  }
  if (target.representation.kind !== 'tagged-union') return renderArm(target.representation, operandText(ctx, target))
  const receiver = operandText(ctx, target)
  const arms = target.representation.arms.map((arm, index) => renderArm(arm.value, armAt(receiver, index)))
  const dispatched = arms.reduceRight<string | null>(
    (rest, text, index) => (rest === null ? text : `${armIs(receiver, index)} ? ${text} : (${rest})`),
    null
  )
  if (dispatched === null) {
    throw createCppEmitBlockedError(
      `host-member-call:Object.${member}`,
      `"Object.${member}" of a tagged union with no arms has nothing to enumerate`
    )
  }
  return arms.length > 1 ? `(${dispatched})` : dispatched
}

/**
 * `Object.create(proto)`, the one-argument, `proto === null` form only.
 *
 * The one member of the ten that is not about an object's properties at all --
 * it takes a PROTOTYPE, not a target, so it asks no receiver question and
 * routes through none of the three primitives.
 *
 * `gea::Value::object()` (gea_runtime.h) already IS "a fresh ordinary object
 * with a null `[[Prototype]]`" -- the exact effect 10.1.13's own
 * OrdinaryObjectCreate has for `Object.create(null)`, since every
 * `DynamicObject` this runtime constructs starts with a null prototype and
 * nothing here ever installs a non-null one. So the null-proto call is not an
 * approximation, it is the operation's own real answer.
 *
 * A non-null prototype or a second (`propertiesObject`) argument refuses by
 * name: a real prototype chain needs `setPrototype` wired to a SOURCE object
 * this program produced, and a properties object needs the same
 * `Object.defineProperty`-per-key loop `definePropertyText` already writes --
 * both real features, neither one this row.
 */
const createText = (operation: CallOperation): string => {
  const proto = operation.arguments[0]
  if (proto === undefined) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.create',
      '"Object.create" takes a prototype argument, and this call passes none'
    )
  }
  if (operation.arguments.length > 1) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.create',
      '"Object.create" with a second (properties object) argument is not rendered: it is the same per-key ' +
        '`Object.defineProperty` loop this file writes for that call, not yet installed for this one'
    )
  }
  if (proto.representation.kind !== 'null') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.create',
      `"Object.create" was passed a prototype carried as "${representationKey(proto.representation)}"; only the null-` +
        'prototype form renders, since every dynamic object this runtime builds starts with a null `[[Prototype]]` and ' +
        'nothing here installs any other one yet'
    )
  }
  const result = operation.result?.representation ?? null
  // The result's own carrier, whenever the program stated one. 20.1.2.2 makes
  // this call an OrdinaryObjectCreate with a null prototype and no own
  // properties -- and an empty `gea::Dictionary<V>` and a value-initialized
  // record struct are each exactly that object in the carrier the declaration
  // asked for, not an approximation of it. Boxing first and unboxing at the
  // store would be the wrong answer twice over: `gea::Value::object()` mints a
  // `DynamicObject`, so the store's `unboxValue<Ref<Dictionary<V>>>` finds a
  // payload of a different C++ type and refuses at runtime -- a program that
  // aborts on its first statement, which is what `const emptyParams: Params =
  // Object.create(null)` did (hono's pattern router).
  if (result !== null && (result.kind === 'dictionary' || result.kind === 'record')) {
    const storage = cppTypeOf(result, 'owned')
    return result.ownership === 'shared-refcount' ? `gea::makeRef<${storage}>()` : `${storage}{}`
  }
  return 'gea::Value::object()'
}

/**
 * `Object.assign(target, source)` -- 7.3.25, which is the three primitives and
 * nothing else: for each own enumerable key of source, `Set(target, key,
 * Get(source, key))`.
 *
 * The static arm unrolls that loop because its bounds are known, and each
 * iteration is `setOwnText(target, key, getOwnValue(source, field))` guarded by
 * `ownKeyPresenceText` -- the guard is the specification's own filter, not an
 * optimization: an absent optional is NOT an own key, so copying it anyway
 * would write the absent value over whatever the target already held.
 *
 * ## The condition that is `assign`'s own rather than a primitive's
 *
 * The RESULT. `Object.assign(a, b)` is typed `T & U` by the checker, an
 * intersection whose own carrier this compiler derives separately, and a field
 * copy that did not agree with it would put two answers behind one call. So a
 * consumed result has to carry the target's own carrier -- which is what the
 * intersection collapses to when every key of the source has a home in the
 * target -- and a result carrying anything else refuses rather than being
 * approximated.
 *
 * A `[[Get]]`/`[[Set]]` that runs an accessor is what keeps this arm off any
 * carrier but a struct's: the primitives render a member read and a member
 * store, so a source with a getter or a target with a setter is refused by
 * `setOwnText` naming the accessor rather than copied around it.
 */
const assignSourceText = (ctx: EmitContext, targetView: ObjectView, sourceView: ObjectView): string => {
  if (targetView.kind === 'dynamic' && sourceView.kind === 'dynamic') {
    return `gea::host::ObjectConstructor::assign(${targetView.receiver}, ${sourceView.receiver});`
  }
  if (targetView.kind === 'dictionary' && sourceView.kind === 'dictionary') {
    if (targetView.representation.key !== sourceView.representation.key) {
      return refuseObjectCarrier(
        'assign',
        targetView.representation,
        `a "${sourceView.representation.key}"-keyed dictionary cannot copy its PropertyKeys into a ` +
          `"${targetView.representation.key}"-keyed target without changing their identity`
      )
    }
    if (targetView.representation.key === 'number') {
      // `NumericDictionary<V>::assignInto` (gea_runtime.h) takes its
      // destination as `gea::Dictionary<V2>&`, the SAME string-keyed table a
      // number-keyed table's own entries live in canonicalized -- there is no
      // `NumericDictionary<V2>&` overload, so calling it below with a
      // `NumericDictionary` target would be a C++ type this program never
      // declared. Own-key enumeration reads that canonicalized table and needs
      // no such overload (`keysOf`/`valuesOf`/`entriesOf` above); a per-entry
      // copy INTO one is a real capability nobody has written yet.
      return refuseDictionaryArm(
        'assign',
        targetView,
        'a number-keyed table has no `assignInto` overload of its own -- only enumerating and reading its canonicalized ' +
          'keys is written today, not copying entries into one'
      )
    }
    const converted = alignedValueText(ctx, 'host/emit-host-object.ts:1639', sourceView.value, targetView.value, '__gea_value')
    if (converted === null) {
      return refuseObjectCarrier(
        'assign',
        targetView.representation,
        `a dictionary source holds "${representationKey(sourceView.value)}" values while its target holds ` +
          `"${representationKey(targetView.value)}", and no installed conversion performs that per-entry store`
      )
    }
    // `assignInto` and not `copyInto`: 7.3.25 8.c.ii makes `Object.assign`'s
    // per-entry step an ordinary `[[Set]]` with Throw, while spread's is
    // `CreateDataProperty`. The two agreed while no dictionary property could
    // refuse a write, and this destination is a table the program already
    // has -- unlike spread's, which is one being built.
    return (
      `if (!${sourceView.receiver}.assignInto(${targetView.receiver}, ` +
      `[](const ${cppTypeOf(sourceView.value)}& __gea_value) { return ${converted}; })) ` +
      'gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");'
    )
  }
  if (targetView.kind === 'dictionary' && sourceView.kind === 'known') {
    if (targetView.representation.key === 'symbol') {
      return refuseDictionaryArm(
        'assign',
        targetView,
        'a statically named source field is a string PropertyKey and cannot be inserted into a symbol-keyed target'
      )
    }
    const stores = ownKeyFields(sourceView).map((field) => {
      const value = getOwnValue(ctx, sourceView, field)
      const converted = alignedValueText(ctx, 'host/emit-host-object.ts:1660', value.representation, targetView.value, value.text)
      if (converted === null) {
        return refuseObjectCarrier(
          'assign',
          targetView.representation,
          `the source field "${field.key}" carries "${representationKey(value.representation)}" while the dictionary ` +
            `target holds "${representationKey(targetView.value)}", and no installed conversion performs that store`
        )
      }
      // 7.3.25 step 8.c.ii is `Set(to, key, value, true)` -- an ordinary
      // `[[Set]]` with Throw TRUE, so a non-writable destination property is a
      // TypeError rather than an overwrite. Reachable since a dictionary began
      // retaining attributes; `operator[]` here would have silently written
      // through the very flag `Object.defineProperty` installed.
      const store =
        `if (!${targetView.receiver}.setProperty(${cppStringLiteral(field.key)}, ${converted})) ` +
        'gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");'
      const presence = ownKeyPresenceText('assign', sourceView, field)
      return presence === null ? store : `if (${presence}) ${store}`
    })
    return stores.join(' ')
  }
  if (
    targetView.kind === 'dictionary' &&
    targetView.representation.key === 'string' &&
    sourceView.kind === 'dynamic' &&
    targetView.value.kind === 'dynamic'
  ) {
    return `gea::host::ObjectConstructor::assignInto(${targetView.receiver}, ${sourceView.receiver});`
  }
  if (targetView.kind === 'dictionary' || sourceView.kind === 'dictionary') {
    if (
      sourceView.kind === 'dictionary' &&
      // `assignDynamicProperties` (gea_runtime.h) takes its source as
      // `const gea::Dictionary<gea::Value>&` specifically -- a number-keyed
      // table's own entries live canonicalized in exactly that container, but
      // the container itself is `gea::NumericDictionary<V>`, a distinct C++
      // type with no such overload. Restricting to `key === 'string'` keeps
      // this arm to the case the runtime function actually accepts.
      sourceView.representation.key === 'string' &&
      sourceView.value.kind === 'dynamic' &&
      targetView.kind === 'known' &&
      (targetView.representation.kind === 'record' ||
        targetView.representation.kind === 'native-record-ref' ||
        targetView.representation.kind === 'class-ref') &&
      targetView.representation.ownership === 'shared-refcount'
    ) {
      // `Object.assign` returns the target itself. The semantic producer
      // publishes that identity (rather than TypeScript's descriptive `T & U`
      // intersection), and the runtime copies each dynamic source entry
      // through the target struct's field dispatcher or its identity-keyed
      // expando table. Declared fields and extra keys therefore share the same
      // [[Set]] path and no typed target is boxed.
      return `gea::record::assignDynamicProperties(${targetView.receiver}, ${sourceView.receiver});`
    }
    const table = targetView.kind === 'dictionary' ? targetView : sourceView
    if (table.kind !== 'dictionary')
      throw createCppEmitBlockedError('host-member-call:Object.assign', '"Object.assign" reached a dictionary arm with no dictionary side')
    // Both sides, always. Which arm is missing is decided by the PAIRING, so a
    // refusal naming only the dictionary half sends a reader to look at the
    // half that is already fine -- the same complaint this file's header makes
    // about `assign` refusing "of a class-ref carrier" without saying whether
    // the class was being enumerated or written into.
    const describe = (view: ObjectView): string =>
      view.kind === 'dynamic' ? 'the dynamic object the runtime walks' : `"${representationKey(view.representation)}"`
    return refuseDictionaryArm(
      'assign',
      table,
      `this call copies ${describe(sourceView)} into ${describe(targetView)}: a dictionary SOURCE is ` +
        '`Dictionary::copyInto` (7.3.25 over the creation order it already walks) and a dictionary TARGET is a store per ' +
        'key -- both real arms, neither written for this pairing'
    )
  }
  if (
    targetView.kind === 'known' &&
    sourceView.kind === 'dynamic' &&
    (targetView.representation.kind === 'record' ||
      targetView.representation.kind === 'native-record-ref' ||
      targetView.representation.kind === 'class-ref') &&
    targetView.representation.ownership === 'shared-refcount'
  ) {
    // The source's key set only exists at runtime, while the native target's
    // generated dispatcher plus expando sidecar is its exact [[Set]]. Bind the
    // source once because an operand may be a deferred expression, then apply
    // the same enumerable-string-key loop the dynamic-to-dictionary arm uses.
    // A declared target field is checked and unboxed by its dispatcher; every
    // other key stays on the target identity's sidecar.
    return (
      `{ const auto& __gea_source = ${sourceView.receiver}; ` +
      `for (const std::string& __gea_key : __gea_source.ownEnumerableStringKeys()) ` +
      `gea::nativeDynamicSet(${targetView.receiver}, gea::PropertyKey::string(__gea_key), ` +
      `__gea_source.getProperty(gea::PropertyKey::string(__gea_key))); }`
    )
  }
  if (targetView.kind === 'dynamic' || sourceView.kind === 'dynamic') {
    const known = targetView.kind === 'known' ? targetView : sourceView
    if (known.kind !== 'known')
      throw createCppEmitBlockedError('host-member-call:Object.assign', '"Object.assign" reached a mixed arm with no known side')
    return refuseObjectCarrier(
      'assign',
      known.representation,
      'one side of this copy is the dynamic object the runtime walks and the other is a struct whose keys are known here, ' +
        "and the two arms render the loop on different sides -- bridging them means walking one object's runtime key " +
        "table against the other's compile-time one, which is the struct dispatcher's job and not this call's"
    )
  }
  const stores = ownKeyFields(sourceView).map((field) => {
    const store = setOwnText(ctx, 'assign', targetView, field.key, getOwnValue(ctx, sourceView, field))
    const presence = ownKeyPresenceText('assign', sourceView, field)
    return presence === null ? store : `if (${presence}) ${store}`
  })
  return stores.join(' ')
}

/** Copy one source, including the spec's null/undefined skip and a union's live arm. */
const assignOperandText = (ctx: EmitContext, targetView: ObjectView, source: IrOperand): string => {
  const representation = source.representation
  if (representation.kind === 'null' || representation.kind === 'undefined') return ''
  if (representation.kind === 'optional') {
    const receiver = operandText(ctx, source)
    const payload = objectViewFrom(ctx, 'assign', representation.payload, `(*(${receiver}))`, 'source')
    return `if ((${receiver}).has_value()) { ${assignSourceText(ctx, targetView, payload)} }`
  }
  if (representation.kind !== 'tagged-union') {
    return assignSourceText(ctx, targetView, objectViewOf(ctx, 'assign', source, 'source'))
  }
  const receiver = operandText(ctx, source)
  const branches = representation.arms.map((arm, index) => {
    const body =
      arm.value.kind === 'null' || arm.value.kind === 'undefined'
        ? ''
        : assignSourceText(ctx, targetView, objectViewFrom(ctx, 'assign', arm.value, armAt(receiver, index), 'source'))
    return `${index === 0 ? 'if' : 'else if'} (${armIs(receiver, index)}) { ${body} }`
  })
  return branches.join(' ')
}

/**
 * `Object.assign(fn, { ... })` -- the TARGET is a Function object.
 *
 * 7.3.25 is the same loop as every other target: for each own enumerable key
 * of the source, `Set(target, key, Get(source, key))`. What differs is only
 * where the store lands -- a Function's own properties live on its identity,
 * which `setOwnCallableText` writes through -- so the source side is read by
 * the very same `ObjectView` the struct arms use and nothing about enumeration
 * is duplicated here.
 *
 * Only a source whose keys the checker knows is admitted. A dynamic source
 * would need the runtime key walk the struct arm has (`assignDynamicProperties`
 * over a `gea::Value` target), and a Function object is not one; that stays
 * refused by name rather than approximated.
 */
const assignIntoCallableText = (ctx: EmitContext, operation: CallOperation, target: IrOperand): string => {
  const targetText = operandText(ctx, target)
  const result = operation.result?.representation
  if (result !== undefined && representationKey(result) !== representationKey(target.representation)) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.assign',
      `"Object.assign" is typed "T & U" and this call's result carries "${representationKey(result)}", which is not the ` +
        `Function object target's own "${representationKey(target.representation)}" -- the copy writes into the target and ` +
        'returns it, so a result carrying anything else is a second answer this renderer may not invent'
    )
  }
  const copies = operation.arguments.slice(1).map((source, sourceIndex) => {
    const sourceView = objectViewOf(ctx, 'assign', source, 'source')
    if (sourceView.kind !== 'known')
      return refuseObjectCarrier(
        'assign',
        source.representation,
        "the target is a Function object, whose own properties this backend writes one key at a time, and the source's key " +
          'set is only known at run time -- walking it needs the runtime key loop the struct target has and a Function object ' +
          'does not'
      )
    return ownKeyFields(sourceView)
      .map((field) => {
        const value = getOwnValue(ctx, sourceView, field)
        const converted = objectValueConversionText(
          ctx,
          operation,
          'callable-property',
          sourceIndex + 1,
          field.key,
          value.representation,
          value.text
        )
        const store = setOwnCallableText(targetText, field.key, converted)
        const presence = ownKeyPresenceText('assign', sourceView, field)
        return presence === null ? store : `if (${presence}) ${store}`
      })
      .join(' ')
  })
  const body = copies.join(' ')
  if (operation.result === null) return `([&]() { ${body} })()`
  return `([&]() { ${body} return ${targetText}; })()`
}

const assignText = (ctx: EmitContext, operation: CallOperation): string => {
  const target = targetOf(ctx, 'assign', operation)
  const targetText = operandText(ctx, target)
  const sources = operation.arguments.slice(1)
  if (sources.length === 0)
    throw createCppEmitBlockedError('host-member-call:Object.assign', '"Object.assign" takes a source object, and this call passes none')
  if (isNativeCallableCarrier(target.representation.kind)) return assignIntoCallableText(ctx, operation, target)
  const targetView = objectViewOf(ctx, 'assign', target, 'target')
  if (targetView.kind === 'known') {
    const result = operation.result?.representation
    if (result !== undefined && representationKey(result) !== representationKey(targetView.representation)) {
      throw createCppEmitBlockedError(
        'host-member-call:Object.assign',
        `"Object.assign" is typed "T & U" and this call's result carries "${representationKey(result)}", which is not the ` +
          `target's own "${representationKey(targetView.representation)}" -- the copy writes into the target and returns it, ` +
          'so a result carrying anything else is a second answer this renderer may not invent'
      )
    }
  }
  const copies = sources.map((source) => assignOperandText(ctx, targetView, source)).join(' ')
  if (operation.result === null) return `([&]() { ${copies} })()`
  return `([&]() { ${copies} return ${targetText}; })()`
}

/**
 * `Object.defineProperty(target, key, descriptor)`.
 *
 * The descriptor argument is where this gets interesting. A program writes it
 * as an object literal -- `{ value, writable: true, configurable: true,
 * enumerable: false }` -- and the checker types the parameter
 * `PropertyDescriptor & ThisType<any>`, so what actually arrives at this call
 * site is whatever carrier the literal's own type derived. Two shapes are
 * accepted, and each is spelled from what it is:
 *
 * - a `native-handle` on this protocol -- a descriptor the program is passing
 *   THROUGH, the shape `Object.getOwnPropertyDescriptor` hands back. It is
 *   already a `gea::PropertyDescriptor` and passes straight in.
 * - a `record` -- the object literal, whose fields are read one by one into a
 *   fresh descriptor, each field also SETTING the matching presence flag.
 *   That flag is the whole point: 6.2.6 distinguishes a descriptor that states
 *   `writable: false` from one that says nothing about writability, and a
 *   struct copy that set every field would rewrite attributes the program
 *   never mentioned.
 *
 * The ACCESSOR form (`get`/`set` in the literal) is refused by name. The
 * object model stores accessors as native `std::function`s and invokes them
 * (`gea::runtime::object::get`), so the model is not the gap -- what is
 * missing is the conversion from the program's own callable carrier into that
 * signature, and inventing one that dropped the receiver would make
 * `get: () => this.x` read the wrong object.
 */
const defineDescriptorLines = (ctx: EmitContext, operation: CallOperation, descriptor: IrOperand, slot: string): string =>
  descriptorSlotLines(ctx, operation, descriptor.representation, operandText(ctx, descriptor), slot)

/**
 * The descriptor operand of `Object.defineProperty`, in every carrier a
 * program hands one over as: the host's own `gea::PropertyDescriptor`; an
 * object literal (a `record`, every stated field present); the record
 * `Object.getOwnPropertyDescriptor` published (a `native-record-ref` whose
 * OPTIONAL fields carry a presence bit -- a descriptor read back off an
 * accessor states no `value`, and `hasValue` must say so rather than copy a
 * default-constructed one); and an `optional` of that record, which is how
 * test262's `verifyProperty` holds the descriptor it restores with. The
 * absent optional is ECMA-262 20.1.2.4 step 3's TypeError
 * (`ToPropertyDescriptor` of `undefined`), thrown where the language throws it.
 */
const descriptorSlotLines = (
  ctx: EmitContext,
  operation: CallOperation,
  representation: Representation,
  text: string,
  slot: string
): string => {
  if (representation.kind === 'native-handle' && representation.protocol === 'PropertyDescriptor') {
    return `const gea::PropertyDescriptor& ${slot} = ${text};`
  }
  if (representation.kind === 'optional') {
    return (
      `if (!(${text}).has_value()) gea::host::throwRuntimeError("TypeError", "Property description must be an object: ${representation.absence}"); ` +
      descriptorSlotLines(ctx, operation, representation.payload, `(*${text})`, slot)
    )
  }
  const fields =
    representation.kind === 'record'
      ? representation.fields
      : representation.kind === 'native-record-ref' && representation.native === null
        ? recordFieldsOfShape(ctx.deriver, representation.shapeId)
        : null
  if (fields === null || (representation.kind !== 'record' && representation.kind !== 'native-record-ref')) {
    return refuseObjectCarrier(
      'defineProperty',
      representation,
      'a descriptor is either one this program received from Object.getOwnPropertyDescriptor or an object literal whose ' +
        'fields the checker knows; nothing else states which attributes it means to set'
    )
  }
  const accessor = memberAccessOperator(representation.ownership)
  const assignments: string[] = []
  const push = (field: RecordField, assignment: string): void => {
    assignments.push(field.required ? assignment : `if (${text}${accessor}${cppRecordFieldPresenceName(field.key)}) { ${assignment} }`)
  }
  for (const field of fields) {
    const read = `${text}${accessor}${cppRecordFieldName(field.key)}`
    // A field the descriptor record carries as `optional(T, undefined)` -- the
    // shape `Object.getOwnPropertyDescriptor` publishes for its `value?: any`
    // and `writable?: boolean` members -- states the attribute exactly when
    // the optional is present: the presence bit says the field was written,
    // the optional says it was written with a value rather than `undefined`,
    // and ECMA-262 6.2.6.5 ToPropertyDescriptor reads an attribute that IS
    // present but `undefined` as stated-false, which is what the unwrapped
    // read below yields for the absent optional it never reaches. An object
    // literal's field is never optional and takes the plain path.
    const carried = field.value.kind === 'optional' && field.value.absence === 'undefined' ? field.value.payload : field.value
    const held = field.value.kind === 'optional' ? `(*${read})` : read
    const stated = (assignment: string): string =>
      field.value.kind === 'optional' ? `if ((${read}).has_value()) { ${assignment} }` : assignment
    if ((field.key === 'get' || field.key === 'set') && (!field.required || field.value.kind === 'optional')) {
      // The record `Object.getOwnPropertyDescriptor` publishes declares
      // `get?`/`set?` beside the data fields, and for every data property --
      // which is what test262's `verifyProperty` restores -- both are absent.
      // A PRESENT accessor is the case the compile-time refusal below states,
      // reached here at runtime rather than at compile time because the same
      // record carries both kinds; it refuses by name where the language would
      // have installed the accessor, never installs a data property in its
      // place. The guards `push`/`stated` wrap this in are exactly the
      // presence tests, so the throw is dead code for a data descriptor.
      push(
        field,
        stated(
          `gea::host::throwRuntimeError("TypeError", "Object.defineProperty with an accessor descriptor (${field.key}) is not rendered by this backend");`
        )
      )
      continue
    }
    // A literal accessor descriptor refuses the same way, at the call rather
    // than the compile: installing it would have to decide how the receiver
    // reaches the compiled getter, and a wrong answer reads the wrong object.
    // `@hono/node-server` installs one only on its TRACE path, so the program
    // runs and that path throws by name.
    if (field.key === 'get' || field.key === 'set') {
      push(
        field,
        `gea::host::throwRuntimeError("TypeError", "Object.defineProperty with an accessor descriptor (${field.key}) is not rendered by this backend");`
      )
      continue
    }
    if (field.key === 'value') {
      // A descriptor's `value` is `any` -- ECMAScript's own declaration, and
      // one of the four boundaries where a box is the correct carrier rather
      // than a defect. But the LITERAL's field carries whatever the program
      // wrote (`{ value }` where `value: string` carries `std::string`), so
      // the widening has to be spelled: `gea::Value` declares no converting
      // assignment from an arbitrary type, and relying on one would have been
      // a clang error at every call site rather than a named refusal here.
      //
      // A field already carried as `dynamic` assigns straight across -- it is
      // a `gea::Value` on both sides, and boxing a box would nest two.
      if (carried.kind === 'dynamic') {
        push(field, stated(`${slot}.hasValue = true; ${slot}.value = ${held};`))
        continue
      }
      // The cited conversion retains callable receiver conventions as well as
      // payload type; the printer never chooses a dynamic box tag here.
      const boxed = objectValueConversionText(ctx, operation, 'descriptor-value', 2, field.key, carried, held)
      push(field, stated(`${slot}.hasValue = true; ${slot}.value = ${boxed};`))
      continue
    }
    if (field.key === 'writable' || field.key === 'enumerable' || field.key === 'configurable') {
      // The attribute is declared `boolean | undefined`; an optional carrier
      // was unwrapped above, so what reaches here is the plain boolean or a
      // carrier this renderer cannot read as one.
      if (!(carried.kind === 'scalar' && carried.domain === 'boolean')) {
        throw createCppEmitBlockedError(
          'host-member-call:ObjectConstructor.defineProperty',
          `"Object.defineProperty" was passed a descriptor whose "${field.key}" carries ` +
            `"${representationKey(carried)}" rather than a plain boolean; a descriptor states an attribute or does not ` +
            'state it, and an optional-carried attribute would put that fact in two flags at once'
        )
      }
      const flag = `has${field.key.charAt(0).toUpperCase()}${field.key.slice(1)}`
      push(field, stated(`${slot}.${flag} = true; ${slot}.${field.key} = ${held};`))
      continue
    }
    throw createCppEmitBlockedError(
      'host-member-call:ObjectConstructor.defineProperty',
      `"Object.defineProperty" was passed a descriptor with a field "${field.key}", which ECMA-262 6.1.7.1 does not define; ` +
        'a descriptor field this backend ignored would silently drop what the program asked for'
    )
  }
  return `gea::PropertyDescriptor ${slot}; ${assignments.join(' ')}`
}

/**
 * The descriptor's `value`, still in the carrier the program wrote it in.
 *
 * A dictionary holds `V`, not `gea::Value`, so the value has to reach it
 * unboxed -- which the descriptor RECORD cannot supply, because its `value`
 * field is declared `any` and the allocation has already widened it.
 * `recordFieldSources` is the emitter's existing record of the literal
 * operands an object literal was built from, and it is read here for exactly
 * that: the typed operand behind a widened field.
 *
 * The three ATTRIBUTES do not come from here. They come from
 * `defineDescriptorLines`, the same reader the callable and known-receiver
 * arms use, so a descriptor states an attribute one way in this backend
 * rather than one way per receiver kind.
 */
const dictionaryDefinePropertyValue = (ctx: EmitContext, descriptor: IrOperand): IrOperand => {
  if (descriptor.representation.kind !== 'record') {
    throw createCppEmitBlockedError(
      'host-member-call:ObjectConstructor.defineProperty',
      `"Object.defineProperty" on a dictionary requires an object-literal descriptor whose \`value\` operand is still typed, ` +
        `but this descriptor carries "${representationKey(descriptor.representation)}" rather than a record`
    )
  }
  const value = ctx.recordFieldSources.get(descriptor.value)?.get('value')
  if (value === undefined) {
    throw createCppEmitBlockedError(
      'host-member-call:ObjectConstructor.defineProperty',
      '"Object.defineProperty" on a dictionary needs the descriptor\'s own `value` operand, and this descriptor either ' +
        'states no `value` or is not the object literal whose fields were recorded before allocation widened them'
    )
  }
  return value
}

/**
 * `Object.defineProperty` -- primitive 3 plus the attributes that make it not
 * a plain store.
 *
 * The static arm refuses, and the reason is the member's own semantics rather
 * than anything about the carrier: 6.2.5.6 defaults every unstated attribute
 * to FALSE, so `Object.defineProperty(o, 'k', { value: 1 })` installs a
 * non-writable, non-enumerable, non-configurable property. Primitive 3 renders
 * a struct member store, which is a writable, enumerable, configurable data
 * property -- the exact opposite -- so routing this through it would install a
 * property with three attributes the program did not ask for.
 */
/**
 * `Object.defineProperty` aimed at a namespace-shaped host intrinsic (`Math`):
 * the fourth reflection operation test262's `verifyProperty` performs on one,
 * restoring a member with the descriptor it read. A non-configurable member
 * (every 21.3.1 constant) is validated at runtime by
 * `gea::detail::hostIntrinsicRedefineFixed` -- the one admitted redefinition
 * is the identical one, anything else is the TypeError 10.1.6.3 specifies --
 * and every other key defines into the same per-protocol sidecar the computed
 * get/set/delete consult (`computedNativeHandleGetText`, emit-host-properties.ts,
 * states the design and its one limit).
 */
const nativeHandleDefinePropertyText = (
  ctx: EmitContext,
  operation: CallOperation,
  target: IrOperand,
  key: IrOperand,
  descriptor: IrOperand
): string | null => {
  const representation = target.representation
  if (representation.kind !== 'native-handle' || representation.native !== null) return null
  const members = ctx.hosts.intrinsicMembers.get(representation.protocol)
  if (members === undefined) return null
  const { protocol } = representation
  const site = `"Object.defineProperty" of "${protocol}"`
  const slot = '__gea_descriptor'
  const targetText = operandText(ctx, target)
  const arms = members
    .map((member) => ({ name: member.name, value: intrinsicMemberValueOf(ctx, protocol, member, site) }))
    .filter((member) => !member.value.configurable)
    .map(
      (member) =>
        `if (__gea_key == ${cppStringLiteral(member.name)}) { gea::detail::hostIntrinsicRedefineFixed(${cppStringLiteral(member.name)}, ${member.value.value}, ${slot}); return ${targetText}; }`
    )
    .join(' ')
  return (
    `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} const gea::PropertyKey __gea_property_key = ${propertyKeyOperandText(ctx, key, site)}; ` +
    `if (!__gea_property_key.isSymbol()) { const std::string& __gea_key = __gea_property_key.text(); ${arms} } ` +
    `gea::detail::hostIntrinsicSidecar(${cppStringLiteral(protocol)}).define(__gea_property_key, ${slot}); return ${targetText}; })()`
  )
}

/**
 * Define one fixed field from a closed data-descriptor record. The value
 * travels directly from the descriptor record into the field's selected
 * carrier; only reflective reads ever need the descriptor's dynamic Value
 * boundary.
 *
 * An OPTIONAL field is admitted too. 10.1.6.3 branches on whether the property
 * is already present -- absent means "create it, and every unstated attribute
 * defaults to false" (6.2.5.6), present means "validate the redefinition
 * against the attributes it already has" -- and for an optional field that
 * presence is a RUNTIME fact, not a compile-time one. It is already carried:
 * the field's selected carrier is `optional`, whose `has_value()` IS the
 * presence bit. So the same `exists` argument the required case computes
 * statically becomes that predicate, and `applyNativeFixedDataDescriptor`'s
 * two arms are reached exactly as the spec branches. Nothing new has to be
 * stored, and no second authority learns what "present" means -- the carrier
 * already answered it.
 */
const fixedFieldDefinePropertyText = (
  ctx: EmitContext,
  view: Extract<ObjectView, { kind: 'known' }>,
  recipe: FixedDataDefinitionRecipe,
  descriptor: IrOperand,
  targetOperand: IrOperand
): string => {
  const { field, held } = recipe
  const representation = descriptor.representation
  if (
    representation.kind !== 'record' ||
    recipe.target !== representationKey(targetOperand.representation) ||
    recipe.descriptor !== representationKey(representation)
  ) {
    throw createCppEmitBlockedError('host-member-call:ObjectConstructor.defineProperty', 'fixed data definition recipe carrier mismatch')
  }
  const accessor = memberAccessOperator(representation.ownership)
  const descriptorText = operandText(ctx, descriptor)
  const read = (member: RecordField): string => `${descriptorText}${accessor}${cppRecordFieldName(member.key)}`
  const node = ctx.conversions.nodeById(recipe.conversion)
  const incoming = node === null ? null : recipeText(ctx, node, read(recipe.value))
  if (incoming === null) {
    throw createCppEmitBlockedError('host-member-call:ObjectConstructor.defineProperty', 'fixed data definition conversion has no renderer')
  }
  const attribute = (name: string): readonly [string, string] => {
    const member = recipe.attributes.find((candidate) => candidate.key === name)
    return member === undefined ? ['false', 'false'] : ['true', read(member)]
  }
  const [hasWritable, writable] = attribute('writable')
  const [hasEnumerable, enumerable] = attribute('enumerable')
  const [hasConfigurable, configurable] = attribute('configurable')
  const target = view.receiver
  const fieldText = `${target}${view.accessor}${cppRecordFieldName(field.key)}`
  const attributesText = `${target}${view.accessor}${cppRecordFieldAttributesName(field.key)}`
  // A projected C++ field can precede the JavaScript property whose first
  // definition gives it a value. A real class-field initializer or an earlier
  // emitted store proves the property already exists; otherwise this call is
  // its creation and omitted attributes default to false.
  //
  // For an OPTIONAL field none of that static reasoning applies or is needed:
  // the record spends a presence bit precisely so the answer can differ per
  // execution. Handing the helper a predicate rather than a literal is the
  // whole of the create-versus-redefine support -- both arms were already
  // written, only the question was missing.
  //
  // The bit to read is `cppRecordFieldPresenceName`, which is what `in`
  // (emit-in.ts) and `gea_deleteOwnField` already consult -- NOT the payload
  // `Optional`'s `has_value()`. The two are different questions and this got
  // written the wrong way round first: `has_value()` asks whether the stored
  // value is present, the presence bit asks whether the JS PROPERTY exists.
  // Reading the payload made every define look like a creation, and since
  // nothing then set the property's own bit, the property never came to exist
  // at all -- a following `delete` took `gea_deleteOwnField`'s absent-key arm
  // and returned true instead of throwing on a non-configurable property.
  // Same class of defect this whole refactor is about: a second authority
  // answering a question one already owned.
  const presenceText = `${target}${view.accessor}${cppRecordFieldPresenceName(field.key)}`
  const existing = !field.required
    ? presenceText
    : (() => {
        if (ctx.recordFieldSources.get(targetOperand.value)?.has(field.key) === true) return 'true'
        if (view.representation.kind !== 'class-ref') return 'true'
        const site = classMemberOf(ctx.classes, view.representation.declaration, field.key)
        if (site?.kind !== 'field') return 'true'
        const projected = ctx.classes.get(site.owner)?.fields.find((candidate) => candidate.key === field.key)
        return projected === undefined || projected.initializer !== null ? 'true' : 'false'
      })()
  // `convertedValueText` is allowed to spell an authorized implicit widening
  // as the source text (bare T -> Optional<T>). Materialize the selected field
  // carrier before template deduction: the runtime helper deliberately takes
  // one T for both current and incoming values, so it cannot and should not
  // become a second conversion authority accepting arbitrary C++ sources.
  const incomingFieldValue = `${cppTypeOf(held)}{${incoming}}`
  // A define that CREATES an optional field has to publish the property, or
  // the value lands in the payload while every other reader -- `in`, `delete`,
  // `Object.keys`, the descriptor read -- still sees an absent property.
  const publish = field.required ? '' : ` ${presenceText} = true;`
  // `applyNativeFixedDataDescriptor` reads the CURRENT value through
  // `fieldText` when the field is present, non-configurable and
  // non-writable (a SameValue check against the incoming value) -- an
  // un-materialized lazy arrow field would hand it the empty sentinel there
  // instead of the real callable. `emit-properties.ts`'s
  // `lazyMaterializedFieldReadText` is the read-side counterpart: `target`
  // here is already a genuine `gea::Ref<T>` operand (`view.receiver`), not a
  // `this` pointer inside a const member function, so the call needs no
  // `Ref::adopt`/`const_cast` recovery the way `records.ts`'s dynamic
  // dispatcher does -- it can call the initializer thunk with `target`
  // directly, exactly like that read path calls it with `gea_lazy_receiver`.
  const lazyOwner = view.representation.kind === 'class-ref' ? classMemberOf(ctx.classes, view.representation.declaration, field.key) : null
  const lazyPlan = lazyOwner !== null && lazyOwner.kind === 'field' ? lazyArrowFieldPlanOf(ctx.classes, lazyOwner.owner, field.key) : null
  const materialize =
    lazyPlan !== null ? `if (${fieldText}.invoke == nullptr) { ${fieldText} = ${cppBodyName(lazyPlan.initializer)}(${target}); } ` : ''
  return (
    `([&]() { ${materialize}if (!gea::applyNativeFixedDataDescriptor(${fieldText}, ${attributesText}, ${incomingFieldValue}, ${existing}, ` +
    `${hasWritable}, ${writable}, ${hasEnumerable}, ${enumerable}, ${hasConfigurable}, ${configurable})) ` +
    `gea::host::throwRuntimeError("TypeError", "Cannot redefine property: ${field.key}");${publish} return ${target}; })()`
  )
}

const definePropertyText = (ctx: EmitContext, operation: CallOperation): string => {
  const target = targetOf(ctx, 'defineProperty', operation)
  const key = operation.arguments[1]
  const descriptor = operation.arguments[2]
  if (key === undefined || descriptor === undefined) {
    throw createCppEmitBlockedError(
      'host-member-call:ObjectConstructor.defineProperty',
      '"Object.defineProperty" takes a target, a key and a descriptor; this call passes fewer'
    )
  }
  if (operation.fixedDataDefinition !== undefined) {
    const view = objectViewOf(ctx, 'defineProperty', target, 'target')
    if (view.kind !== 'known')
      throw createCppEmitBlockedError('host-member-call:ObjectConstructor.defineProperty', 'fixed data definition requires native storage')
    return fixedFieldDefinePropertyText(ctx, view, operation.fixedDataDefinition, descriptor, target)
  }
  const intrinsic = nativeHandleDefinePropertyText(ctx, operation, target, key, descriptor)
  if (intrinsic !== null) return intrinsic
  // RegExp's `lastIndex` is a native `Value` cell with the real fixed
  // descriptor, not a generated C++ field. Route it through the native-field
  // descriptor hook so Object.defineProperty and Object.freeze observe the
  // same property as static and computed writes.
  //
  // A claim, not a fold: this decides whether this dedicated `lastIndex` path
  // fires at all, so it must not see a key text `constantTexts` only holds
  // because the render minted it (e.g. a folded `typeof` result reaching here
  // as the key).
  if (regexpRoleOf(target.representation) === 'pattern' && ctx.staticKeyTexts.get(key.value) === 'lastIndex') {
    const slot = '__gea_descriptor'
    return (
      `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} ` +
      `if (!gea::nativeDynamicDefineProperty(${operandText(ctx, target)}, ${propertyKeyOperandText(ctx, key, '"Object.defineProperty" of RegExp')}, ${slot})) ` +
      'gea::host::throwRuntimeError("TypeError", "Cannot redefine RegExp lastIndex"); ' +
      `return ${operandText(ctx, target)}; })()`
    )
  }
  // Tried before `generatedRecordReceiver` below: that check matches every
  // shared-refcount record/class/native-record-ref receiver unconditionally,
  // which used to intercept a defineProperty of a DECLARED field before this
  // dedicated per-field store ever ran -- see `declaredFixedFieldOf`'s own
  // comment for why that silently granted three attributes the call withheld.
  // `key.value`'s constant-ness is asked through `staticKeyTexts`, the same
  // authority `fixedFieldDefinePropertyText`'s caller below already trusted,
  // never `constantTexts` (a render-time fold, not something the program wrote).
  if (key.representation.kind === 'string') {
    const literalKey = ctx.staticKeyTexts.get(key.value)
    const fixedField = literalKey === undefined ? null : declaredFixedFieldOf(ctx, target.representation, literalKey)
    if (fixedField !== null) {
      throw createCppEmitBlockedError('host-member-call:ObjectConstructor.defineProperty', 'fixed data definition has no sealed recipe')
    }
  }
  const generatedReceiver = generatedRecordReceiver(target.representation, operandText(ctx, target))
  if (generatedReceiver !== null) {
    const slot = '__gea_descriptor'
    const propertyKey = propertyKeyOperandText(ctx, key, '"Object.defineProperty" of a generated record')
    return (
      `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} ` +
      `if (!${generatedDefineOwnText(generatedReceiver, propertyKey, slot)}) ` +
      `gea::host::throwRuntimeError("TypeError", "Cannot define native record property"); ` +
      `return ${operandText(ctx, target)}; })()`
    )
  }
  if (callableObjectCarrier(target.representation)) {
    // A callable's own properties live in its one shared function-object
    // table (`callableDynamicGet`'s); the facts are installed first so a
    // redefinition of `name`/`length` is checked against the attributes
    // 10.2.10 gives them rather than against an empty slot.
    const slot = '__gea_descriptor'
    const constructorSetup =
      target.representation.kind === 'function-and-constructor'
        ? 'if (!__gea_key.isSymbol() && __gea_key.text() == "prototype") gea::installCallableConstructorPrototype(__gea_callable); '
        : ''
    return (
      `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} const auto& __gea_callable = ${operandText(ctx, target)}; ` +
      // Same reasoning as `callableDescriptorText`: a heap-environment
      // callable's identity may be anchored in its environment block rather
      // than in `functionObject` itself, so bind what `functionObjectIdentity()`
      // resolved instead of re-reading `functionObject` directly afterward.
      'const auto& __gea_callable_identity = __gea_callable.functionObjectIdentity(); ' +
      'gea::installCallableOwnFacts(__gea_callable_identity, __gea_callable.name(), __gea_callable.length()); ' +
      `const gea::PropertyKey __gea_key = ${propertyKeyOperandText(ctx, key, '"Object.defineProperty" of a callable')}; ${constructorSetup}` +
      `if (!__gea_callable_identity->properties->defineOwnProperty(__gea_key, ${slot})) ` +
      'gea::host::throwRuntimeError("TypeError", "Cannot define callable property"); ' +
      'return __gea_callable; })()'
    )
  }
  const view = objectViewOf(ctx, 'defineProperty', target, 'target')
  if (view.kind === 'dictionary') {
    if (key.representation.kind !== view.representation.key) {
      return refuseDictionaryArm(
        'defineProperty',
        view,
        `the key carries "${representationKey(key.representation)}" rather than the table's "${view.representation.key}" key domain`
      )
    }
    const value = dictionaryDefinePropertyValue(ctx, descriptor)
    const raw = operandText(ctx, value)
    const stored =
      representationKey(value.representation) === representationKey(view.value)
        ? raw
        : alignedValueText(ctx, 'host/emit-host-object.ts:2242', value.representation, view.value, raw)
    if (stored === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(value.representation)}->${representationKey(view.value)}`,
        `"Object.defineProperty" would store "${representationKey(value.representation)}" into a dictionary held as ` +
          `"${representationKey(view.value)}", and no installed conversion performs that`
      )
    }
    // `[[DefineOwnProperty]]`, not a store. The two differ in three ways a
    // plain `table[k] = v` cannot express -- the attributes it installs,
    // 10.1.6.3's refusal to redefine a non-configurable property, and the
    // TypeError that refusal raises -- and until the table could retain an
    // attribute this arm proved all three were the ordinary ones and stored.
    //
    // The descriptor is read by `defineDescriptorLines`, the same reader the
    // callable and known-receiver arms use. Only the three attribute FLAGS
    // are taken from it: a dictionary holds `V`, so the value arrives from
    // `dictionaryDefinePropertyValue` still typed rather than through the
    // descriptor's boxed `value` field. `std::optional<bool>` and not a bare
    // bool because 6.2.5.6 distinguishes an attribute stated false from one
    // not stated at all, and only the table can complete the second (false on
    // a new property, unchanged on an existing one).
    const slot = '__gea_descriptor'
    const attribute = (name: string): string =>
      `${slot}.has${name.charAt(0).toUpperCase()}${name.slice(1)} ? std::optional<bool>(${slot}.${name}) : std::nullopt`
    return (
      `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} ` +
      `if (!${view.receiver}.definePropertyFrom(${operandText(ctx, key)}, ${stored}, ` +
      `${attribute('writable')}, ${attribute('enumerable')}, ${attribute('configurable')})) ` +
      'gea::host::throwRuntimeError("TypeError", "Cannot redefine property"); ' +
      `return ${operandText(ctx, target)}; })()`
    )
  }
  // A key naming a declared fixed field never reaches here: the early check
  // above (`declaredFixedFieldOf`) already routed it to
  // `fixedFieldDefinePropertyText`. A key naming NO declared field is exactly
  // the shape `knownDescriptorText`'s own sidecar arm reads back
  // (`Object.getOwnPropertyDescriptor`'s "b" case), so it writes into the
  // SAME `gea::detail::expandoFor` table that arm reads, via
  // `gea::nativeDynamicDefineProperty` (gea_runtime.h) -- one sidecar, shared
  // by both the write and the read, keyed on the object's own identity.
  if (view.kind === 'known') {
    if (key.representation.kind !== 'string') {
      throw createCppEmitBlockedError(
        'host-member-call:ObjectConstructor.defineProperty',
        `"Object.defineProperty" of a known receiver received a key carried as "${representationKey(key.representation)}" rather ` +
          'than a string, and ToPropertyKey of anything else runs ToPrimitive, which this backend does not perform'
      )
    }
    if (view.accessor !== '->') {
      throw createCppEmitBlockedError(
        'host-member-call:ObjectConstructor.defineProperty',
        `"Object.defineProperty" of a "${representationKey(view.representation)}" carrier has an "owned" receiver; a ` +
          "dynamic-property sidecar needs the object's own shared identity to key on"
      )
    }
    const slot = '__gea_descriptor'
    return (
      `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} ` +
      `if (!gea::nativeDynamicDefineProperty(${view.receiver}, ${propertyKeyText(ctx, 'defineProperty', key)}, ${slot})) ` +
      'gea::host::throwRuntimeError("TypeError", "Cannot define native property"); ' +
      `return ${view.receiver}; })()`
    )
  }
  const slot = '__gea_descriptor'
  return (
    `([&]() { ${defineDescriptorLines(ctx, operation, descriptor, slot)} ` +
    `return gea::host::ObjectConstructor::defineProperty(${view.receiver}, ` +
    `${propertyKeyText(ctx, 'defineProperty', key)}, ${slot}); })()`
  )
}

/**
 * `Object`'s statics, dispatched by member.
 *
 * Every member `host-members.ts` claims has an arm here, and every member it
 * does not claim never reaches this function at all -- `nativeHandleMemberText`
 * (emit-host-properties.ts) already refused the ACCESS by name. The final
 * refusal below is therefore for a row that was added to the table without an
 * arm here, which is a defect in this backend rather than in the program, and
 * it says so.
 */
/**
 * `Object.fromEntries` -- ECMA-262 20.1.2.7.
 *
 * The one `Object` static whose SOURCE is an iterable rather than an object, so
 * it does not go through the three primitives above: there is no own-property
 * set to enumerate, only entries to walk. What it does with each is primitive 3
 * (`CreateDataPropertyOrThrow` on a fresh ordinary object), and the fresh
 * ordinary object is a `gea::Dictionary` -- an insertion-ordered string-keyed
 * own-property table with no prototype -- so the runtime states the loop once
 * and this states which sources reach it.
 *
 * A `Map` is stated; every other iterable is refused by name. The specification
 * takes any iterable of entry-like objects, and each other shape this backend
 * can carry -- an array of pairs, a generator -- has its own iteration
 * protocol, so reaching a Map overload with one would be a wrong answer rather
 * than a missing one.
 */
const fromEntriesText = (ctx: EmitContext, operation: CallOperation): string => {
  const source = targetOf(ctx, 'fromEntries', operation)
  const representation = source.representation
  if (representation.kind !== 'keyed-collection' || representation.family !== 'map') {
    throw createCppEmitBlockedError(
      'host-member-call:Object.fromEntries',
      `Object.fromEntries over a "${representationKey(representation)}" source is not rendered: 20.1.2.7 walks any iterable of ` +
        'entries, and only the Map family has a stated iteration here -- an array of pairs or a generator needs its own'
    )
  }
  const text = operandText(ctx, source)
  // A shared Map carrier is a `gea::Ref<Map<...>>`; the runtime primitive
  // deliberately consumes the Map itself so its iteration rule is stated
  // once. Dereference the carrier at this typed boundary rather than adding a
  // second overload or asking C++ template deduction to see through `Ref`.
  const entries = representation.ownership === 'shared-refcount' ? `*(${text})` : text
  const call = `gea::host::ObjectConstructor::fromEntries(${entries})`
  // `Object.fromEntries` is declared to return a dictionary, but a call made
  // through a genuinely dynamic boundary has a dynamic result cell. The
  // fresh dictionary is already a reference carrier, so boxing it here keeps
  // that one object identity while recording the boundary's Object tag.
  return operation.result?.representation.kind === 'dynamic' ? `gea::Value::box(gea::Value::Tag::Object, ${call})` : call
}

/** `Object.is` -- ECMA-262 SameValue over the statically carried operands. */
const isText = (ctx: EmitContext, operation: CallOperation): string => {
  const left = operation.arguments[0]
  const right = operation.arguments[1]
  if (left === undefined || right === undefined) {
    throw createCppEmitBlockedError(
      'host-member-call:Object.is',
      `"Object.is" takes two values, and this call passes ${operation.arguments.length}`
    )
  }
  const leftText = operandText(ctx, left)
  const rightText = operandText(ctx, right)
  const leftCarrier = left.representation
  const rightCarrier = right.representation
  const isNumber = (carrier: Representation): boolean =>
    carrier.kind === 'scalar' && carrier.domain !== 'boolean' && carrier.domain !== 'bigint'

  if (isNumber(leftCarrier) && isNumber(rightCarrier)) {
    return `gea::sameNumberValue(static_cast<double>(${leftText}), static_cast<double>(${rightText}))`
  }
  if (leftCarrier.kind === 'dynamic' && rightCarrier.kind === 'dynamic') {
    return `gea::Value::sameValue(${leftText}, ${rightText})`
  }
  if (leftCarrier.kind === 'null' || leftCarrier.kind === 'undefined') {
    return leftCarrier.kind === rightCarrier.kind ? 'true' : 'false'
  }
  if (representationKey(leftCarrier) !== representationKey(rightCarrier)) return 'false'
  if (
    leftCarrier.kind === 'string' ||
    leftCarrier.kind === 'symbol' ||
    leftCarrier.kind === 'scalar' ||
    leftCarrier.kind === 'array-buffer' ||
    leftCarrier.kind === 'shared-array-buffer' ||
    leftCarrier.kind === 'data-view' ||
    ('ownership' in leftCarrier && leftCarrier.ownership === 'shared-refcount')
  ) {
    return `${leftText} == ${rightText}`
  }
  throw createCppEmitBlockedError(
    'host-member-call:Object.is',
    `"Object.is" over two "${representationKey(leftCarrier)}" carriers has no SameValue comparison; the backend will not ` +
      'substitute storage equality for JavaScript value or object identity'
  )
}

export const objectMemberText = (ctx: EmitContext, member: string, operation: CallOperation): string => {
  if (member === 'keys' || member === 'getOwnPropertyNames') return keysText(ctx, member, operation)
  if (member === 'values') return valuesText(ctx, operation)
  if (member === 'entries') return entriesText(ctx, operation)
  if (member === 'freeze') return integrityText(ctx, member, operation, 'freeze')
  if (member === 'isFrozen') return integrityText(ctx, member, operation, 'isFrozen')
  if (member === 'isExtensible') return integrityText(ctx, member, operation, 'isExtensible')
  if (member === 'seal') return integrityText(ctx, member, operation, 'seal')
  if (member === 'isSealed') return integrityText(ctx, member, operation, 'isSealed')
  if (member === 'preventExtensions') return integrityText(ctx, member, operation, 'preventExtensions')
  if (member === 'hasOwn') return hasOwnText(ctx, operation)
  if (member === 'getPrototypeOf') return getPrototypeOfText(ctx, operation)
  if (member === 'is') return isText(ctx, operation)
  if (member === 'getOwnPropertyDescriptor') return getOwnPropertyDescriptorText(ctx, operation)
  if (hostMemberTemplateOf('ObjectConstructor', member) === 'object-assign') return assignText(ctx, operation)
  if (member === 'fromEntries') return fromEntriesText(ctx, operation)
  if (member === 'create') return createText(operation)
  if (member === 'defineProperty') return definePropertyText(ctx, operation)
  throw createCppEmitBlockedError(
    `host-member-call:Object.${member}`,
    `"ObjectConstructor.${member}" is claimed with a call-site spelling in host-members.ts, but this file states no arm ` +
      'for it -- the row and the renderer have to be added together'
  )
}
