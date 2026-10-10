import type { NativeCallableDataSlot } from '../../ir/native-callable-data-slots.js'
import type { NativeCallableDataWrite } from '../../ir/native-callable-data-write.js'
import { operandText } from './emit-context.js'
import { namedConversionText } from './emit-narrowing.js'
import { createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'
import { cppUndefinedValue } from './types.js'
import type { GetOperation } from '../../ir/model.js'
import { propertyKeyText } from './emit-dynamic-properties.js'
import type { NativeCallablePrototype } from '../../ir/native-callable-prototype.js'

export const nativeCallablePrototypeReadText = (ctx: EmitContext, receipt: NativeCallablePrototype): string => {
  if (receipt.materialization === null)
    throw createCppEmitBlockedError('property-access:function:get:native-prototype', 'a native prototype read lacks its exact observation')
  const node = ctx.conversions.nodeById(receipt.materialization)
  const callback = node && namedConversionText(ctx, 'emit-native-callable-data.ts:prototype-backpointer', node, 'gea_constructor')
  if (!callback)
    throw createCppEmitBlockedError(`conversion:${receipt.materialization}`, 'a native backpointer lost its current entry recipe')
  return `gea::callableNativeOwnPrototypeGet(${operandText(ctx, receipt.receiver)}, +[](const ${cppTypeOf(receipt.receiver.representation)}& gea_constructor) -> gea::Value { return ${callback}; })`
}

export const nativeCallablePrototypeObservationText = (
  ctx: EmitContext,
  receipt: NativeCallablePrototype,
  receiver = operandText(ctx, receipt.receiver)
): string => {
  const node = receipt.materialization === null ? null : ctx.conversions.nodeById(receipt.materialization)
  const callback = node && namedConversionText(ctx, 'emit-native-callable-data.ts:erased-prototype-backpointer', node, 'gea_constructor')
  if (!callback)
    throw createCppEmitBlockedError(
      'call-abi:native-callable-prototype',
      'an erased native prototype lost its exact current-entry callback'
    )
  const constructor = `+[](const ${cppTypeOf(receipt.receiver.representation)}& gea_constructor) -> gea::Value { return ${callback}; }`
  const prototype = '+[](const gea::Ref<gea::DynamicObject>& gea_table) -> gea::Value { return gea::Value::fromDynamicObject(gea_table); }'
  return `gea::installCallableNativePrototype(${receiver}, ${constructor}, ${prototype})`
}

/** Presence belongs to the actual Function table, separately from the source
 * family's common native payload type. Neither missing data nor a mismatched
 * holder can be silently interpreted as a present payload.
 */
export const nativeCallableOptionalDataReadText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receipt = operation.nativeCallableDataSlot
  if (!receipt?.optionalRead && !receipt?.presentRead) return null
  const convert = (id: string, value: string): string => {
    const node = ctx.conversions.nodeById(id)
    if (!node) throw createCppEmitBlockedError(`conversion:${id}`, 'a native Function read lost its certified conversion')
    const result = namedConversionText(ctx, 'emit-native-callable-data.ts:optional-read', node, value)
    if (result === null)
      throw createCppEmitBlockedError(`conversion:${id}`, 'a native Function read cannot render its certified conversion')
    return result
  }
  if (receipt.presentRead) {
    const value = convert(receipt.presentRead.conversion, operandText(ctx, receipt.value))
    return (
      `([&]() -> ${cppTypeOf(operation.result.representation)} { ` +
      `(void)(${operandText(ctx, operation.receiver)}); (void)(${operandText(ctx, operation.key)}); return ${value}; })()`
    )
  }
  if (!receipt.optionalRead) return null
  const absent = convert(receipt.optionalRead.absent, cppUndefinedValue)
  const present = convert(receipt.optionalRead.present, '*gea_data_value')
  return (
    `([&]() -> ${cppTypeOf(operation.result.representation)} { const auto& gea_data_owner = ${operandText(ctx, operation.receiver)}; ` +
    `const gea::PropertyKey gea_data_key = ${propertyKeyText(ctx, operation.key, 'native Function optional data read')}; ` +
    'const auto& gea_data_identity = gea_data_owner.functionObjectIdentity(); ' +
    'if (!gea_data_identity) gea::host::throwRuntimeError("TypeError", "Cannot read a property of an absent Function"); ' +
    'gea::installCallableOwnFacts(gea_data_identity, gea_data_owner.name(), gea_data_owner.length()); ' +
    `if (!gea_data_identity->properties->ownProperty(gea_data_key)) return ${absent}; ` +
    `const auto gea_data_value = gea_data_identity->properties->readNativeData<${cppTypeOf(receipt.storage)}>(gea_data_key); ` +
    'if (!gea_data_value) gea::detail::refusePayloadMismatch("an authenticated native Function data slot changed its carrier"); ' +
    `return ${present}; })()`
  )
}

/** A native holder has no implicit Value materializer. The only callback in
 * this slice is an exact primitive recipe demanded by an actual dynamic read.
 */
export const nativeCallableDataMaterializerText = (ctx: EmitContext, receipt: NativeCallableDataSlot): string => {
  if (receipt.materialization === null) return ''
  const node = ctx.conversions.nodeById(receipt.materialization)
  if (!node)
    throw createCppEmitBlockedError(
      `conversion:${receipt.materialization}`,
      'a native Function data materializer lost its certified recipe'
    )
  const text = namedConversionText(ctx, 'emit-native-callable-data.ts:primitive-observation', node, 'gea_data')
  if (text === null)
    throw createCppEmitBlockedError(
      `conversion:${receipt.materialization}`,
      'a native Function data materializer cannot render its exact primitive boundary'
    )
  return `, +[](const ${cppTypeOf(receipt.storage)}& gea_data) -> gea::Value { return ${text}; }`
}

/** The descriptor engine requests these Value boundaries only for an actual
 * dynamic getter/setter observation. Installing the holder executes neither.
 */
export const nativeCallableDataWriteText = (ctx: EmitContext, receipt: NativeCallableDataWrite, property: string): string => {
  const materialize = (conversion: string, name: string): string => {
    const node = ctx.conversions.nodeById(conversion)
    if (!node) throw createCppEmitBlockedError(`conversion:${conversion}`, 'a native Function writer lost its certified boundary')
    const text = namedConversionText(ctx, 'emit-native-callable-data.ts:descriptor-boundary', node, name)
    if (text === null) throw createCppEmitBlockedError(`conversion:${conversion}`, 'a native Function writer has no boundary renderer')
    return text
  }
  const owner = operandText(ctx, receipt.receiver)
  const receiverCallback =
    receipt.receiverMaterialization === null
      ? 'nullptr'
      : `+[](const ${cppTypeOf(receipt.receiver.representation)}& gea_owner) -> gea::Value { return ${materialize(receipt.receiverMaterialization, 'gea_owner')}; }`
  const receiver = `gea::NativeCallReceiver::primitive<${cppTypeOf(receipt.receiver.representation)}>(gea_data_owner, ${receiverCallback})`
  const payload =
    receipt.materialization === null
      ? 'nullptr'
      : `+[](const ${cppTypeOf(receipt.storage)}& gea_data) -> gea::Value { return ${materialize(receipt.materialization, 'gea_data')}; }`
  const stored = materialize(receipt.storageConversion, operandText(ctx, receipt.storedValue))
  return (
    `([&]() -> bool { const auto& gea_data_owner = ${owner}; const gea::PropertyKey gea_data_key = ${property}; ` +
    `const ${cppTypeOf(receipt.storage)} gea_data_value = ${stored}; ` +
    `return gea::${receipt.prototypeProtocol === 'own-table' ? 'callableNativeDataSetOverStockChain' : 'callableNativeDataSetWithReceiver'}<${nativeFieldPolicyType(receipt.storage)}>(gea_data_owner, gea_data_key, gea_data_value, ${payload}, ${receiver}); })()`
  )
}

/** A data definition's holder: the literal descriptor's own `value` field,
 * kept native in the descriptor with the exact dynamic-observation callback. */
export const nativeCallableDataDefinitionValueText = (ctx: EmitContext, receipt: NativeCallableDataWrite, read: string): string => {
  const render = (conversion: string, name: string): string => {
    const node = ctx.conversions.nodeById(conversion)
    const text = node && namedConversionText(ctx, 'emit-native-callable-data.ts:definition-boundary', node, name)
    if (!text) throw createCppEmitBlockedError(`conversion:${conversion}`, 'a native Function definition lost its certified boundary')
    return text
  }
  const held = cppTypeOf(receipt.storage)
  const payload =
    receipt.materialization === null
      ? 'nullptr'
      : `+[](const ${held}& gea_data) -> gea::Value { return ${render(receipt.materialization, 'gea_data')}; }`
  return `gea::NativeDescriptorData::make<${held}, ${nativeFieldPolicyType(receipt.storage)}>(${held}(${render(receipt.storageConversion, read)}), ${payload})`
}
