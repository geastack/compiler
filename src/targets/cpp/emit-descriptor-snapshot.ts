import type { NativeDescriptorSnapshotPlan } from '../../conversion/native-descriptor-snapshot.js'
import { nativeDescriptorSnapshotPlanMatches } from '../../conversion/native-descriptor-snapshot.js'
import type { CallOperation } from '../../ir/model.js'
import { representationKey } from '../../representation/model.js'
import { propertyKeyText } from './emit-dynamic-properties.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'
import { createCppEmitBlockedError, type EmitContext } from './emit-context.js'
import { operandText } from './emit-context.js'
import { withFieldReceiver } from './emit-native-field-view.js'
import { cppRecordStructName, cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'

/** The copied descriptor is the immediate source. Allocating the public view
 * does not inspect its value, invoke a getter, or materialize a typed holder.
 */
export const nativeDescriptorSnapshotViewText = (ctx: ConversionSite, plan: NativeDescriptorSnapshotPlan, text: string): string | null => {
  if (!nativeDescriptorSnapshotPlanMatches(plan, ctx.conversions.nodeById)) return null
  const target = plan.target.payload
  if ((target.kind !== 'record' && target.kind !== 'native-record-ref') || target.ownership !== 'shared-refcount') return null
  const callback =
    '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key, const gea::NativeFieldRead& gea_read) -> bool { ' +
    `return gea::nativeDescriptorSnapshotRead(gea_immediate.staticCast<gea::NativeDescriptorSnapshot>(), gea_key, gea_read, ${plan.originalAny ? 'true' : 'false'}); }`
  const view = `gea::record::makeDescriptorSnapshotViewWithOrigin<${cppRecordStructName(target.shapeId)}>(*gea_snapshot, ${callback})`
  return (
    `([&](const ${cppTypeOf(plan.source)}& gea_snapshot) -> ${cppTypeOf(plan.target)} { ` +
    `if (!gea_snapshot.has_value()) return ${cppTypeOf(plan.target)}{}; return ${cppTypeOf(plan.target)}(${view}); })(${text})`
  )
}

export const nativeArrayDescriptorSnapshotText = (ctx: EmitContext, operation: CallOperation, receiver: string): string | null => {
  const receipt = operation.nativeArrayDescriptorSnapshot
  if (receipt === undefined) return null
  const node = ctx.conversions.nodeById(receipt.conversion)
  if (
    !node ||
    !operation.result ||
    representationKey(node.target) !== representationKey(operation.result.representation) ||
    !('materializer' in node.capability) ||
    !node.capability.materializer.nativeDescriptorSnapshot
  )
    throw createCppEmitBlockedError(
      'runtime-helper:native-array-descriptor-snapshot',
      'the captured native descriptor has no selected view recipe'
    )
  if (receipt.receiver.representation.kind !== 'array-object')
    throw createCppEmitBlockedError(
      'runtime-helper:native-array-descriptor-snapshot',
      'the capture has no authenticated native array carrier'
    )
  const snapshot = `gea::captureNativeArrayDescriptor(${receiver}, ${propertyKeyText(ctx, receipt.key, 'a native array descriptor snapshot')}, ${nativeFieldPolicyType(receipt.receiver.representation.element)}{})`
  // The runtime capture's std::optional is an artifact ABI, while the
  // selected source carrier uses the runtime's canonical absence sentinel.
  // Normalize once before the recipe; its present native handle stays owned.
  const carrier = cppTypeOf(node.source)
  const canonical =
    `([&]() -> ${carrier} { auto gea_snapshot_capture = ${snapshot}; ` +
    `if (!gea_snapshot_capture.has_value()) return ${carrier}{}; ` +
    `return ${carrier}(std::move(*gea_snapshot_capture)); })()`
  const result = recipeText(ctx, node, canonical)
  if (result === null) throw createCppEmitBlockedError(`conversion:${node.id}`, 'the native descriptor snapshot has no canonical renderer')
  return result
}

export const nativeDescriptorSnapshotDefinitionLines = (ctx: EmitContext, operation: CallOperation, slot: string): string | null => {
  const receipt = operation.nativeArrayDescriptorReinstallation
  if (!receipt) return null
  const read = withFieldReceiver(
    receipt.descriptor.representation,
    'gea_snapshot_input',
    () => 'return gea::record::nativeDescriptorSnapshotDefinitionFromView(gea_field_receiver);'
  )
  return (
    `const auto ${slot}_snapshot = ([&]() -> std::optional<gea::PropertyDescriptor> { ` +
    `const auto& gea_snapshot_input = ${operandText(ctx, receipt.descriptor)}; ${read} })(); ` +
    `if (!${slot}_snapshot.has_value()) gea::host::throwRuntimeError("TypeError", "Native descriptor snapshot changed before reinstallation"); ` +
    `const gea::PropertyDescriptor& ${slot} = *${slot}_snapshot;`
  )
}
