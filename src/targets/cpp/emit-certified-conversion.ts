import { conversionNodeIdOf } from '../../conversion/nodes.js'
import type { IrOperationBase } from '../../ir/model.js'
import type { OperationConversionRole } from '../../ir/operation-conversions.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError } from './emit-context.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'

const rendersCertifiedNode = (
  ctx: ConversionSite,
  nodeId: string,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const node = ctx.conversions.nodeById(nodeId)
  if (
    node === null ||
    representationKey(node.source) !== representationKey(source) ||
    representationKey(node.target) !== representationKey(target) ||
    (ctx.conversionIsCertified !== undefined && !ctx.conversionIsCertified(nodeId))
  )
    throw createCppEmitBlockedError(`conversion:${nodeId}`, 'the internal value conversion has no matching citation in the certified IR')
  return recipeText(ctx, node, text)
}

/** Nested helpers may render only an exact conversion already demanded by IR. */
export const certifiedConversionText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null =>
  representationKey(source) === representationKey(target)
    ? text
    : rendersCertifiedNode(ctx, conversionNodeIdOf(source, target), source, target, text)

export const operationConversionText = (
  ctx: ConversionSite,
  operation: IrOperationBase,
  role: OperationConversionRole,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  if (representationKey(source) === representationKey(target)) return text
  const conversion = operation.conversionRecipes?.find(
    (value) =>
      value.role === role &&
      representationKey(value.source) === representationKey(source) &&
      representationKey(value.target) === representationKey(target)
  )
  if (!conversion)
    throw createCppEmitBlockedError(
      `conversion:${conversionNodeIdOf(source, target)}`,
      `the operation published no ${role} conversion for its internal value`
    )
  return rendersCertifiedNode(ctx, conversion.conversion, source, target, text)
}
