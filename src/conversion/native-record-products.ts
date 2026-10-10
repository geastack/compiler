import type { ConversionNode } from './algebra.js'
import type { OwnedRecordPlan, RecordViewPlan, RecordViewSource, RecordViewTarget } from './record-view.js'
import { representationKey } from '../representation/model.js'
import { structuralConversionKey } from './structural-plan.js'

export interface NativeRecordProduct {
  readonly source: RecordViewSource
  readonly target: RecordViewTarget
  readonly fields: readonly { readonly key: string; readonly identity: boolean }[]
}

/** A sealed value-to-reference product creates a real native allocation. Its
 * public target alone cannot provide that provenance; live views retain their
 * original allocation instead and never enter this inventory.
 */
export const nativeRecordProductsOf = (node: ConversionNode | null | undefined): readonly NativeRecordProduct[] => {
  if (!node || !('materializer' in node.capability)) return []
  const certified = node.capability.materializer.recordView
  if (!certified) return []
  const found: NativeRecordProduct[] = []
  const owned = (plan: OwnedRecordPlan): void => {
    if (plan.kind === 'arm') owned(plan.payload)
    else if (plan.kind === 'record' && plan.source.ownership === 'owned' && plan.target.ownership === 'shared-refcount')
      found.push({
        source: plan.source,
        target: plan.target,
        fields: plan.fields.map((field) => ({ key: field.key, identity: field.value.kind === 'identity' }))
      })
  }
  const walk = (plan: RecordViewPlan): void => {
    switch (plan.kind) {
      case 'owned':
        owned(plan.plan)
        break
      case 'optional':
      case 'assert':
        walk(plan.payload)
        break
      case 'arm':
        if (plan.payload) walk(plan.payload)
        break
      case 'dispatch':
      case 'recast-union':
        for (const arm of plan.arms) if (typeof arm.via === 'object') walk(arm.via)
        break
      case 'fields':
        if (
          (plan.source.kind === 'record' || plan.source.kind === 'native-record-ref') &&
          plan.source.ownership === 'owned' &&
          plan.target.ownership === 'shared-refcount' &&
          plan.indexes.length === 0 &&
          !plan.expando &&
          (plan.spilled?.length ?? 0) === 0 &&
          (plan.expandoSpilled?.length ?? 0) === 0 &&
          plan.fields.every((field) => field.read.kind === 'held')
        )
          found.push({
            source: plan.source,
            target: plan.target,
            fields: plan.fields.map(({ field, read }) => {
              const leaf = read.kind === 'held' ? certified.leaves.get(structuralConversionKey(read.held.value, field.value)) : undefined
              return {
                key: field.key,
                identity:
                  read.kind === 'held' &&
                  leaf?.capability.kind === 'identity' &&
                  representationKey(leaf.source) === representationKey(read.held.value) &&
                  representationKey(leaf.target) === representationKey(field.value)
              }
            })
          })
        break
      case 'iterator-result':
        break
    }
  }
  walk(certified.view)
  return found
}
