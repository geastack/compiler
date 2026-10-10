import type { RecordViewPlan, RecordViewSource, RecordViewTarget } from './record-view.js'
import type { Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { ConversionNode } from './algebra.js'
import { checkedPrimitiveFieldReadOf } from './checked-native-field-read.js'
import { structuralConversionKey, type CertifiedRecordViewPlan } from './structural-plan.js'
import { nativePayloadTransportMatches } from './native-payload-transport.js'

export interface NativeFieldViewRoute {
  readonly key: string
  readonly read: Representation
  readonly write: Representation | null
  /** Exact sealed reader selected by this view before delegation reaches original storage. */
  readonly checkedRead?: ConversionNode
  /** No carrier is published by this lazy descriptor-forwarding route. */
  readonly descriptorForward?: true
  /** Only an actual open Document supplies this declared-any entry boundary. */
  readonly declaredAnyEntry?: true
}

export interface NativeFieldViewPlan {
  readonly source: RecordViewSource | Extract<Representation, { kind: 'dictionary' }>
  readonly target: RecordViewTarget | Extract<Representation, { kind: 'record-with-index' }>
  readonly fields: readonly NativeFieldViewRoute[]
}

const primitiveSidecarField = (value: Representation): boolean =>
  value.kind === 'optional'
    ? primitiveSidecarField(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.every((arm) => primitiveSidecarField(arm.value))
      : ['scalar', 'string', 'symbol', 'null', 'undefined'].includes(value.kind)

/** Existing dynamic entries may accept dynamic or primitive values without boxing a typed object. */
export const nativeFieldViewDynamicValueIsNative = (value: Representation): boolean =>
  value.kind === 'dynamic' ||
  (value.kind === 'optional'
    ? nativeFieldViewDynamicValueIsNative(value.payload)
    : value.kind === 'tagged-union'
      ? value.arms.every((arm) => nativeFieldViewDynamicValueIsNative(arm.value))
      : primitiveSidecarField(value))

/** A shared view retains a descriptor route, rather than values read when it is created. */
export const nativeFieldViewPlanOf = (
  plan: Extract<RecordViewPlan, { kind: 'fields' }>,
  layouts: RecordLayoutPolicy,
  readConversionOf?: (source: Representation, target: Representation) => ConversionNode | null
): NativeFieldViewPlan | null => {
  if (plan.source.ownership !== 'shared-refcount' || plan.target.ownership !== 'shared-refcount') return null
  if (
    plan.indexes.length !== 0 ||
    plan.expando ||
    (plan.spilled?.length ?? 0) > 0 ||
    (plan.expandoSpilled?.length ?? 0) > 0 ||
    plan.fields.some(({ field, read }) => field.key.startsWith('sym(') || read.kind === 'absent' || read.kind === 'sidecar')
  )
    return null
  // A policy that cannot say whether a class accessor has a setter cannot say
  // the view is read-only either; a missing authority refuses the plan.
  const accessorSetterOf = layouts.classAccessorSetterFor
  if (accessorSetterOf === undefined && plan.source.kind === 'class-ref' && plan.fields.some(({ read }) => read.kind === 'class-accessor'))
    return null
  const fields = plan.fields.map(({ field, read }): NativeFieldViewRoute => {
    const route = (value: Representation, write: Representation | null): NativeFieldViewRoute => {
      const checked = readConversionOf?.(value, field.value)
      return { key: field.key, read: value, write, ...(checkedPrimitiveFieldReadOf(checked) ? { checkedRead: checked! } : {}) }
    }
    switch (read.kind) {
      case 'held':
      case 'view':
        return route(read.held.value, read.held.value)
      case 'class-accessor':
        return route(
          read.value,
          plan.source.kind === 'class-ref' && accessorSetterOf !== undefined ? accessorSetterOf(plan.source.declaration, field.key) : null
        )
      case 'record-accessor':
        return route(read.value, read.write)
      case 'bound-method':
      case 'method-value':
        return { key: field.key, read: field.value, write: null }
      case 'sidecar':
        throw new Error('a dynamic index read cannot publish native extension storage')
      case 'native-descriptor':
        return { key: field.key, read: field.value, write: null, descriptorForward: true }
      case 'absent':
        return { key: field.key, read: field.value, write: field.value }
    }
  })
  return { source: plan.source, target: plan.target, fields }
}

const planKeepsNativeIdentity = (certified: CertifiedRecordViewPlan | undefined, active: Set<CertifiedRecordViewPlan>): boolean => {
  if (certified === undefined || active.has(certified)) return false
  active.add(certified)
  const converted = (source: Representation, target: Representation): boolean => {
    const leaf = certified.leaves.get(structuralConversionKey(source, target))
    return (
      nativePayloadTransportMatches(source, target, leaf) ||
      (!!leaf &&
        structuralConversionKey(leaf.source, leaf.target) === structuralConversionKey(source, target) &&
        'materializer' in leaf.capability &&
        leaf.capability.materializer.nativeFieldViewProtocol === 'live' &&
        planKeepsNativeIdentity(leaf.capability.materializer.recordView, active))
    )
  }
  const follows = (view: RecordViewPlan): boolean => {
    switch (view.kind) {
      case 'fields':
        return certified.fieldViews?.has(view) === true
      case 'owned':
        return false
      case 'optional':
      case 'assert':
        return follows(view.payload)
      case 'arm':
        return view.payload === null
          ? view.target.arms[view.index] !== undefined && converted(view.source, view.target.arms[view.index]!.value)
          : follows(view.payload)
      case 'dispatch': {
        const target = view.target.kind === 'optional' ? view.target.payload : view.target
        return (
          view.arms.length === view.source.arms.length &&
          view.arms.every((arm, index) =>
            arm.via === 'convert'
              ? converted(view.source.arms[index]!.value, target)
              : arm.via === 'exact' || arm.via === 'absent' || follows(arm.via)
          )
        )
      }
      case 'recast-union':
        return (
          view.arms.length === view.source.arms.length &&
          view.arms.every((arm, index) => {
            const target = view.target.arms[arm.index]
            return (
              target !== undefined &&
              (arm.via === 'convert' ? converted(view.source.arms[index]!.value, target.value) : arm.via === 'exact' || follows(arm.via))
            )
          })
        )
      case 'iterator-result':
        return false
    }
  }
  const live = follows(certified.view)
  active.delete(certified)
  return live
}

/** Containers delegate identity only through the exact sealed child selected for each arm. */
export const nativeFieldViewPlanIsLive = (certified: CertifiedRecordViewPlan | undefined): boolean =>
  planKeepsNativeIdentity(certified, new Set())

export const nativeFieldViewIdentityTransportOf = (node: ConversionNode | null | undefined): boolean =>
  !!node &&
  'materializer' in node.capability &&
  node.capability.materializer.nativeFieldViewProtocol === 'live' &&
  (node.capability.materializer.documentRecordView !== undefined ||
    node.capability.materializer.nativeDescriptorSnapshot !== undefined ||
    nativeFieldViewPlanIsLive(node.capability.materializer.recordView))

/**
 * A live container view (an arm or a recast union) installs no descriptor of
 * its own: its arms delegate to the exact sealed child leaf, whose plan is the
 * reader actually behind the value.
 */
export const nativeFieldViewLiveLeavesOf = (nodes: Iterable<ConversionNode>): readonly ConversionNode[] => {
  const found = new Set<ConversionNode>()
  const visit = (node: ConversionNode): void => {
    if (found.has(node) || !nativeFieldViewIdentityTransportOf(node) || !('materializer' in node.capability)) return
    found.add(node)
    for (const leaf of node.capability.materializer.recordView?.leaves.values() ?? []) visit(leaf)
  }
  for (const node of nodes) visit(node)
  return [...found]
}

/** Ownership dependencies may contain ordinary views; only sealed live plans install field callbacks. */
export const nativeFieldViewPlansOf = (nodes: Iterable<ConversionNode>): readonly NativeFieldViewPlan[] => {
  const plans = new Set<NativeFieldViewPlan>()
  for (const node of nodes) {
    if (!nativeFieldViewIdentityTransportOf(node) || !('materializer' in node.capability)) continue
    for (const fields of node.capability.materializer.documentRecordView?.nativeFields ?? []) plans.add(fields)
    if (node.capability.materializer.nativeDescriptorSnapshot) plans.add(node.capability.materializer.nativeDescriptorSnapshot.nativeFields)
    for (const plan of node.capability.materializer.recordView?.fieldViews?.values() ?? []) plans.add(plan)
  }
  return [...plans]
}
