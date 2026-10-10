import type { NativeUnboundMethodContract } from '../../conversion/native-method.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import type { FunctionId } from '../../identity/ids.js'
import type { GetOperation } from '../../ir/model.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { nativeLogicalReceiverProtocolOf, type NativeLogicalReceiverProtocol } from '../../representation/native-logical-receiver.js'
import { createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { cppTypeOf } from './types.js'
import { operationConversionText } from './emit-certified-conversion.js'
import type { IrOperationBase } from '../../ir/model.js'

/** A receiver remains native while its logical undefined/null states survive the erased invocation entry. */
export const nativeCallReceiverText = (
  representation: Representation,
  text: string,
  materialize?: (source: Representation, value: string) => string | null
): string => nativeReceiverProtocolText(nativeLogicalReceiverProtocolOf(representation), text, materialize)

/** The operation names every possible callable payload boundary, including
 * wrapper arms; the callback is executed only by an actual declared-any body.
 */
export const operationNativeCallReceiverText = (
  ctx: EmitContext,
  operation: IrOperationBase,
  representation: Representation,
  text: string
): string =>
  nativeCallReceiverText(representation, text, (source, value) =>
    operationConversionText(ctx, operation, 'logical-receiver', source, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, value)
  )

const nativeReceiverProtocolText = (
  protocol: NativeLogicalReceiverProtocol,
  text: string,
  materialize?: (source: Representation, value: string) => string | null
): string => {
  switch (protocol.kind) {
    case 'reference':
      return `gea::NativeCallReceiver::object(${text})`
    case 'undefined':
    case 'null':
      return `gea::NativeCallReceiver::${protocol.kind}()`
    case 'dynamic':
      return `gea::NativeCallReceiver::fromValue(${text})`
    case 'primitive':
      return `gea::NativeCallReceiver::primitive(${protocol.number ? `static_cast<double>(${text})` : protocol.string ? `std::string(${text})` : text})`
    case 'callable': {
      const value = materialize?.(protocol.representation, 'gea_receiver_source') ?? null
      if (value === null)
        throw createCppEmitBlockedError('call-abi:logical-receiver', 'a native Function receiver has no certified ABI materializer')
      return `gea::NativeCallReceiver::primitive(${text}, +[](const ${cppTypeOf(protocol.representation)}& gea_receiver_source) -> gea::Value { return ${value}; })`
    }
    case 'optional':
      return `(${text}.has_value() ? ${nativeReceiverProtocolText(protocol.payload, `(*${text})`, materialize)} : gea::NativeCallReceiver::${protocol.absence}())`
    case 'union': {
      const branches = protocol.arms.map(
        (arm, index) =>
          `if (gea_receiver.template is<${index}>()) return ${nativeReceiverProtocolText(arm, `gea_receiver.template get<${index}>()`, materialize)};`
      )
      return (
        `[](const auto& gea_receiver) -> gea::NativeCallReceiver { ${branches.join(' ')} ` +
        `gea::detail::refuseTaggedUnionArmMismatch("a native call receiver naming no arm"); }(${text})`
      )
    }
    case 'unsupported':
      return 'gea::NativeCallReceiver::other()'
  }
}

/** The body receiver stays on a second native entry; the public finite frame remains the one certification approved. */
export const nativeUnboundMethodText = (
  contract: NativeUnboundMethodContract,
  sourceText: string,
  render?: (node: ConversionNode, text: string) => string | null
): string => {
  const child = (node: ConversionNode | undefined, text: string): string => {
    if (node === undefined) return text
    const adapted = render?.(node, text) ?? null
    if (adapted === null)
      throw createCppEmitBlockedError(`conversion:${node.id}`, 'a native method frame names no admitted certified adaptation')
    return adapted
  }
  const source = child(contract.frameAdaptation, sourceText)
  const target = cppTypeOf({ kind: 'function-value-dispatch', abi: { ...contract.target, receiver: null } })
  const published = (text: string): string => child(contract.publicAdaptation, text)
  if (contract.receiverRequirement === 'present-native-brand') {
    const receiver = cppTypeOf(contract.receiver)
    const resolver =
      `[](const gea::NativeCallReceiver& gea_receiver) -> ${receiver} { if (!gea_receiver.is<typename ${receiver}::element_type>()) ` +
      `gea::host::throwRuntimeError("TypeError", "a buffer slice method requires its native buffer receiver"); return gea_receiver.as<typename ${receiver}::element_type>(); }`
    return published(`${target}::unboundMethodAs<${receiver}>(${source}, ${resolver})`)
  }
  if (contract.receiver.kind === 'dynamic')
    return published(
      `${target}::unboundMethodAs<gea::Value>(${source}, ` +
        '[](const gea::NativeCallReceiver& gea_receiver) -> gea::Value { return gea_receiver.dynamicValue(); })'
    )
  if (contract.receiver.kind !== 'tagged-union') return published(`${target}::unboundMethod(${source})`)
  const receiver = contract.receiver
  const receiverType = cppTypeOf(receiver)
  const arms = receiver.arms.map((arm, index) => {
    const armType = cppTypeOf(arm.value)
    return `if (gea_receiver.is<typename ${armType}::element_type>()) return ${receiverType}::ofArm<${index}>(gea_receiver.as<typename ${armType}::element_type>());`
  })
  const absenceArm = cppTypeOf(receiver.arms[0]!.value)
  const resolver =
    `[](const gea::NativeCallReceiver& gea_receiver) -> ${receiverType} { ` +
    `if (gea_receiver.kind == gea::NativeCallReceiver::Kind::Undefined) return ${receiverType}::ofArm<0>(${absenceArm}::undefined()); ` +
    `if (gea_receiver.kind == gea::NativeCallReceiver::Kind::Null) return ${receiverType}::ofArm<0>(${absenceArm}()); ` +
    `${arms.join(' ')} gea::host::throwRuntimeError("TypeError", "a native method receiver is outside its authenticated class family"); }`
  return published(`${target}::unboundMethodAs<${receiverType}>(${source}, ${resolver})`)
}

export const nativeMethodValueRecipeText = (
  ctx: EmitContext,
  operation: GetOperation,
  key: string,
  source: Representation,
  target: Representation,
  text: string,
  origin: 'prototype' | 'own',
  callable: FunctionId | null
): string | null => {
  const recipe = operation.methodValueRecipes?.find(
    (candidate) =>
      candidate.key === key &&
      candidate.origin === origin &&
      candidate.callable === callable &&
      representationKey(candidate.source) === representationKey(source) &&
      representationKey(candidate.target) === representationKey(target)
  )
  if (recipe === undefined) return null
  const node = ctx.conversions.nodeById(recipe.conversion)
  if (node === null || (ctx.conversionIsCertified !== undefined && !ctx.conversionIsCertified(node.id)))
    throw createCppEmitBlockedError(`conversion:${recipe.conversion}`, 'a native method read names no certified conversion node')
  return recipeText(ctx, node, text)
}
