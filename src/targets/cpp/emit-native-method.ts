import type { NativeUnboundMethodContract } from '../../conversion/native-method.js'
import type { FunctionId } from '../../identity/ids.js'
import type { GetOperation } from '../../ir/model.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { cppTypeOf } from './types.js'

/** A receiver remains native while its logical undefined/null states survive the erased invocation entry. */
export const nativeCallReceiverText = (representation: Representation, text: string): string => {
  if (representation.kind === 'class-ref' && representation.ownership === 'shared-refcount')
    return `gea::NativeCallReceiver::object(${text})`
  if (representation.kind === 'undefined' || representation.kind === 'void') return 'gea::NativeCallReceiver::undefined()'
  if (representation.kind === 'null') return 'gea::NativeCallReceiver::null()'
  if (representation.kind === 'optional')
    return `(${text}.has_value() ? ${nativeCallReceiverText(representation.payload, `(*${text})`)} : gea::NativeCallReceiver::${representation.absence === 'null' ? 'null' : 'undefined'}())`
  if (representation.kind === 'tagged-union') {
    const branches = representation.arms.map(
      (arm, index) => `if (gea_receiver.is<${index}>()) return ${nativeCallReceiverText(arm.value, `gea_receiver.get<${index}>()`)};`
    )
    return (
      `[](const auto& gea_receiver) -> gea::NativeCallReceiver { ${branches.join(' ')} ` +
      `gea::detail::refuseTaggedUnionArmMismatch("a native call receiver naming no arm"); }(${text})`
    )
  }
  return 'gea::NativeCallReceiver::other()'
}

/** The body receiver stays on a second native entry; the public finite frame remains the one certification approved. */
export const nativeUnboundMethodText = (contract: NativeUnboundMethodContract, sourceText: string): string =>
  `${cppTypeOf({ kind: 'function-value-dispatch', abi: contract.target })}::unboundMethod(${sourceText})`

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
  if (node === null)
    throw createCppEmitBlockedError(`conversion:${recipe.conversion}`, 'a native method read names no certified conversion node')
  return recipeText(ctx, node, text)
}
