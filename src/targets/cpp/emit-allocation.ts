import { boxedValueText } from './emit-dynamic-properties.js'
import type {
  AllocateRecordOperation,
  AllocateRegExpOperation,
  AllocateTemplateObjectOperation,
  IrRecordFieldInit,
  SpreadCopyOperation
} from '../../ir/model.js'
import {
  isCanonicalNumberPropertyKeyText,
  representationKey,
  type Ownership,
  type RecordField,
  type Representation
} from '../../representation/model.js'
import {
  completeTemplateObjectCarrier,
  isCompleteTemplateObjectCarrier,
  templateObjectCapabilityKeyOf
} from '../../representation/template-object.js'
import { fieldPresenceOf, staticOwnFieldsOf } from '../../representation/record-fields.js'
import { regexpFlagSupportKeyOf, spreadSourceCarrierKeyOf } from '../../ir/certify/carrier-keys.js'
import { createCppEmitBlockedError, defineValue, internTemplateObject, operandText, type EmitContext } from './emit-context.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import {
  cppArrayExtensionStructName,
  cppRecordFieldName,
  cppRecordAccessorEnvironmentName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppStringLiteral,
  cppTypeOf
} from './types.js'
import { declaredRecordFieldOf, declaredFieldRepresentationOf, recordAccessorsOfShape } from './records.js'
import { alignedValueText } from './emit-narrowing.js'
import { cppRegExpNativeTypes } from './regexp-types.js'
import { armAt, armIs } from './emit-union-properties.js'
import { packedEnvironmentText } from './emit-callable.js'

/**
 * How an object literal comes into being.
 *
 * One subject: the allocation itself, and the member writes that follow it.
 * Which of the three shapes a literal takes -- a struct by value, a struct
 * behind a `shared_ptr`, or a keyed container -- is decided by the carrier the
 * deriver already chose, never re-decided here.
 */

const emitFieldInits = (
  ctx: EmitContext,
  lines: string[],
  receiverName: string,
  representation: Representation,
  ownership: Ownership,
  fields: readonly IrRecordFieldInit[]
): void => {
  const accessor = memberAccessOperator(ownership)
  for (const field of fields) {
    const rawValueText = operandText(ctx, field.value)
    // An object literal's OWN inferred carrier for a field can be narrower
    // than the struct it is physically allocated as: a call site that passes
    // `{ src: "x" }` where the parameter declares `src?: string | Uint8Array
    // | ...` allocates that WIDER struct directly, with no intermediate
    // narrow-typed literal ever constructed in between -- so the plain
    // `std::string` this field's own operand carries has to widen into the
    // struct's `Optional<TaggedUnion<...>>` member on this very first write,
    // exactly as `emit-properties.ts`'s `emitFieldStore` already widens a
    // later store into an existing field. Reusing `declaredFieldRepresentationOf`
    // -- the identical authority that store asks -- is what keeps an
    // allocation's first write and a later store from silently disagreeing
    // about whether a field needs one. Without this a `gea::TaggedUnion`
    // field initialized straight from a literal's narrower operand has no
    // implicit conversion clang will accept, and the mismatch was never a
    // narrowing this compiler could see: `AllocateRecordOperation.fields`
    // reads each value's own operand representation, never the receiver's
    // declared one.
    const held = declaredFieldRepresentationOf(ctx.deriver, representation, field.key, ctx.classes)
    const valueText =
      (held ? alignedValueText(ctx, 'emit-allocation.ts:71', field.value.representation, held, rawValueText) : null) ?? rawValueText
    // `field.key` is the layout's own key -- `"0"` for a tuple slot -- not a
    // C++ member name. `renderStructDefinition` declared that member through
    // `cppRecordFieldName`, so the initializer has to reach it the same way.
    lines.push(`${receiverName}${accessor}${cppRecordFieldName(field.key)} = ${valueText};`)
    const declared = declaredRecordFieldOf(ctx.deriver, representation, field.key, ctx.classes)
    if (declared && !declared.required) {
      lines.push(`${receiverName}${accessor}${cppRecordFieldPresenceName(field.key)} = true;`)
    }
  }
}

/**
 * An object literal whose layout is a DICTIONARY, not a struct.
 *
 * A declared type with an index signature (`{ [key: string]: Style }`, a
 * `Record<K, V>`) derives a `dictionary` carrier rather than a record --
 * `deriveObject` routes it there before it ever considers fields -- so a
 * literal written against one has no struct members to assign. Each member is
 * a keyed store instead, through the container's own `operator[]`, which is
 * exactly the store path `gea::Dictionary`/`gea::NumericDictionary` document
 * (`read` is the non-inserting counterpart, for the read side).
 *
 * Nothing here boxes: the container is `Dictionary<V>` over the value carrier
 * the deriver already chose, and each member's own text is written into it
 * unchanged. A numeric-keyed dictionary takes the key as the number it is --
 * `{ 0: x }` is `dict[0]`, not `dict["0"]` -- because the container is keyed by
 * `double` and quoting it would name a key nothing ever reads.
 */
const emitAllocateDictionary = (
  ctx: EmitContext,
  lines: string[],
  operation: AllocateRecordOperation,
  representation: Extract<Representation, { kind: 'dictionary' }>
): void => {
  const name = defineValue(ctx, operation.result)
  if (representation.ownership === 'borrowed') {
    throw createCppEmitBlockedError(
      'runtime-helper:allocation:object-literal:dictionary(borrowed)',
      'a "dictionary" allocation carries ownership "borrowed", but a borrowed reference names an object some other frame owns; ' +
        'there is nothing for an allocation to borrow from'
    )
  }
  // `cppTypeOf(representation, 'owned')` is the container itself, with the
  // ownership wrapper the carrier would otherwise add stripped off -- exactly
  // what `make_shared` needs as its type argument, read from the one authority
  // that spells `gea::Dictionary`/`gea::NumericDictionary` rather than naming
  // either here.
  const storage = cppTypeOf(representation, 'owned')
  lines.push(representation.ownership === 'shared-refcount' ? `${name} = gea::makeRef<${storage}>();` : `${name} = ${storage}{};`)
  const subscript = memberAccessOperator(representation.ownership) === '->' ? `(*${name})` : name
  for (const field of operation.fields) {
    if (representation.key === 'symbol') {
      throw createCppEmitBlockedError(
        'runtime-helper:allocation:object-literal:dictionary(symbol-key)',
        'a symbol-keyed dictionary literal needs the runtime symbol expression for each computed key, but this allocation operation records only its canonical field name'
      )
    }
    // A number-keyed container is keyed by `double`. A property name is always
    // a string in the source, so the numeric key is the name read back as the
    // number it spells -- and a name that does not spell one has no key in this
    // container at all, which refuses rather than silently storing under a
    // value nothing reads.
    if (representation.key === 'number' && !isCanonicalNumberPropertyKeyText(field.key)) {
      throw createCppEmitBlockedError(
        'runtime-helper:allocation:object-literal:dictionary(non-numeric-key)',
        `stores member "${field.key}" into a number-keyed dictionary, but that name does not spell a numeric key`
      )
    }
    // Numeric storage is keyed by the already-canonical PropertyKey text;
    // this safely includes NaN/infinities and preserves -0's alias with "0".
    const key = cppStringLiteral(field.key)
    const rawValueText = operandText(ctx, field.value)
    // A dictionary literal's own members can name narrower carriers than the
    // table's declared value type -- `{ a: true }` against `{ [k: string]:
    // string | number | boolean }` writes a `bool` into a `V` that is really a
    // `gea::TaggedUnion<...>`, exactly the reconciliation
    // `emit-properties.ts`'s own `defineOwnProperty` dictionary store already
    // applies to a LATER keyed write. Widening on the very first write too is
    // what keeps an allocation-time member and a later `dict[k] = v` store
    // from silently disagreeing about whether one needs it.
    const widened =
      alignedValueText(ctx, 'emit-allocation.ts:152', field.value.representation, representation.value, rawValueText) ?? rawValueText
    lines.push(`${subscript}[${key}] = ${widened};`)
  }
}

export const emitAllocateRecord = (ctx: EmitContext, lines: string[], operation: AllocateRecordOperation): void => {
  const representation = operation.result.representation
  if (representation.kind === 'dynamic') {
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = gea::Value::object();`)
    for (const field of operation.fields) {
      lines.push(
        `${name}.setProperty(gea::PropertyKey::string(${cppStringLiteral(field.key)}), ${boxedValueText(ctx, field.value, 'dynamic object field')});`
      )
    }
    return
  }
  if (representation.kind === 'dictionary') {
    emitAllocateDictionary(ctx, lines, operation, representation)
    return
  }
  if (representation.kind !== 'record' && representation.kind !== 'record-with-index' && representation.kind !== 'native-record-ref') {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:object-literal:${representation.kind}`,
      `carries a "${representation.kind}" result, but this emitter only allocates "record", "record-with-index", "native-record-ref" and "dictionary"`
    )
  }
  // Ownership decides how the object comes into being, and the carrier kind
  // does not. All three carriers name their storage through the same
  // authority (`cppRecordStructName`, rendered by `records.ts`), and what
  // separates them is identity semantics -- whether two references to this
  // object are the same object -- which is a question about the *carrier*,
  // already answered before anything reaches this emitter. Dispatching
  // allocation on the kind instead of the ownership is what made a shared
  // `record` refuse while a shared `native-record-ref` allocated, though the
  // two would emit the identical line; it also meant this file refused an
  // allocation the manifest already claimed a recipe for, which is the wrong
  // direction for an over-claim to point.
  //
  // `record-with-index` needs nothing beyond that: its index-signature half
  // (the `gea_dynamic` sidecar `records.ts`'s `renderStructDefinition`
  // already gives every such struct) is a MEMBER of the same struct
  // `cppRecordStructName` names, not a second allocation -- `cppTypeOf`
  // (`types.ts`) already spells `record` and `record-with-index` through the
  // identical `case 'record': case 'record-with-index':` fallthrough, for
  // exactly this reason. An object literal with no computed-key member (the
  // common case: `this.morphAttributes = {}`, later filled by separate
  // `define-own-property` stores -- see `AllocateRecordOperation`'s own
  // comment) allocates the empty struct here and every member, named or
  // indexed, is written afterward through `emit-properties.ts`'s
  // `emitFieldStoreLines` and `emit-carrier-members.ts`'s
  // `emitRecordIndexSidecarStore` -- the identical split a `record` allocation
  // with members installed as later stores already goes through. A literal
  // that DOES supply computed-key members inline reaches `emitFieldInits`
  // below for its named half exactly like a `record` does; nothing here
  // writes to the index sidecar, because `producers/shared.ts`'s own literal
  // lowering never puts an index-signature member in `operation.fields` --
  // only a real property name is.
  // The host's own struct name when one was stated, exactly as `types.ts`'s
  // `cppTypeOf` spells the same carrier -- a `gea_record_*` name minted here
  // would be a second, incompatible identity for a type the engine already
  // declares. The `owned` arm below goes through `cppTypeOf` and so always had
  // this; the shared arm did not, and a stated-native allocation
  // (`gea::runtime::regex::MatchResult`) named a struct nothing defines.
  const structName =
    (representation.kind === 'native-record-ref' ? representation.native : null) ?? cppRecordStructName(representation.shapeId)
  const name = defineValue(ctx, operation.result)
  switch (representation.ownership) {
    case 'owned':
      lines.push(`${name} = ${cppTypeOf(representation)}{};`)
      break
    case 'shared-refcount':
      lines.push(`${name} = gea::makeRef<${structName}>();`)
      break
    case 'borrowed':
      // A borrow is a reference to an object something else owns, and an
      // allocation has no such object to point at: emitting one would have to
      // invent a lifetime the program never states. This is the one ownership
      // that is genuinely unallocatable rather than merely unwritten.
      throw createCppEmitBlockedError(
        `runtime-helper:allocation:object-literal:${representation.kind}(borrowed)`,
        `a "${representation.kind}" allocation carries ownership "borrowed", but a borrowed reference names an object some other ` +
          'frame owns; there is nothing for an allocation to borrow from'
      )
  }
  emitFieldInits(ctx, lines, name, representation, representation.ownership, operation.fields)
  emitAccessorEnvironments(ctx, lines, name, representation, representation.ownership)
}

/**
 * The environment a capturing accessor is entered with, stored on the object
 * the accessor is reached through.
 *
 * An accessor has no `CallableObject` to carry its captures -- it is called by
 * name off the shape (`emit-properties.ts`) -- so `get current() { return n +
 * 1 }` written inside a function had nowhere to receive that function's `n`
 * from, and refused. The object IS the transport: it is allocated in the very
 * frame that owns the cells, so the environment is packed HERE, exactly as an
 * `allocate-callable` packs one, through the same `packedEnvironmentText`.
 * Which halves carry one is `captures.ts`'s admission, the same answer
 * `renderStructDefinition` declared the member from.
 */
const emitAccessorEnvironments = (
  ctx: EmitContext,
  lines: string[],
  receiverName: string,
  representation: Representation,
  ownership: Ownership
): void => {
  const accessors =
    representation.kind === 'record'
      ? representation.accessors
      : representation.kind === 'native-record-ref'
        ? (recordAccessorsOfShape(ctx.deriver, representation.shapeId) ?? [])
        : []
  const member = memberAccessOperator(ownership)
  for (const accessor of accessors) {
    for (const half of ['getter', 'setter'] as const) {
      const body = half === 'getter' ? accessor.getter : accessor.setter
      if (body === null) continue
      const admission = ctx.captures.of(body)
      if (admission.kind === 'none') continue
      if (admission.kind === 'refused') {
        throw createCppEmitBlockedError(
          `capture:accessor:${accessor.key}`,
          `the ${half} of "${accessor.key}" captures a cell this allocation cannot transport: ${admission.reason}`
        )
      }
      lines.push(
        `${receiverName}${member}${cppRecordAccessorEnvironmentName(accessor.key, half)} = ${packedEnvironmentText(ctx, lines, body, admission)};`
      )
    }
  }
}

/**
 * The lines that fill one array member with `texts`, through the same
 * `make_shared` + `push` sequence `emit-arrays.ts` allocates an array literal
 * with -- the identical carrier and the identical runtime call, so a template
 * object's arrays and an ordinary one's are one thing, not two.
 */
const templateArrayLines = (
  target: string,
  array: Extract<Representation, { kind: 'array-object' }>,
  texts: readonly string[],
  role: string
): readonly string[] => {
  if (array.element.kind !== 'string') {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(array)}`,
      `a template object's ${role} array holds "${representationKey(array.element)}" elements; GetTemplateObject fills both arrays with strings`
    )
  }
  if (array.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(array)}`,
      `a template object's ${role} array carries ownership "${array.ownership}"; only a shared array is spelled with std::make_shared here`
    )
  }
  return [
    `${target} = gea::makeRef<gea::ArrayObject<${cppTypeOf(array.element)}>>();`,
    ...texts.map((text) => `${target}->push(${cppStringLiteral(text)});`)
  ]
}

/**
 * The ordinary `TemplateStringsArray` carrier: an Array whose one extra own
 * field, `raw`, lives in its typed extension sidecar.
 *
 * `raw` cannot be a separate record wrapped around the Array. The language
 * hands the cooked Array itself to the tag, and `raw` is an own property of
 * that same identity. The ArrayObject extension is the native representation
 * of exactly that shape, so this keeps the indexed cooked values and `raw`
 * together without boxing either one.
 */
const templateArrayObjectBody = (
  carrier: Extract<Representation, { kind: 'array-object' }>,
  operation: AllocateTemplateObjectOperation
): { readonly holder: string; readonly body: readonly string[] } => {
  if (carrier.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(carrier)}`,
      `a template object carries ownership "${carrier.ownership}", but per-site identity needs one shared object every evaluation reaches, not a per-evaluation copy`
    )
  }
  if (carrier.element.kind !== 'string') {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(carrier)}`,
      `a template object's cooked array holds "${representationKey(carrier.element)}" elements; GetTemplateObject fills it with strings`
    )
  }
  const extension = carrier.extension
  const rawFields = extension?.filter((field) => field.key === 'raw') ?? []
  if (rawFields.length !== 1 || extension === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(carrier)}`,
      'a TemplateStringsArray carrier declares no unique "raw" extension field for GetTemplateObject to install'
    )
  }
  if (extension.some((field) => field.key !== 'raw')) {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(carrier)}`,
      'a TemplateStringsArray carrier declares extension fields besides "raw"; GetTemplateObject does not invent values for them'
    )
  }
  const raw = rawFields[0]
  if (raw === undefined) {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(carrier)}`,
      'a TemplateStringsArray carrier declared one "raw" extension field but did not retain it for GetTemplateObject to install'
    )
  }
  if (!raw.required || raw.value.kind !== 'array-object') {
    throw createCppEmitBlockedError(
      `runtime-helper:${templateObjectCapabilityKeyOf(raw.value)}`,
      `a template object's "raw" extension carries "${representationKey(raw.value)}"; GetTemplateObject sets it to a required Array of raw strings`
    )
  }

  const holder = cppTypeOf(carrier)
  const rawMember = `gea_object->template extensionFieldsMut<${cppArrayExtensionStructName(extension)}>().${cppRecordFieldName(raw.key)}`
  const body = [
    `${holder} gea_object = gea::makeRef<${cppTypeOf(carrier, 'owned')}>();`,
    ...operation.cooked.map((segment) =>
      segment.kind === 'undefined' ? 'gea_object->pushUndefined();' : `gea_object->push(${cppStringLiteral(segment.text)});`
    ),
    ...templateArrayLines(rawMember, raw.value, operation.raw, 'raw'),
    `gea::finalizeTemplateObject(gea_object, ${rawMember});`,
    'return gea_object;'
  ]
  return { holder, body }
}

/**
 * `` tag`a${b}c` ``'s first argument: the template object, built once per site.
 *
 * The per-site `static` IS the semantics. ECMA-262 13.2.8.3 caches
 * `GetTemplateObject` per Parse Node, so the tag must be handed the same object
 * on every evaluation -- that is what makes a `WeakMap`-keyed tag cache (the
 * dominant real use of tagged templates) work at all. A fresh object per
 * evaluation would compile, run, and be quietly wrong.
 *
 * Only the native Array exotic carrier is admitted. A record-with-index can
 * resemble the checker's structural declaration, but it cannot implement
 * Array index/length descriptors, frozen integrity, or the exact `raw` own
 * property. Treating that resemblance as a carrier was therefore a silent
 * semantic downgrade, not another valid lowering.
 */
export const emitAllocateTemplateObject = (ctx: EmitContext, lines: string[], operation: AllocateTemplateObjectOperation): void => {
  const representation = operation.result.representation
  if (isCompleteTemplateObjectCarrier(representation)) {
    // Render from the same canonical object the predicate compared against, so
    // this function cannot gradually grow a second, broader carrier contract.
    const { holder, body } = templateArrayObjectBody(completeTemplateObjectCarrier, operation)
    const accessor = internTemplateObject(ctx.templateObjects, operation, holder, body)
    const name = defineValue(ctx, operation.result)
    lines.push(`${name} = ${accessor}();`)
    return
  }
  throw createCppEmitBlockedError(
    `runtime-helper:${templateObjectCapabilityKeyOf(representation)}`,
    `a template object carries "${representationKey(representation)}"; the complete GetTemplateObject contract requires an ` +
      'array-object with a required raw string-array extension and shared ownership, because a structural record cannot implement Array exotic ' +
      'index/length descriptors, frozen integrity, or invalid-escape cooked undefined slots'
  )
}

/**
 * A regular-expression literal (ECMA-262 22.2.4.1 `RegExp(pattern, flags)`).
 *
 * Rendered as a construction of the runtime's own pattern type, never as a
 * struct with ten fields written one by one, and the difference is not
 * cosmetic. `RegExpInitialize` (22.2.3.2) parses the source, validates the
 * flags, and DERIVES `global`/`ignoreCase`/`multiline`/`sticky`/`unicode`/
 * `dotAll`/`hasIndices` from the flag string -- so the ten members a reader
 * sees are one constructor's answers, not ten independent stores. A field-by-
 * field allocation would also skip the SyntaxError 22.2.3.2 step 6 throws for
 * a repeated or unknown flag.
 *
 * The carrier check is a real gate rather than a formality: this operation is
 * only reachable for a result the deriver gave the pattern carrier to, and if
 * some other carrier ever reached here the honest answer is a refusal, not a
 * construction of a type the value is not held in.
 */
/**
 * Whether a pattern source contains an ES2018 Unicode PROPERTY ESCAPE
 * (`\p{...}` / `\P{...}`).
 *
 * `std::regex` has no such construct or Unicode Character Database. The
 * runtime rejects a computed source at construction; a LITERAL's source is
 * known here, so the honest answer is a refusal at build time instead.
 *
 * Only when the pattern is in Unicode mode: outside it, Annex B B.1.2 makes
 * `\p` an IdentityEscape for the letter `p`, which `std::regex` matches
 * correctly. Written as a character walk because the architecture gate
 * forbids a RegExp literal under `targets/cpp` -- and because a regular
 * expression that scans regular-expression source is the wrong instrument for
 * a question this simple.
 */
const namesAUnicodePropertyEscape = (source: string, flags: string): boolean => {
  if (!flags.includes('u') && !flags.includes('v')) return false
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 92) continue
    const marker = source.charAt(index + 1)
    if ((marker === 'p' || marker === 'P') && source.charAt(index + 2) === '{') return true
    // Every other escape consumes its own next character, so `\\p{L}` -- an
    // escaped backslash followed by a literal `p` -- is not one of these.
    index += 1
  }
  return false
}

export const emitAllocateRegExp = (ctx: EmitContext, lines: string[], operation: AllocateRegExpOperation): void => {
  const representation = operation.result.representation
  const nativePattern = representation.kind === 'native-record-ref' && representation.native === cppRegExpNativeTypes.pattern
  if (!nativePattern && representation.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:regexp-object:${representation.kind}(${regexpFlagSupportKeyOf(operation.flags)})`,
      `a regular-expression literal is carried as "${representationKey(representation)}"; this backend builds one as ${cppRegExpNativeTypes.pattern} or boxes that exact Pattern at a dynamic boundary`
    )
  }
  if (namesAUnicodePropertyEscape(operation.source, operation.flags)) {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:regexp-object:${representation.kind}(${regexpFlagSupportKeyOf(operation.flags)})`,
      `the pattern /${operation.source}/${operation.flags} names an ES2018 Unicode property escape (\\p{...}); std::regex, which this backend's ` +
        "matcher and v1 geatsc's both compile against, has no such construct and no Unicode Character Database to answer one from. Refused here rather " +
        "than at run time because a literal's source is known now -- a pattern built from a computed string still fails closed as a SyntaxError during " +
        'RegExp construction'
    )
  }
  if (operation.flags.includes('v')) {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:regexp-object:${representation.kind}(${regexpFlagSupportKeyOf(operation.flags)})`,
      `the pattern /${operation.source}/${operation.flags} uses UnicodeSets RegExp semantics; the native matcher has no UnicodeSets parser or set-string ` +
        'implementation, so this literal is refused rather than being routed through an incompatible character-class grammar'
    )
  }
  if (operation.flags.includes('u') && operation.flags.includes('i')) {
    throw createCppEmitBlockedError(
      `runtime-helper:allocation:regexp-object:${representation.kind}(${regexpFlagSupportKeyOf(operation.flags)})`,
      `the pattern /${operation.source}/${operation.flags} combines Unicode matching with ignoreCase; std::regex has no ECMAScript Unicode simple-case-folding ` +
        'table, so this literal is refused rather than claiming locale-dependent case behavior is JavaScript Unicode semantics'
    )
  }
  const name = defineValue(ctx, operation.result)
  // `constructPatternOrThrow` rather than `gea::makeRef<Pattern>` directly:
  // it is the ported entry point that runs 22.2.3.2's validation first, so an
  // unknown or repeated flag throws where the language says it throws. The
  // ownership the deriver chose is `shared-refcount` unconditionally for this
  // carrier (see `derive.ts`), which is what the helper returns.
  const construct = `gea::runtime::regex::constructPatternOrThrow(${cppStringLiteral(operation.source)}, ${cppStringLiteral(operation.flags)})`
  lines.push(
    representation.kind === 'dynamic' ? `${name} = gea::Value::box(gea::Value::Tag::Object, ${construct});` : `${name} = ${construct};`
  )
}

// Re-exported so `emit.ts` can fold this into its existing single-line
// `emit-allocation.js` import instead of adding a whole new import line --
// `emit.ts` sits at the architecture gate's line cap. The implementation
// itself lives in `emit-tonumber.ts`, where the rest of ToNumber/ToNumeric
// conversion already lives; this file has nothing to do with allocation.
export { emitToNumericCoercion } from './emit-tonumber.js'

/**
 * Object spread's `CopyDataProperties` for a source whose own-property set is
 * not known until this runs -- `SpreadCopyOperation` (ir/model.ts), lowered
 * from `producers/protocol.ts`'s `protocol: 'spread'` operation by
 * `ir/lower-protocol.ts`. Lives here, not in a file of its own: it is one
 * more way an object's own storage gets written -- the same subject this
 * file's `emitAllocateDictionary` (above) already owns for a literal's own
 * keys -- and `targets/cpp` sits at the architecture gate's per-directory
 * file-count cap, so a new top-level file for one function is not free here.
 *
 * This backend renders two deliberately narrow receiver/source pairs:
 * `dynamic` into `dynamic`, with the full CopyDataProperties key,
 * descriptor, Get, and CreateDataProperty sequence; and a plain
 * `dictionary` receiver with the statically selected structural source
 * carriers below. A dynamic source does not certify the dictionary path: it
 * may contain symbol keys that the dictionary's string-key insertion loop
 * cannot preserve.
 *
 * The SOURCE may be a plain `dictionary`, a `tagged-union` whose arms are
 * each a `dictionary` or a `record`, or an `optional` wrapping either of
 * those -- `HeaderRecord`'s own three arms (`Record<'Content-Type',
 * BaseMime> | Record<ResponseHeader, string | string[]> | Record<string,
 * string | string[]>`) are exactly one `record`, one `record` and one
 * `dictionary`, and `setDefaultContentType`'s `headers?: HeaderRecord`
 * parameter wraps that same union `optional`. A `dictionary` arm's copy is a
 * runtime walk (`gea::Dictionary::copyInto`, gea_runtime.h); a `record` arm's
 * copy is a static per-FIELD unroll, since its keys are known at compile
 * time; an `optional` source is `CopyDataProperties(obj, source)` itself --
 * spreading `null`/`undefined` is a no-op per that abstract operation, so an
 * absent optional renders no copy at all, and a present one recurses into
 * whichever of the two shapes its payload is. Any other kind -- `record-
 * with-index`, `native-record-ref`, `class-ref`, ... -- refuses by name:
 * unrolling those needs a field list this file does not have a uniform way
 * to read yet, and a record arm with an accessor member refuses for the same
 * reason `producers/shared.ts`'s `staticSpreadMembersOf` already refuses one
 * on the static-copy path -- an accessor must be CALLED, which is not
 * modelled here.
 */
export const emitSpreadCopy = (ctx: EmitContext, lines: string[], operation: SpreadCopyOperation): void => {
  const receiver = operation.receiver.representation
  const source = operation.source.representation
  if (source.kind === 'dynamic' && receiver.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:spread:next:${spreadSourceCarrierKeyOf(source.kind, source, receiver, ctx.deriver)}`,
      `requires a dynamic object-spread receiver for a dynamic source, but the receiver is a "${representationKey(receiver)}"; this runtime-key walk is installed only for a dynamic receiver`
    )
  }
  if (receiver.kind === 'dynamic') {
    if (source.kind !== 'dynamic') {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:spread:next:${spreadSourceCarrierKeyOf(source.kind, source, receiver, ctx.deriver)}`,
        `writes a dynamic object-spread receiver from a "${representationKey(source)}" source; this runtime-key walk is installed only for a dynamic source`
      )
    }
    const receiverText = operandText(ctx, operation.receiver)
    const sourceText = operandText(ctx, operation.source)
    lines.push('{')
    lines.push(`const auto& __gea_spread_source = ${sourceText};`)
    lines.push('if (__gea_spread_source.tag() != gea::Value::Tag::Null && __gea_spread_source.tag() != gea::Value::Tag::Undefined) {')
    lines.push('for (const gea::PropertyKey& __gea_spread_key : __gea_spread_source.ownPropertyKeys()) {')
    lines.push('gea::PropertyDescriptor __gea_spread_descriptor;')
    lines.push(
      'if (!__gea_spread_source.ownDescriptor(__gea_spread_key, __gea_spread_descriptor) || !__gea_spread_descriptor.enumerable) continue;'
    )
    lines.push(
      `if (!${receiverText}.defineProperty(__gea_spread_key, gea::PropertyDescriptor::assignment(__gea_spread_source.getProperty(__gea_spread_key)))) {`
    )
    lines.push('gea::host::throwRuntimeError("TypeError", "object spread target rejected a property");')
    lines.push('}')
    lines.push('}')
    lines.push('}')
    lines.push('}')
    return
  }
  if (receiver.kind !== 'dictionary') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:spread:next:${spreadSourceCarrierKeyOf(source.kind, source, receiver, ctx.deriver)}`,
      `writes a runtime object-spread copy into a "${receiver.kind}" receiver, but this emitter only renders one into a "dictionary"`
    )
  }
  if (receiver.ownership === 'borrowed') {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:spread:next:dictionary(borrowed)',
      'writes into a dictionary receiver carried with ownership "borrowed", which names no object this copy may write through'
    )
  }
  const receiverText = operandText(ctx, operation.receiver)
  const receiverRef = memberAccessOperator(receiver.ownership) === '->' ? `(*${receiverText})` : receiverText
  const sourceText = operandText(ctx, operation.source)
  emitSpreadSourceCopy(ctx, lines, source, sourceText, receiver, receiverRef)
}

const emitSpreadSourceCopy = (
  ctx: EmitContext,
  lines: string[],
  source: Representation,
  sourceText: string,
  receiver: Extract<Representation, { kind: 'dictionary' }>,
  receiverRef: string
): void => {
  // `null`/`undefined` copy nothing (`CopyDataProperties`'s own definition),
  // so the absent branch is simply empty rather than a converted "empty
  // dictionary" write -- there is no receiver mutation to make at all.
  if (source.kind === 'optional') {
    lines.push(`if (${sourceText}.has_value()) {`)
    emitSpreadSourceCopy(ctx, lines, source.payload, `(*${sourceText})`, receiver, receiverRef)
    lines.push('}')
    return
  }
  if (source.kind !== 'tagged-union') {
    emitSpreadArmCopy(ctx, lines, source, sourceText, receiver, receiverRef)
    return
  }
  const arms = source.arms
  if (arms.length === 0) {
    throw createCppEmitBlockedError(
      'runtime-helper:protocol:spread:next:tagged-union(no-arms)',
      'reads a runtime object-spread source carried as a tagged union with no arms'
    )
  }
  if (arms.length === 1) {
    emitSpreadArmCopy(ctx, lines, arms[0]!.value, armAt(sourceText, 0), receiver, receiverRef)
    return
  }
  // Exactly one arm is live at runtime (`gea::TaggedUnion`'s own invariant),
  // so each arm's copy is guarded by `armIs` -- the same per-arm dispatch
  // style `emit-union-properties.ts`'s other renderers use. The last arm
  // needs no guard: the union has already proven live by elimination.
  arms.forEach((arm, index) => {
    const isLast = index === arms.length - 1
    lines.push(index === 0 ? `if (${armIs(sourceText, index)}) {` : isLast ? '} else {' : `} else if (${armIs(sourceText, index)}) {`)
    emitSpreadArmCopy(ctx, lines, arm.value, armAt(sourceText, index), receiver, receiverRef)
  })
  lines.push('}')
}

const emitSpreadArmCopy = (
  ctx: EmitContext,
  lines: string[],
  arm: Representation,
  armText: string,
  receiver: Extract<Representation, { kind: 'dictionary' }>,
  receiverRef: string
): void => {
  if (arm.kind === 'dictionary') {
    emitSpreadDictionaryArmCopy(ctx, lines, arm, armText, receiver, receiverRef)
    return
  }
  // A `class-ref` and a data-only `native-record-ref` name their field list
  // rather than carrying it, and `CopyDataProperties` copies exactly that
  // list: a class instance's own enumerable keys ARE the fields, since its
  // methods and accessors live on the prototype and are not own properties at
  // all. `staticOwnFieldsOf` (representation/record-fields.ts) is the one
  // place that rule is stated, and it is the same function the preflight key
  // admitting this source consulted -- reading a different list here than the
  // one that licensed the render is the certify-then-crash that key exists to
  // prevent.
  const fields = staticOwnFieldsOf(ctx.deriver, arm)
  if (fields !== null && (arm.kind !== 'record' || arm.accessors.length === 0)) {
    emitSpreadFieldCopy(ctx, lines, fields, `${armText}${memberAccessOperator(ownershipOfSpreadArm(arm))}`, receiver, receiverRef)
    return
  }
  throw createCppEmitBlockedError(
    `runtime-helper:protocol:spread:next:${spreadSourceCarrierKeyOf(arm.kind, arm, receiver, ctx.deriver)}`,
    `reads a runtime object-spread source carried as "${arm.kind}", but this emitter only copies a source whose own key set a static ` +
      'field list reproduces exactly: a "dictionary", or a record/class shape with no accessor member'
  )
}

/** A shape-named source's ownership, which decides whether its fields are reached through `.` or `->`. */
const ownershipOfSpreadArm = (arm: Representation): Ownership =>
  arm.kind === 'record' || arm.kind === 'class-ref' || arm.kind === 'native-record-ref' ? arm.ownership : 'owned'

/** A converting lambda for a value type this emitter cannot express as a bare identity -- `emit-narrowing.ts`'s own conversion text, wrapped as a callable `gea::Dictionary::copyInto` invokes per entry. */
const spreadConvertingLambda = (ctx: EmitContext, source: Representation, target: Representation): string => {
  const converted = alignedValueText(ctx, 'emit-allocation.ts:640', source, target, '__v')
  if (converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(target)}`,
      `copies a dictionary source whose value is carried as "${representationKey(source)}" into a receiver whose value is carried as ` +
        `"${representationKey(target)}"; no conversion between those is licensed`
    )
  }
  return `[](const ${cppTypeOf(source)}& __v) { return ${converted}; }`
}

const emitSpreadDictionaryArmCopy = (
  ctx: EmitContext,
  lines: string[],
  arm: Extract<Representation, { kind: 'dictionary' }>,
  armText: string,
  receiver: Extract<Representation, { kind: 'dictionary' }>,
  receiverRef: string
): void => {
  if (arm.key !== receiver.key) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:spread:next:${spreadSourceCarrierKeyOf('dictionary', arm, receiver, ctx.deriver)}`,
      `copies a "${arm.key}"-keyed dictionary source into a "${receiver.key}"-keyed dictionary receiver; the two key domains do not convert`
    )
  }
  const armMember = `${armText}${memberAccessOperator(arm.ownership)}`
  const sameValueShape = representationKey(arm.value) === representationKey(receiver.value)
  const converter = sameValueShape ? '[](const auto& __v) { return __v; }' : spreadConvertingLambda(ctx, arm.value, receiver.value)
  lines.push(`${armMember}copyInto(${receiverRef}, ${converter});`)
}

const emitSpreadFieldCopy = (
  ctx: EmitContext,
  lines: string[],
  fields: readonly RecordField[],
  armMember: string,
  receiver: Extract<Representation, { kind: 'dictionary' }>,
  receiverRef: string
): void => {
  if (receiver.key !== 'string' && fields.length > 0) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:spread:next:record->dictionary(${receiver.key})`,
      `copies statically named string fields into a "${receiver.key}"-keyed dictionary receiver; CopyDataProperties cannot change their PropertyKey domain`
    )
  }
  for (const field of fields) {
    if (field.key.startsWith('sym(')) {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:spread:next:record(symbol-field)',
        `copies the symbol-named field "${field.key}", whose runtime Symbol identity cannot be reconstructed from its representation field name`
      )
    }
    // A field that may be absent is copied only when it IS there --
    // `CopyDataProperties` (ECMA-262 7.3.25) walks the source's OWN property
    // keys, and a missing key contributes nothing. Generated record storage's
    // explicit presence bit is independent of the value carrier, so a present
    // `undefined` is copied while an absent field is skipped.
    if (fieldPresenceOf(field) === 'unprovable') {
      throw createCppEmitBlockedError(
        'runtime-helper:protocol:spread:next:record(unprovable-presence)',
        `copies a record source field "${field.key}" whose presence is unprovable beside "${representationKey(field.value)}"; this ` +
          'emitter copies a required field or an optional generated field with an independent presence bit'
      )
    }
    const fieldText = `${armMember}${cppRecordFieldName(field.key)}`
    const readText = fieldText
    const converted = alignedValueText(ctx, 'emit-allocation.ts:704', field.value, receiver.value, readText)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(field.value)}->${representationKey(receiver.value)}`,
        `copies a record source field "${field.key}" carried as "${representationKey(field.value)}" into a receiver whose value is carried as ` +
          `"${representationKey(receiver.value)}"; no conversion between those is licensed`
      )
    }
    const write = `${receiverRef}[${cppStringLiteral(field.key)}] = ${converted};`
    lines.push(field.required ? write : `if (${armMember}${cppRecordFieldPresenceName(field.key)}) { ${write} }`)
  }
}
