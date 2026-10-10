import { isMaterializable } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { isBooleanShapedMergeTarget, partialDeadMergeArms, representationKey, type Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { operandOf } from '../semantics/model/operands.js'
import type { IrBody, IrOperation, MergeLiveArmRebuildOperation } from './model.js'
import type { IrValueId } from '../identity/ids.js'

export interface MergeConversionPlan {
  readonly source: string
  readonly target: string
  readonly arms: readonly { readonly index: number; readonly mode: 'value' | 'truthiness'; readonly conversion: string }[]
  readonly absence?: string
}

const boolean: Representation = { kind: 'scalar', domain: 'boolean' }

const sourceMatchesLeft = (
  operation: MergeLiveArmRebuildOperation,
  semantic: SemanticOperation,
  definitionOf: ((value: IrValueId) => IrOperation | null) | undefined,
  body: Pick<IrBody, 'sourceOwner'> | undefined
): boolean => {
  const left = operandOf(semantic, 'left')?.source
  if (left === undefined || definitionOf === undefined) return false
  const seen = new Set<IrValueId>()
  let value = operation.source.value
  while (!seen.has(value)) {
    seen.add(value)
    const producer = definitionOf(value)
    if (producer === null || !('result' in producer) || producer.result?.id !== value) return false
    if (left.kind === 'result' && producer.lineage === left.result) return true
    if (semantic.caller.kind === 'function' && body?.sourceOwner === semantic.caller.functionId) {
      if (left.kind === 'parameter' && producer.kind === 'parameter' && producer.ordinal === left.ordinal) return true
      if (left.kind === 'receiver' && producer.kind === 'receiver') return true
    }
    if (producer.kind !== 'convert') return false
    value = producer.source.value
  }
  return false
}

/** Only the kept, falsy contribution of this exact && split may become its truthiness. */
const truthinessLicensed = (
  operation: MergeLiveArmRebuildOperation,
  semantic: SemanticOperation | null,
  definitionOf: ((value: IrValueId) => IrOperation | null) | undefined,
  body: Pick<IrBody, 'sourceOwner'> | undefined
): boolean => {
  if (
    semantic?.family !== 'computation' ||
    semantic.form !== 'logical' ||
    semantic.operator !== '&&' ||
    !semantic.results.some((result) => result.id === operation.lineage) ||
    !sourceMatchesLeft(operation, semantic, definitionOf, body)
  )
    return false
  const split = partialDeadMergeArms(operation.source.representation)
  return (
    split !== null &&
    split.keptIsOptional === operation.sourceAbsenceLive &&
    split.liveIndices.length === operation.liveArms.length &&
    split.liveIndices.every((index, ordinal) => index === operation.liveArms[ordinal]) &&
    isBooleanShapedMergeTarget(operation.result.representation)
  )
}

/** Finalized SSA homes select each arm's recipe before certification; no printer fallback is a recipe. */
export const mergeConversionPlanOf = (
  operation: MergeLiveArmRebuildOperation,
  semantic: SemanticOperation | null,
  conversions: Pick<ConversionCensus, 'nodeFor'>,
  definitionOf?: (value: IrValueId) => IrOperation | null,
  body?: Pick<IrBody, 'sourceOwner'>
): MergeConversionPlan | undefined => {
  const source = operation.source.representation
  const payload = source.kind === 'optional' ? source.payload : source
  if (
    payload.kind !== 'tagged-union' ||
    (operation.sourceAbsenceLive && source.kind !== 'optional') ||
    operation.liveArms.length === 0 ||
    operation.liveArms.some((index, ordinal) => index < 0 || index <= (operation.liveArms[ordinal - 1] ?? -1) || !payload.arms[index])
  )
    return undefined
  const target = operation.result.representation
  const allowsTruthiness = truthinessLicensed(operation, semantic, definitionOf, body)
  const arms: MergeConversionPlan['arms'][number][] = []
  for (const index of operation.liveArms) {
    const arm = payload.arms[index]!
    const ordinary = conversions.nodeFor(arm.value, target)
    if (isMaterializable(ordinary.capability)) arms.push({ index, mode: 'value', conversion: ordinary.id })
    else {
      if (!allowsTruthiness) return undefined
      const wrapped = conversions.nodeFor(boolean, target)
      if (!isMaterializable(wrapped.capability)) return undefined
      arms.push({ index, mode: 'truthiness', conversion: wrapped.id })
    }
  }
  const absent = source.kind === 'optional' && operation.sourceAbsenceLive ? conversions.nodeFor({ kind: source.absence }, target) : null
  if (absent !== null && !isMaterializable(absent.capability)) return undefined
  return {
    source: representationKey(source),
    target: representationKey(target),
    arms,
    ...(absent === null ? {} : { absence: absent.id })
  }
}

/** Recompute modes and exact canonical citations from the authenticated invocation and final carriers. */
export const mergeConversionPlanMatches = (
  operation: MergeLiveArmRebuildOperation,
  semantic: SemanticOperation | null,
  conversions: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>,
  definitionOf?: (value: IrValueId) => IrOperation | null,
  body?: Pick<IrBody, 'sourceOwner'>
): boolean => {
  const expected = mergeConversionPlanOf(operation, semantic, conversions, definitionOf, body)
  const actual = operation.mergeConversionPlan
  return (
    expected !== undefined &&
    actual !== undefined &&
    expected.source === actual.source &&
    expected.target === actual.target &&
    expected.absence === actual.absence &&
    expected.arms.length === actual.arms.length &&
    expected.arms.every((arm, ordinal) => {
      const published = actual.arms[ordinal]
      if (published?.index !== arm.index || published.mode !== arm.mode || published.conversion !== arm.conversion) return false
      const source = operation.source.representation
      const payload = source.kind === 'optional' ? source.payload : source
      if (payload.kind !== 'tagged-union') return false
      const from = arm.mode === 'truthiness' ? boolean : payload.arms[arm.index]!.value
      return conversions.nodeFor(from, operation.result.representation) === conversions.nodeById(arm.conversion)
    }) &&
    (expected.absence === undefined ||
      (operation.source.representation.kind === 'optional' &&
        conversions.nodeFor({ kind: operation.source.representation.absence }, operation.result.representation) ===
          conversions.nodeById(expected.absence)))
  )
}
