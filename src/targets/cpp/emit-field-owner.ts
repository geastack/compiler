import type { GetOperation } from '../../ir/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { recipeText } from './emit-narrowing.js'
import { cppClassName, cppRecordFieldName, cppRecordFieldPresenceName, cppTypeOf } from './types.js'

/** Print the class identities and conversion nodes certified on the read. */
export const nativeFieldOwnerReadText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const recipe = operation.nativeFieldOwnerRead
  if (!recipe) return null
  const render = (id: string, value: string): string => {
    const node = ctx.conversions.nodeById(id)
    const text = node ? recipeText(ctx, node, value) : null
    if (text === null) throw createCppEmitBlockedError(`conversion:${id}`, 'a certified native field-owner read has no conversion renderer')
    return text
  }
  const missing = render(recipe.missing, 'gea::Undefined{}')
  const arms = recipe.arms.map((arm) => {
    const type = cppClassName(arm.member.declaration)
    const value = `gea_field_owner->${cppRecordFieldName(recipe.key)}`
    const present = `gea_field_owner->${cppRecordFieldPresenceName(recipe.key)}`
    return (
      `if (gea::host::hasNativeClassLayoutRef<${type}>(gea_field_receiver)) { ` +
      `const auto gea_field_owner = gea::host::downcastClassRef<${type}>(gea_field_receiver); ` +
      `return ${present} ? ${render(arm.conversion, value)} : ${missing}; }`
    )
  })
  return (
    `([&]() -> ${cppTypeOf(operation.result.representation)} { const auto& gea_field_receiver = ${operandText(ctx, operation.receiver)}; ` +
    `${arms.join(' ')} return ${missing}; })()`
  )
}
