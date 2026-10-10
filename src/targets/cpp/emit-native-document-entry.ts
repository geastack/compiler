import type { GetOperation, SetOperation } from '../../ir/model.js'
import { cppTypeOf } from './types.js'
import { operandText, createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { propertyKeyText } from './emit-dynamic-properties.js'
import { withFieldReceiver } from './emit-native-field-view.js'

/** The installed source protocol handles a runtime string, not a target field dispatcher. */
export const nativeDocumentEntryText = (ctx: EmitContext, operation: GetOperation | SetOperation): string | null => {
  const receipt = operation.nativeDocumentEntry
  if (!receipt) return null
  const leaf = ctx.conversions.nodeById(receipt.conversion)
  const converted =
    leaf === null
      ? null
      : recipeText(ctx, leaf, operation.kind === 'get' ? '*static_cast<const gea::Value*>(gea_native)' : 'gea_document_written')
  if (converted === null)
    throw createCppEmitBlockedError(`conversion:${receipt.conversion}`, 'a Document entry lost its exact future conversion')
  const dynamicEntry = (text: string): string => {
    const rendered = leaf === null ? null : recipeText(ctx, leaf, text)
    if (rendered === null)
      throw createCppEmitBlockedError(`conversion:${receipt.conversion}`, 'a dynamic Document arm lost its exact entry conversion')
    return rendered
  }
  const bound = {
    ...ctx,
    valueNames: new Map(ctx.valueNames).set(operation.key.value, 'gea_document_key_input'),
    deferredTexts: new Map(ctx.deferredTexts),
    pendingPacks: new Map(ctx.pendingPacks)
  }
  bound.deferredTexts.delete(operation.key.value)
  bound.pendingPacks.delete(operation.key.value)
  const property = propertyKeyText(bound, operation.key, 'a native Document entry')
  const bind =
    `const auto& gea_document_input = ${operandText(ctx, operation.receiver)}; ` +
    `const auto& gea_document_key_input = ${operandText(ctx, operation.key)}; const gea::PropertyKey gea_document_key = ${property}; `
  if (operation.kind === 'get') {
    const target = cppTypeOf(operation.result.representation)
    return (
      `([&]() -> ${target} { ${bind}` +
      withFieldReceiver(
        operation.receiver.representation,
        'gea_document_input',
        () =>
          `std::optional<${target}> gea_document_answer; ` +
          `gea::NativeFieldRead gea_document_read(gea_document_answer, ` +
          `+[](void* gea_out, const void* gea_type, const void* gea_policy, const void* gea_native) -> bool { ` +
          `if (gea_type != gea::detail::payloadTypeTagFor<gea::Value>() || gea_policy != gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>()) return false; ` +
          `static_cast<std::optional<${target}>*>(gea_out)->emplace(${converted}); return true; }, ` +
          `+[](const void* gea_type, const void* gea_policy) -> bool { return gea_type == gea::detail::payloadTypeTagFor<gea::Value>() && ` +
          `gea_policy == gea::detail::payloadTypeTagFor<gea::NativeFieldLeafPolicy>(); }); ` +
          `if (!${receipt.arrayEntry === undefined ? 'gea::record::readDocumentEntryView(gea::Ref<void>(gea_field_receiver)' : 'gea::dictionary::readDocumentArrayEntry(gea_field_receiver'}, gea_document_key, gea_document_read) || !gea_document_answer) ` +
          `gea::host::throwRuntimeError("TypeError", "A Document entry has no selected result"); return std::move(*gea_document_answer); `,
        (_carrier, text) => `return ${dynamicEntry(`${text}.getProperty(gea_document_key)`)};`
      ) +
      '})()'
    )
  }
  return (
    `([&]() -> bool { ${bind}const ${cppTypeOf(operation.value.representation)} gea_document_written = ${operandText(ctx, operation.value)}; ` +
    withFieldReceiver(
      operation.receiver.representation,
      'gea_document_input',
      () =>
        `const gea::Value gea_document_value = ${converted}; ` +
        `return gea::record::writeDocumentEntryView(gea::Ref<void>(gea_field_receiver), gea_document_key, gea::NativeFieldWrite::exact(gea_document_value)); `
    ) +
    '})()'
  )
}
