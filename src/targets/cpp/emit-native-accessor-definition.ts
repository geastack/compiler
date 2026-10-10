import type { NativeAccessorHalfRecipe, NativeAccessorObservationRecipe } from '../../ir/native-accessor-definition.js'
import { representationKey } from '../../representation/model.js'
import { createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { nativeFieldPolicyType } from './records.js'
import { cppTypeOf } from './types.js'

/** The holder retains the original Function. Its callback applies only the
 * certified future accessor frame, forwarding the receiver of this access.
 */
export const nativeAccessorDefinitionText = (ctx: EmitContext, half: NativeAccessorHalfRecipe, sourceText: string): string => {
  const node = ctx.conversions.nodeById(half.conversion)
  const invoked =
    node === null ||
    representationKey(node.source) !== representationKey(half.source) ||
    representationKey(node.target) !== representationKey(half.call)
      ? null
      : recipeText(ctx, node, '*gea_source')
  if (invoked === null)
    throw createCppEmitBlockedError(`conversion:${half.conversion}`, 'a native accessor lacks its certified invocation frame')
  // A typed half met by a dynamic [[Get]]/[[Set]] crosses that boundary
  // through its own published frame, never a boxed copy of the Function.
  const observeNode = half.observe === null ? null : ctx.conversions.nodeById(half.observe)
  const observeText = (text: string): string => {
    const typed = half.half === 'get' ? half.read : half.write
    const converted =
      observeNode === null ||
      typed === null ||
      representationKey(half.half === 'get' ? observeNode.source : observeNode.target) !== representationKey(typed) ||
      (half.half === 'get' ? observeNode.target : observeNode.source).kind !== 'dynamic'
        ? null
        : recipeText(ctx, observeNode, text)
    if (converted === null)
      throw createCppEmitBlockedError(`conversion:${half.observe}`, 'a native accessor lacks its certified dynamic frame')
    return converted
  }
  const source = cppTypeOf(half.source)
  const entry = `const auto* gea_source = gea_function.template get<${source}>(); if (gea_source == nullptr) return false; `
  let read = 'nullptr'
  let write = 'nullptr'
  let dynamicRead = 'nullptr'
  let dynamicWrite = 'nullptr'
  if (half.half === 'get') {
    if (half.read === null) throw createCppEmitBlockedError(`conversion:${half.conversion}`, 'a native getter has no exact result carrier')
    const policy = nativeFieldPolicyType(half.read)
    const result = cppTypeOf(half.read)
    const call = `(${invoked}).callWithReceiver(gea_receiver)`
    const value =
      half.call.kind === 'function-value-dispatch' && half.call.abi.result.kind === 'void' ? `((void)(${call}), gea::Undefined{})` : call
    read =
      '+[](const gea::NativeDescriptorData& gea_function, const gea::NativeCallReceiver& gea_receiver, ' +
      `const gea::NativeFieldRead& gea_answer) -> bool { if (!gea_answer.template acceptsExact<${result}, ${policy}>()) return false; ` +
      `${entry}return gea_answer.template assign<${policy}>(${value}); }`
    if (half.read.kind === 'dynamic' || half.observe !== null)
      dynamicRead =
        '+[](const gea::NativeDescriptorData& gea_function, const gea::NativeCallReceiver& gea_receiver) -> gea::Value { ' +
        `const auto* gea_source = gea_function.template get<${source}>(); if (gea_source == nullptr) gea::host::throwRuntimeError("TypeError", "A native getter lost its source Function"); return ${half.read.kind === 'dynamic' ? call : observeText(call)}; }`
  } else {
    const parameter = half.write
    const incoming =
      parameter === null
        ? ''
        : `std::optional<${cppTypeOf(parameter)}> gea_written; if (!gea_value.template read<${nativeFieldPolicyType(parameter)}>(gea_written)) return false; `
    const argument = parameter === null ? '' : ', *gea_written'
    write =
      '+[](const gea::NativeDescriptorData& gea_function, const gea::NativeCallReceiver& gea_receiver, ' +
      `const gea::NativeFieldWrite& ${parameter === null ? '' : 'gea_value'}) -> bool { ${incoming}${entry}` +
      `(void)((${invoked}).callWithReceiver(gea_receiver${argument})); return true; }`
    if (parameter !== null && parameter.kind !== 'dynamic' && half.observe !== null)
      dynamicWrite =
        '+[](const gea::NativeDescriptorData& gea_function, const gea::NativeCallReceiver& gea_receiver, const gea::Value& gea_value) { ' +
        `const auto* gea_source = gea_function.template get<${source}>(); if (gea_source == nullptr) gea::host::throwRuntimeError("TypeError", "A native setter lost its source Function"); ` +
        `(void)((${invoked}).callWithReceiver(gea_receiver, ${observeText('gea_value')})); }`
    else if (parameter === null || parameter.kind === 'dynamic')
      dynamicWrite =
        '+[](const gea::NativeDescriptorData& gea_function, const gea::NativeCallReceiver& gea_receiver, const gea::Value& gea_value) { ' +
        `const auto* gea_source = gea_function.template get<${source}>(); if (gea_source == nullptr) gea::host::throwRuntimeError("TypeError", "A native setter lost its source Function"); ` +
        `(void)((${invoked}).callWithReceiver(gea_receiver${parameter === null ? '' : ', gea_value'})); }`
  }
  return `gea::NativeDescriptorAccessor::make(${sourceText}, ${read}, ${write}, nullptr, ${dynamicRead}, ${dynamicWrite})`
}

/** Reflection returns a view of the same Function object, not a fresh
 * wrapper whose identity or logical receiver differs from the installed half.
 */
export const nativeAccessorObservedFunctionText = (
  ctx: EmitContext,
  half: NativeAccessorObservationRecipe['halves'][number],
  descriptorText: string
): string => {
  const node = ctx.conversions.nodeById(half.conversion)
  const adapted =
    node === null ||
    representationKey(node.source) !== representationKey(half.source) ||
    representationKey(node.target) !== representationKey(half.target)
      ? null
      : recipeText(ctx, node, '*gea_source')
  if (adapted === null)
    throw createCppEmitBlockedError(`conversion:${half.conversion}`, 'a reflected native accessor lacks its original Function view recipe')
  const native = half.half === 'get' ? 'nativeGet' : 'nativeSet'
  return (
    `([&]() -> ${cppTypeOf(half.target)} { const auto* gea_source = (${descriptorText}).${native}.function.template get<${cppTypeOf(half.source)}>(); ` +
    'if (gea_source == nullptr) gea::host::throwRuntimeError("TypeError", "A native accessor observation lost its installed Function"); ' +
    `return ${adapted}; })()`
  )
}
