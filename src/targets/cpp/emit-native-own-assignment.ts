import type { CallOperation } from '../../ir/model.js'
import type { NativeOwnAssignmentRecipe } from '../../ir/native-own-assignment.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { nativeFieldPolicyType } from './records.js'
import { armAt, armIs } from './emit-union-properties.js'
import { cppStringLiteral, cppTypeOf } from './types.js'

/** Every source keeps its evaluated argument and walks current enumerable
 * native keys in ECMAScript order. Field values are read once at the copy
 * step through the original native descriptor route, then stored natively.
 */
export const nativeOwnAssignmentText = (ctx: EmitContext, operation: CallOperation): string | null => {
  const receipt = operation.nativeOwnAssignment
  if (receipt === undefined) return null
  const owner = operandText(ctx, receipt.owner)
  // Installing the holder never boxes; the descriptor engine calls this only for an accounted dynamic observer.
  const materializerText = (id: string | undefined, held: string): string => {
    if (id === undefined) return ''
    const node = ctx.conversions.nodeById(id)
    const rendered = node === null ? null : recipeText(ctx, node, 'gea_data')
    if (rendered === null)
      throw createCppEmitBlockedError(`conversion:${id}`, 'a native Object.assign extension lost its certified observation')
    return `, +[](const ${held}& gea_data) -> gea::Value { return ${rendered}; }`
  }
  const sourceText = (source: NativeOwnAssignmentRecipe['sources'][number], representation: Representation, text: string): string => {
    if (representation.kind === 'null' || representation.kind === 'undefined') return ''
    if (representation.kind === 'optional')
      return `if (${text}.has_value()) { ${sourceText(source, representation.payload, `(*${text})`)} }`
    if (representation.kind === 'tagged-union')
      return representation.arms
        .map(
          (arm, index) =>
            `${index === 0 ? 'if' : 'else if'} (${armIs(text, index)}) { ${sourceText(source, arm.value, armAt(text, index))} }`
        )
        .join(' ')
    if (
      source.protocol === 'dictionary-entry' &&
      (representation.kind !== 'dictionary' || representation.key !== 'string' || representation.value.kind !== 'dynamic')
    )
      throw createCppEmitBlockedError('call-abi:native-own-assignment', 'a native table copy lost its certified dictionary entry protocol')
    const branches = source.fields.map((field, index) => {
      const storage = cppTypeOf(field.storage)
      const policy = nativeFieldPolicyType(field.storage)
      const key = `gea::PropertyKey::string(${cppStringLiteral(field.key)})`
      const node = ctx.conversions.nodeById(field.conversion)
      const converted = node === null ? null : recipeText(ctx, node, '(*gea_assign_value)')
      if (converted === null)
        throw createCppEmitBlockedError(`conversion:${field.conversion}`, 'a native Object.assign store lost its certified slot conversion')
      const held = cppTypeOf(field.held)
      const heldPolicy = nativeFieldPolicyType(field.held)
      const write =
        field.destination === 'extension'
          ? `gea::nativeObjectDataSet<${heldPolicy}>(${owner}, ${key}, gea_assign_stored${materializerText(field.materialization, held)})`
          : `(gea::nativeOwnFieldsWritable(${owner}) && ${owner}->gea_writeOwnFieldNative(${key}, ` +
            `gea::NativeFieldWrite::exact<${held}, ${heldPolicy}>(gea_assign_stored), gea::nativeIsExtensible(${owner})))`
      // A Document entry is a Value; the same reader converts it by its exact
      // live entry recipe, and takes a native slot's payload unchanged.
      const documentLeaf = field.documentRead === undefined ? null : ctx.conversions.nodeById(field.documentRead)
      const documentText = documentLeaf === null ? null : recipeText(ctx, documentLeaf, '*static_cast<const gea::Value*>(gea_native)')
      if (field.documentRead !== undefined && documentText === null)
        throw createCppEmitBlockedError(`conversion:${field.documentRead}`, 'a native Object.assign read lost its certified Document entry')
      const tag = (type: string): string => `gea::detail::payloadTypeTagFor<${type}>()`
      const reader =
        documentText === null
          ? `gea::NativeFieldRead gea_assign_read(gea_assign_value, ${policy}{}); `
          : `gea::NativeFieldRead gea_assign_read(gea_assign_value, ` +
            `+[](void* gea_out, const void* gea_type, const void* gea_policy, const void* gea_native) -> bool { ` +
            `if (gea_type == ${tag(storage)} && gea_policy == ${tag(policy)}) { static_cast<std::optional<${storage}>*>(gea_out)->emplace(*static_cast<const ${storage}*>(gea_native)); return true; } ` +
            `if (gea_type == ${tag('gea::Value')} && gea_policy == ${tag('gea::NativeFieldLeafPolicy')}) { static_cast<std::optional<${storage}>*>(gea_out)->emplace(${documentText}); return true; } ` +
            'return false; }, ' +
            `+[](const void* gea_type, const void* gea_policy) -> bool { return (gea_type == ${tag(storage)} && gea_policy == ${tag(policy)}) || ` +
            `(gea_type == ${tag('gea::Value')} && gea_policy == ${tag('gea::NativeFieldLeafPolicy')}); }); `
      const read =
        source.protocol === 'dictionary-entry'
          ? `std::optional<${storage}> gea_assign_value(gea_assign_source->read(gea_assign_key.text())); `
          : `std::optional<${storage}> gea_assign_value; ${reader}` +
            'const gea::Ref<void> gea_assign_erased(gea_assign_source); ' +
            'const bool gea_assign_read_ok = gea::record::hasLiveFieldView(gea_assign_erased) ' +
            '? gea::record::readFieldView(gea_assign_erased, gea_assign_key, gea_assign_read) ' +
            ': (gea_assign_source->gea_readOwnFieldNative(gea_assign_key, gea_assign_read) || ' +
            'gea::nativeObjectDataReadNative(gea_assign_source, gea_assign_key, gea_assign_read)); ' +
            'if (!gea_assign_read_ok || !gea_assign_value) gea::host::throwRuntimeError("TypeError", "a native copy source changed its certified storage"); '
      return (
        `${index === 0 ? 'if' : 'else if'} (gea_assign_key.text() == ${cppStringLiteral(field.key)}) { ` +
        read +
        `const ${held} gea_assign_stored = ${converted}; ` +
        `if (!${write}) gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property"); }`
      )
    })
    // A described source's run-time key outside its typed fields is a Value
    // already (an expando, a document entry): it is copied as one, through
    // the target's own [[Set]] dispatch.
    const unknown =
      source.described === true
        ? `if (!gea::nativeDynamicSet(${owner}, gea_assign_key, gea::nativeDynamicGet(gea_assign_source, gea_assign_key))) ` +
          'gea::host::throwRuntimeError("TypeError", "Cannot assign to read only property");'
        : 'gea::host::throwRuntimeError("TypeError", "a closed native copy source acquired an unauthenticated key");'
    const enumeration =
      source.protocol === 'dictionary-entry'
        ? 'for (const std::string& gea_assign_text : gea_assign_source->enumerableKeys()) { ' +
          'const gea::PropertyKey gea_assign_key = gea::PropertyKey::string(gea_assign_text); '
        : 'for (const gea::PropertyKey& gea_assign_key : gea::nativeEnumerableStringKeys(gea_assign_source)) { '
    const copy = enumeration + `${branches.join(' ')} ${branches.length ? 'else ' : ''}{ ${unknown} } }`
    if (source.protocol === 'dictionary-entry' || source.described === true)
      return `{ const auto& gea_assign_source = ${text}; if (gea_assign_source) { ${copy} } }`
    const roots = new Map(
      source.roots
        .filter((root) => root.readers.some((reader) => representationKey(reader.surface) === representationKey(representation)))
        .map((root) => [representationKey(root.carrier), root] as const)
    )
    if (roots.size === 0)
      throw createCppEmitBlockedError('call-abi:native-own-assignment', 'a native copy arm lost its certified original storage reader')
    const originals = [...roots.values()].map((root, index) => {
      const pointee = `typename ${cppTypeOf(root.carrier)}::element_type`
      return (
        `${index === 0 ? 'if' : 'else if'} (gea::detail::refPayloadIdentity(gea_assign_origin) == ` +
        `&gea::detail::RefOperationsFor<${pointee}>::table) { ` +
        `const auto gea_assign_source = gea_assign_origin.template staticCast<${pointee}>(); ${copy} }`
      )
    })
    return (
      `{ const auto& gea_assign_public = ${text}; if (gea_assign_public) { ` +
      'const gea::Ref<void> gea_assign_erased_public(gea_assign_public); ' +
      'const gea::Ref<void> gea_assign_origin = gea::record::hasLiveFieldView(gea_assign_erased_public) ' +
      '? gea::record::viewOrigin(gea_assign_public) : gea_assign_erased_public; ' +
      `${originals.join(' ')} else { ` +
      'gea::host::throwRuntimeError("TypeError", "a native copy source lost its authenticated original allocation"); } } }'
    )
  }
  const copies = receipt.sources
    .map((source) => sourceText(source, source.receiver.representation, operandText(ctx, source.receiver)))
    .join(' ')
  const result = operation.result === null ? '' : `return ${owner};`
  return `([&]() { ${copies} ${result} })()`
}
