import type { ConversionNode, ConversionNodeResolver } from './algebra.js'
import { conversionRequiresSourceGuard } from './algebra.js'
import { dictionaryEntryReadIsLive, dictionaryEntryWriteIsTotal } from './dictionary-view.js'
import { nativeFieldViewIdentityTransportOf } from './native-field-view.js'
import { nativePayloadTransportMatches } from './native-payload-transport.js'
import { recipeClosureOf, recipeHasNormalResult, recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { dynamicWrapperPlanMatches } from './dynamic-wrapper.js'
import { nativeEntryWriterOf, type NativeEntryWriter } from './native-entry-writer.js'
import type { AcceptedConversion } from './structural-plan.js'
import { isOpenDocument, representationKey, type Representation } from '../representation/model.js'

type ArrayCarrier = Extract<Representation, { kind: 'array-object' }>
type OpenDocument = Extract<Representation, { kind: 'dictionary' }>

export type NativeArrayViewWriter = { readonly kind: 'conversion'; readonly conversion: ConversionNode } | NativeEntryWriter

/** The exact source storage survives the view. This plan is not an array copy
 * and cannot be selected until the runtime's live read/write protocol exists.
 */
export interface NativeArrayViewPlan {
  /** An open Document source is the Array it views, read through that object's own element protocol. */
  readonly source: ArrayCarrier | Extract<Representation, { kind: 'dynamic' }> | OpenDocument
  readonly storage: ArrayCarrier
  readonly target: ArrayCarrier
  readonly read: ConversionNode
  readonly write: NativeArrayViewWriter
  readonly sourceObservation?: ConversionNode
  readonly ownerObservation?: ConversionNode
  readonly dependencies: readonly ConversionNode[]
}

const exact = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  resolve: ConversionNodeResolver
): ConversionNode | null => {
  const node = accepted(source, target)
  return node !== null &&
    resolve(node.id) === node &&
    representationKey(node.source) === representationKey(source) &&
    representationKey(node.target) === representationKey(target)
    ? node
    : null
}

const liveRead = (node: ConversionNode, resolve: ConversionNodeResolver): boolean =>
  recipeHasNormalResult(node, resolve) &&
  recipeIsMaterializableWithoutPriorSourceGuard(node, resolve) &&
  (dictionaryEntryReadIsLive(node, resolve) ||
    nativePayloadTransportMatches(node.source, node.target, node) ||
    nativeFieldViewIdentityTransportOf(node))

const totalNativeWrite = (node: ConversionNode, resolve: ConversionNodeResolver): boolean =>
  recipeHasNormalResult(node, resolve) &&
  dictionaryEntryWriteIsTotal(node, resolve) &&
  ![...recipeClosureOf([node], resolve).values()].some((child) => conversionRequiresSourceGuard(child.capability, resolve))

/** A declared-any source entry needs a native holder for a typed replacement.
 * Its observation recipe is deferred until an actual dynamic reader demands
 * the value; it cannot be executed to obtain the property's storage payload.
 */
const arrayStorageViewPlanOf = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve: ConversionNodeResolver,
  identicalStorage: boolean
): NativeArrayViewPlan | null => {
  if (
    source.kind !== 'array-object' ||
    target.kind !== 'array-object' ||
    source.ownership !== 'shared-refcount' ||
    target.ownership !== 'shared-refcount' ||
    source.recursive !== undefined ||
    target.recursive !== undefined ||
    source.extension !== null ||
    target.extension !== null ||
    (!identicalStorage && representationKey(source.element) === representationKey(target.element))
  )
    return null
  const read = exact(source.element, target.element, readAccepted, resolve)
  if (!read || !liveRead(read, resolve)) return null
  if (source.element.kind === 'dynamic') {
    const write = nativeEntryWriterOf(target.element, source.element, accepted, resolve)
    if (!write) return null
    return {
      source,
      storage: source,
      target,
      read,
      write,
      dependencies: [read, write.stored, write.observation]
    }
  }
  const write = exact(target.element, source.element, accepted, resolve)
  if (!write || !totalNativeWrite(write, resolve) || !nativePayloadTransportMatches(target.element, source.element, write)) return null
  return { source, storage: source, target, read, write: { kind: 'conversion', conversion: write }, dependencies: [read, write] }
}

export const nativeArrayViewPlanOf = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null => arrayStorageViewPlanOf(source, target, accepted, readAccepted, resolve, false)

/** The checked runtime envelope accepts the exact target payload or its
 * installed Array<Value> storage. A different erased native array cannot
 * borrow this element reader or replacement writer.
 */
export const dynamicNativeArrayViewPlanOf = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null => {
  if (source.kind !== 'dynamic' || source.reason === 'untyped-callable') return null
  const storage: ArrayCarrier = { kind: 'array-object', element: source, ownership: 'shared-refcount', extension: null }
  const plan = arrayStorageViewPlanOf(storage, target, accepted, readAccepted, resolve, true)
  return plan === null ? null : { ...plan, source }
}

/** An open Document read as an Array is the Array it views, never a copy of
 * its entries: the runtime unwraps the aliased object and applies the same
 * checked envelope a boxed Array gets, so writes reach the original storage
 * whatever element carrier it was laid out with.
 */
export const documentNativeArrayViewPlanOf = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null => {
  if (!isOpenDocument(source) || source.kind !== 'dictionary' || source.recursive !== undefined) return null
  const plan = dynamicNativeArrayViewPlanOf(source.value, target, accepted, readAccepted, resolve)
  return plan === null ? null : { ...plan, source }
}

/** Every source carrier the checked runtime envelope reads as one boxed object. */
export const nativeArrayViewSourceIsBoxed = (source: Representation): boolean => source.kind === 'dynamic' || isOpenDocument(source)

/** The one selection of a base plan for a pair; certification replays the same one. */
export const nativeArrayViewBasePlanOf = (
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  readAccepted: AcceptedConversion,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null =>
  source.kind === 'dynamic'
    ? dynamicNativeArrayViewPlanOf(source, target, accepted, readAccepted, resolve)
    : isOpenDocument(source)
      ? documentNativeArrayViewPlanOf(source, target, accepted, readAccepted, resolve)
      : nativeArrayViewPlanOf(source, target, accepted, readAccepted, resolve)

/** Unknown element observation remains a separate, selected lazy boundary. */
export const nativeArrayViewWithObservation = (
  plan: NativeArrayViewPlan,
  observation: ConversionNode,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null => {
  if (
    resolve(observation.id) !== observation ||
    representationKey(observation.source) !== representationKey(plan.storage.element) ||
    observation.target.kind !== 'dynamic' ||
    observation.target.reason === 'untyped-callable' ||
    !totalNativeWrite(observation, resolve)
  )
    return null
  return {
    ...plan,
    sourceObservation: observation,
    dependencies: [...new Map([...plan.dependencies, observation].map((node) => [node.id, node])).values()]
  }
}

export const nativeArrayViewWithOwnerObservation = (
  plan: NativeArrayViewPlan,
  observation: ConversionNode,
  resolve: ConversionNodeResolver
): NativeArrayViewPlan | null => {
  if (
    resolve(observation.id) !== observation ||
    representationKey(observation.source) !== representationKey(plan.storage) ||
    observation.target.kind !== 'dynamic' ||
    observation.target.reason === 'untyped-callable' ||
    !totalNativeWrite(observation, resolve)
  )
    return null
  return {
    ...plan,
    ownerObservation: observation,
    dependencies: [...new Map([...plan.dependencies, observation].map((node) => [node.id, node])).values()]
  }
}

/** Certification replays the same pair and canonical child selection; equal
 * ids or compatible public element types do not substitute for source storage.
 */
export const nativeArrayViewPlanMatches = (
  plan: NativeArrayViewPlan,
  source: Representation,
  target: Representation,
  resolve: ConversionNodeResolver
): boolean => {
  if (representationKey(plan.source) !== representationKey(source) || representationKey(plan.target) !== representationKey(target))
    return false
  const selected = new Map(plan.dependencies.map((node) => [`${representationKey(node.source)}->${representationKey(node.target)}`, node]))
  const accepted: AcceptedConversion = (from, into) => selected.get(`${representationKey(from)}->${representationKey(into)}`) ?? null
  const base = nativeArrayViewBasePlanOf(source, target, accepted, accepted, resolve)
  const observed =
    base !== null && plan.sourceObservation !== undefined ? nativeArrayViewWithObservation(base, plan.sourceObservation, resolve) : base
  const replay =
    observed !== null && plan.ownerObservation !== undefined
      ? nativeArrayViewWithOwnerObservation(observed, plan.ownerObservation, resolve)
      : observed
  if (
    replay === null ||
    representationKey(replay.storage) !== representationKey(plan.storage) ||
    replay.read !== plan.read ||
    replay.write.kind !== plan.write.kind
  )
    return false
  const writeMatches =
    replay.write.kind === 'conversion' && plan.write.kind === 'conversion'
      ? replay.write.conversion === plan.write.conversion
      : replay.write.kind === 'native-entry' &&
        plan.write.kind === 'native-entry' &&
        replay.write.stored === plan.write.stored &&
        replay.write.observation === plan.write.observation
  return (
    writeMatches &&
    replay.dependencies.length === plan.dependencies.length &&
    replay.dependencies.every((node, index) => node === plan.dependencies[index])
  )
}

/** Only exact selected roots install array callbacks. Children are supplied
 * by the caller's canonical dependency closure rather than inferred by type.
 */
export const nativeArrayViewPlansOf = (nodes: Iterable<ConversionNode>): readonly NativeArrayViewPlan[] => {
  const plans = new Set<NativeArrayViewPlan>()
  for (const node of nodes)
    if ('materializer' in node.capability && node.capability.materializer.nativeArrayView)
      plans.add(node.capability.materializer.nativeArrayView)
  return [...plans]
}

/** Root result selection is distinct from dependencies that merely install
 * an array reader in a field or callback of another object.
 */
export const nativeArrayRootViewPlansOf = (node: ConversionNode, resolve: ConversionNodeResolver): readonly NativeArrayViewPlan[] => {
  const plans = new Set<NativeArrayViewPlan>()
  const visited = new Set<string>()
  const visit = (current: ConversionNode): void => {
    if (resolve(current.id) !== current || visited.has(current.id) || !('materializer' in current.capability)) return
    visited.add(current.id)
    const direct = current.capability.materializer.nativeArrayView
    if (direct && nativeArrayViewPlanMatches(direct, current.source, current.target, resolve)) plans.add(direct)
    const wrapper = current.capability.materializer.dynamicWrapper
    if (wrapper && dynamicWrapperPlanMatches(wrapper, current.source, current.target, resolve)) {
      if (wrapper.kind === 'union') for (const arm of wrapper.arms) visit(arm.conversion)
      else visit(wrapper.payload)
    }
  }
  visit(node)
  return [...plans]
}

export const nativeArrayViewIdentityTransportOf = (node: ConversionNode | null | undefined, resolve: ConversionNodeResolver): boolean =>
  !!node &&
  'materializer' in node.capability &&
  node.capability.materializer.nativeArrayView !== undefined &&
  nativeArrayViewPlanMatches(node.capability.materializer.nativeArrayView, node.source, node.target, resolve)
