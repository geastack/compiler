import type { ConversionNodeId } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { nativeSumPlan } from '../conversion/native-sum.js'
import { nativeTotalSelectionStepOf } from '../conversion/native-selection.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { MergeLiveArmRebuildOperation } from './model.js'

export interface NativeMergeTransport {
  readonly source: string
  readonly target: string
  readonly arms: readonly { readonly index: number; readonly conversion: ConversionNodeId }[]
  readonly absence?: ConversionNodeId
}

/**
 * Select only total native steps; branch admission and the live-arm set remain
 * lowering's facts. A live arm may land in a bare (non-sum) target too:
 * `undefined | null | X` merged to `X` keeps `X` by identity and stores `null`
 * as the empty shared handle -- the selection planner's own `null -> Ref`
 * step, which the sum planner cannot state for a target that is not a sum.
 */
export const nativeMergeTransportOf = (
  source: Representation,
  target: Representation,
  liveArms: readonly number[],
  sourceAbsenceLive: boolean,
  conversions: ConversionCensus
): NativeMergeTransport | undefined => {
  const payload = source.kind === 'optional' ? source.payload : source
  if (payload.kind !== 'tagged-union' || liveArms.length === 0) return undefined
  const carried = (from: Representation): boolean =>
    nativeSumPlan(from, target) !== null || nativeTotalSelectionStepOf(from, target) !== null
  const sources = liveArms.map((index) => payload.arms[index]?.value)
  if (sources.some((arm) => !arm || !carried(arm))) return undefined
  const absence = source.kind === 'optional' && sourceAbsenceLive ? ({ kind: source.absence } as const) : null
  if (absence && !carried(absence)) return undefined
  return {
    source: representationKey(source),
    target: representationKey(target),
    arms: liveArms.map((index) => ({ index, conversion: conversions.nodeFor(payload.arms[index]!.value, target).id })),
    ...(absence ? { absence: conversions.nodeFor(absence, target).id } : {})
  }
}

/** Validate the exact citations before certification or reflection can consume this contract. */
export const nativeMergeTransportMatches = (
  operation: MergeLiveArmRebuildOperation,
  conversions: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  const recipe = operation.nativeTransport
  const source = operation.source.representation
  const payload = source.kind === 'optional' ? source.payload : source
  if (
    !recipe ||
    payload.kind !== 'tagged-union' ||
    recipe.source !== representationKey(source) ||
    recipe.target !== representationKey(operation.result.representation) ||
    recipe.arms.length === 0 ||
    recipe.arms.length !== operation.liveArms.length
  )
    return false
  const matches = (id: ConversionNodeId, from: Representation): boolean => {
    const node = conversions.nodeById(id)
    if (!node || representationKey(node.source) !== representationKey(from) || representationKey(node.target) !== recipe.target)
      return false
    const capability = node.capability
    return (
      capability.kind === 'identity' ||
      ((capability.kind === 'atom' || capability.kind === 'static' || capability.kind === 'class-family') &&
        capability.materializer.nativeFieldProtocol === 'unused')
    )
  }
  if (
    !recipe.arms.every(
      (arm, ordinal) =>
        arm.index === operation.liveArms[ordinal] &&
        payload.arms[arm.index] !== undefined &&
        matches(arm.conversion, payload.arms[arm.index]!.value)
    )
  )
    return false
  const needsAbsence = source.kind === 'optional' && operation.sourceAbsenceLive
  return needsAbsence ? recipe.absence !== undefined && matches(recipe.absence, { kind: source.absence }) : recipe.absence === undefined
}

/** Avoiding reflection is weaker than retaining object identity: consume the actual selected payload proofs as well. */
export const nativeMergePayloadTransportMatches = (
  operation: MergeLiveArmRebuildOperation,
  conversions: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  if (!nativeMergeTransportMatches(operation, conversions)) return false
  const recipe = operation.nativeTransport!
  const source = operation.source.representation
  const payload = source.kind === 'optional' ? source.payload : source
  if (payload.kind !== 'tagged-union') return false
  const target = operation.result.representation
  return (
    recipe.arms.every((arm) =>
      nativePayloadTransportMatches(payload.arms[arm.index]!.value, target, conversions.nodeById(arm.conversion))
    ) &&
    (recipe.absence === undefined ||
      (source.kind === 'optional' && nativePayloadTransportMatches({ kind: source.absence }, target, conversions.nodeById(recipe.absence))))
  )
}
