import type { ConversionCapability, ConversionNode, ConversionNodeResolver } from './algebra.js'
import type { RecordViewPlan, RecordViewSource } from './record-view.js'
import type { NativeFieldViewPlan } from './native-field-view.js'
import type { Representation } from '../representation/model.js'

export interface NativeViewOrigin {
  readonly source: RecordViewSource | Extract<Representation, { kind: 'dictionary' }>
  readonly target: NativeFieldViewPlan['target']
}

/** Native ownership edges selected by the admitted view recipes, including their sealed dependencies. */
export const nativeViewOriginsOf = (nodes: Iterable<ConversionNode>, resolve?: ConversionNodeResolver): readonly NativeViewOrigin[] => {
  const origins: NativeViewOrigin[] = []
  const seenPlans = new Set<RecordViewPlan>()
  const seenNodes = new Set<ConversionNode>()
  const seenCapabilities = new Set<ConversionCapability>()
  const visitPlan = (plan: RecordViewPlan): void => {
    if (seenPlans.has(plan)) return
    seenPlans.add(plan)
    switch (plan.kind) {
      case 'owned':
        return
      case 'optional':
      case 'assert':
        visitPlan(plan.payload)
        return
      case 'arm':
        if (plan.payload !== null) visitPlan(plan.payload)
        return
      case 'recast-union':
      case 'dispatch':
        for (const arm of plan.arms) if (typeof arm.via === 'object') visitPlan(arm.via)
        return
      case 'iterator-result':
        if (plan.yieldHome.payload !== null) visitPlan(plan.yieldHome.payload)
        if (plan.returnHome.payload !== null) visitPlan(plan.returnHome.payload)
        return
      case 'fields':
        if (
          plan.source.ownership === 'shared-refcount' &&
          plan.target.ownership === 'shared-refcount' &&
          (plan.target.kind === 'record' || plan.target.native === null)
        )
          origins.push({ source: plan.source, target: plan.target })
        for (const field of plan.fields) if (field.read.kind === 'view') visitPlan(field.read.plan)
    }
  }
  const visitCapability = (capability: ConversionCapability): void => {
    if (seenCapabilities.has(capability)) return
    seenCapabilities.add(capability)
    if ('materializer' in capability) {
      const materializer = capability.materializer
      for (const fields of materializer.documentRecordView?.nativeFields ?? [])
        origins.push({ source: fields.source, target: fields.target })
      if (materializer.nativeDescriptorSnapshot) {
        const fields = materializer.nativeDescriptorSnapshot.nativeFields
        origins.push({ source: fields.source, target: fields.target })
      }
      if (materializer.recordView) {
        visitPlan(materializer.recordView.view)
        for (const leaf of materializer.recordView.leaves.values()) visitNode(leaf)
      }
      for (const dependency of materializer.dependencies ?? []) visitNode(dependency)
      for (const field of materializer.recordToArray?.fields ?? []) visitNode(field.conversion)
    }
    switch (capability.kind) {
      case 'optional':
        visitCapability(capability.payload)
        return
      case 'product':
        for (const field of capability.fields) visitCapability(field.capability)
        return
      case 'sum':
        for (const arm of capability.arms) visitCapability(arm.capability)
        return
      case 'collection':
        visitCapability(capability.element)
        return
      case 'recursive-ref': {
        const node = resolve?.(capability.node)
        if (node) visitNode(node)
      }
    }
  }
  const visitNode = (node: ConversionNode): void => {
    if (seenNodes.has(node)) return
    seenNodes.add(node)
    visitCapability(node.capability)
  }
  for (const node of nodes) visitNode(node)
  return origins
}
