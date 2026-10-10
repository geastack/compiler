import type { GetOperation, SetOperation } from '../../ir/model.js'
import { representationKey } from '../../representation/model.js'
import { operandText, type EmitContext, createCppEmitBlockedError } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { cppStringLiteral, cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'
import type { NativeObjectDataSlot } from '../../ir/native-object-data-slots.js'
import { withFieldReceiver } from './emit-native-field-view.js'

const leaf = (ctx: EmitContext, id: string, text: string): string => {
  const node = ctx.conversions.nodeById(id)
  const rendered = node === null ? null : recipeText(ctx, node, text)
  if (rendered === null) throw createCppEmitBlockedError(`conversion:${id}`, 'a native object data slot lost its certified conversion')
  return rendered
}

const withOwnerText = (ctx: EmitContext, receipt: NativeObjectDataSlot, emit: (text: string) => string): string =>
  receipt.original === undefined
    ? emit(operandText(ctx, receipt.owner))
    : withFieldReceiver(receipt.owner.representation, 'gea_data_receiver', () =>
        emit(`gea::record::viewOriginClassRef<typename ${cppTypeOf(receipt.original!)}::element_type>(gea_field_receiver)`)
      )

const selectedKeyText = (receipt: NativeObjectDataSlot): string =>
  receipt.keyDomain === undefined ? `gea::PropertyKey::string(${cppStringLiteral(receipt.key)})` : 'gea::PropertyKey::string(gea_data_key)'

const keyCheckText = (receipt: NativeObjectDataSlot): string =>
  receipt.keyDomain === undefined
    ? ''
    : `if (!(${receipt.keyDomain.map((key) => `gea_data_key == ${cppStringLiteral(key)}`).join(' || ')})) ` +
      'gea::host::throwRuntimeError("TypeError", "a native object data key left its authenticated domain"); '

/** The observable receiver and key still evaluate once. The source allocation
 * is a retained SSA operand, not a reconstructed or boxed structural object.
 */
export const nativeObjectDataGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receipt = operation.nativeObjectDataSlot
  if (!receipt) return null
  const storage = cppTypeOf(receipt.storage)
  const result = cppTypeOf(operation.result.representation)
  const present = receipt.read.find((entry) => representationKey(entry.source) === representationKey(receipt.storage))
  const absent = receipt.read.find((entry) => entry.source.kind === 'undefined')
  if (!present) throw new Error('a native object data read has no storage recipe')
  const absence = absent
    ? `return ${leaf(ctx, absent.conversion, 'gea::Undefined{}')};`
    : 'gea::host::throwRuntimeError("TypeError", "an authenticated native object data property is absent");'
  return (
    `([&]() -> ${result} { ` +
    `const auto& gea_data_receiver = ${operandText(ctx, operation.receiver)}; ` +
    `const auto& gea_data_key = ${operandText(ctx, operation.key)}; (void)gea_data_receiver; (void)gea_data_key; ` +
    keyCheckText(receipt) +
    withOwnerText(
      ctx,
      receipt,
      (owner) =>
        `return gea::nativeObjectDataGet<${storage}, ${nativeFieldPolicyType(receipt.storage)}>` +
        `(${owner}, ${selectedKeyText(receipt)}, ` +
        `[&](const ${storage}& gea_stored) -> ${result} { return ${leaf(ctx, present.conversion, 'gea_stored')}; }, ` +
        `[&]() -> ${result} { ${absence} }); `
    ) +
    '})()'
  )
}

/** The descriptor engine calls this only for an accounted dynamic observer;
 * installing the holder never boxes the stored carrier. */
const materializerText = (ctx: EmitContext, receipt: NativeObjectDataSlot): string =>
  receipt.materialization === undefined
    ? ''
    : `, +[](const ${cppTypeOf(receipt.storage)}& gea_data) -> gea::Value { return ${leaf(ctx, receipt.materialization, 'gea_data')}; }`

export const nativeObjectDataSetText = (ctx: EmitContext, operation: SetOperation): string | null => {
  const receipt = operation.nativeObjectDataSlot
  if (!receipt?.write) return null
  return (
    '([&]() -> bool { ' +
    `const auto& gea_data_receiver = ${operandText(ctx, operation.receiver)}; ` +
    `const auto& gea_data_key = ${operandText(ctx, operation.key)}; ` +
    `const auto& gea_data_rhs = ${operandText(ctx, operation.value)}; ` +
    '(void)gea_data_receiver; (void)gea_data_key; (void)gea_data_rhs; ' +
    `const ${cppTypeOf(receipt.storage)} gea_data_stored = ${leaf(ctx, receipt.write.conversion, operandText(ctx, receipt.write.value))}; ` +
    keyCheckText(receipt) +
    withOwnerText(
      ctx,
      receipt,
      (owner) =>
        `return gea::nativeObjectDataSet<${nativeFieldPolicyType(receipt.storage)}>(${owner}, ${selectedKeyText(receipt)}, gea_data_stored${materializerText(ctx, receipt)}); `
    ) +
    '})()'
  )
}
