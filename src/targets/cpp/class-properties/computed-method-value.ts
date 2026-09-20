import type { GetOperation } from '../../../ir/model.js'
import type { ClassMethod } from '../../../projection/classes.js'
import type { Representation } from '../../../representation/model.js'
import { classMethodValueArmsOf } from '../../../projection/dispatch.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { cppClassName } from '../types.js'

/** Render the projected read-time selection using the native allocation header.
 * Each arm returns the ordinary method object, preserving its exact thunk and
 * environment even when Function.call later supplies a different receiver.
 */
export const computedOverriddenMethodValueText = (
  ctx: EmitContext,
  operation: GetOperation,
  key: string,
  materialize: (method: ClassMethod) => { readonly text: string; readonly type: string }
): { readonly text: string; readonly type: string } => {
  return overriddenMethodValueText(ctx, operation.receiver.representation, operandText(ctx, operation.receiver), key, materialize)
}

/** A tagged-union leaf uses the same allocation-selected method as a computed
 * read on a lone class; the static arm is not the allocation's exact class.
 */
export const overriddenMethodValueText = (
  ctx: EmitContext,
  receiver: Representation,
  receiverText: string,
  key: string,
  materialize: (method: ClassMethod) => { readonly text: string; readonly type: string }
): { readonly text: string; readonly type: string } => {
  const arms = receiver.kind === 'class-ref' ? classMethodValueArmsOf(ctx.classes, receiver.declaration, key) : null
  if (arms === null)
    throw createCppEmitBlockedError(
      'property-access:computed-class-method-virtual',
      `computed method "${key}" has no complete native prototype selection for this family`
    )
  const values = arms.map((arm) => ({ ...arm, ...materialize(arm.method) }))
  const type = values[0]!.type
  const branches = values.map(
    (arm) => `if (gea::host::hasNativeClassLayoutRef<${cppClassName(arm.allocation)}>(${receiverText})) return ${arm.text};`
  )
  return { type, text: `([&]() -> ${type} { ${branches.join(' ')} std::abort(); })()` }
}
