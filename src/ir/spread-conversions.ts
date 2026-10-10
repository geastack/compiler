import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { structuralConversionKey } from '../conversion/structural-plan.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { staticOwnFieldsOf } from '../representation/record-fields.js'
import { nativeCallableDataCarrierHasStorageIdentity } from '../representation/native-callable-data-storage.js'
import { indexedRecordViewOf, spreadFieldRecordReceiverOf, spreadIndexedRecordReceiverOf } from './certify/carrier-keys.js'
import type { SpreadCopyOperation } from './model.js'

export interface SpreadCopyConversionPlan {
  readonly source: string
  readonly target: string
  readonly leaves: ReadonlyMap<string, ConversionNode>
  /** A creation-order callback exists only when its complete native frame is admitted. */
  readonly walks: ReadonlySet<string>
  /** The value carriers the copy stores natively into the receiver's expando
   * (by representation key), each with its certified Value materializer: a
   * key the receiver's layout lacks keeps the source's own carrier rather than
   * a box made at copy time. A carrier absent here is stored as it arrives. */
  readonly expandoData: ReadonlyMap<string, { readonly value: Representation; readonly materializer: ConversionNode }>
  /** Which of those carriers each static key may hold; `null` collects the
   * carriers stored under run-time keys (dictionary or index entries). */
  readonly expandoKeys: ReadonlyMap<string | null, readonly Representation[]>
}

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

/** Internal stores of CopyDataProperties, including its optional creation-order path. */
export const spreadCopyConversionPlanOf = (
  operation: SpreadCopyOperation,
  deriver: RepresentationDeriver,
  census: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>
): SpreadCopyConversionPlan => {
  const receiver = operation.receiver.representation
  const leaves = new Map<string, ConversionNode>()
  const walks = new Set<string>()
  const keys = operation.keys === undefined ? null : new Set(operation.keys)
  const overwritten = new Set(operation.overwritten ?? [])
  const add = (source: Representation, target: Representation): void => {
    leaves.set(structuralConversionKey(source, target), census.nodeFor(source, target))
  }
  const walk = (source: Representation, targets: readonly Representation[]): void => {
    const nodes = targets.map((target) => census.nodeFor(dynamic, target))
    if (!nodes.every((node) => recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById))) return
    walks.add(representationKey(source))
    for (const node of nodes) leaves.set(structuralConversionKey(node.source, node.target), node)
  }
  const indexed = spreadIndexedRecordReceiverOf(deriver, receiver)
  const target = indexed?.view ?? spreadFieldRecordReceiverOf(deriver, receiver)
  const sidecar = indexed?.index.value ?? (target?.ownership === 'shared-refcount' ? dynamic : null)
  const expandoData = new Map<string, { readonly value: Representation; readonly materializer: ConversionNode }>()
  const expandoKeys = new Map<string | null, Representation[]>()
  // Into the expando (a shared receiver with no index sidecar) a typed value
  // is stored in its own carrier when that carrier has storage identity and
  // its Value materializer is certifiable; the same leaf a boxing store would
  // have run now runs only for a dynamic observer.
  const store = (value: Representation, key: string | null): void => {
    add(value, sidecar!)
    if (indexed !== null || value.kind === 'dynamic' || !nativeCallableDataCarrierHasStorageIdentity(value)) return
    const node = census.nodeFor(value, dynamic)
    if (!recipeIsMaterializableWithoutPriorSourceGuard(node, census.nodeById)) return
    expandoData.set(representationKey(value), { value, materializer: node })
    const held = expandoKeys.get(key) ?? []
    if (!held.some((one) => representationKey(one) === representationKey(value))) held.push(value)
    expandoKeys.set(key, held)
  }
  const route = (value: Representation): void => {
    for (const field of target?.fields ?? []) if (!field.key.startsWith('sym(')) add(value, field.value)
    if (sidecar !== null) store(value, null)
  }
  const visit = (source: Representation): void => {
    if (source.kind === 'optional') return visit(source.payload)
    if (source.kind === 'tagged-union') {
      for (const arm of source.arms) visit(arm.value)
      return
    }
    if (receiver.kind === 'dynamic') return
    const view = indexedRecordViewOf(deriver, source)
    const fields = view?.fields ?? staticOwnFieldsOf(deriver, source)
    if (receiver.kind === 'dictionary') {
      if (source.kind === 'dynamic') return add(dynamic, receiver.value)
      if (source.kind === 'dictionary') return add(source.value, receiver.value)
      if (fields === null) return
      const copied = view !== null || keys === null ? fields : fields.filter((field) => keys.has(field.key))
      for (const field of copied) add(field.value, receiver.value)
      for (const index of view?.indexes ?? []) add(index.value, receiver.value)
      if (
        'ownership' in source &&
        source.ownership === 'shared-refcount' &&
        receiver.key === 'string' &&
        (view !== null || copied.length === fields.length)
      )
        walk(source, [receiver.value])
      return
    }
    if (target === null) return
    if (source.kind === 'dynamic') return route(source)
    if (source.kind === 'dictionary') return route(source.value)
    if (fields === null) return
    for (const field of fields) {
      if ((keys !== null && !keys.has(field.key)) || overwritten.has(field.key)) continue
      const held = target.fields.find((candidate) => candidate.key === field.key)
      if (held !== undefined) add(field.value, held.value)
      else if (sidecar !== null) store(field.value, field.key)
    }
    for (const index of view?.indexes ?? []) route(index.value)
    if ('ownership' in source && source.ownership === 'shared-refcount' && (keys === null || fields.every((field) => keys.has(field.key))))
      walk(source, [
        ...target.fields.filter((field) => !field.key.startsWith('sym(')).map((field) => field.value),
        ...(sidecar === null ? [] : [sidecar])
      ])
  }
  visit(operation.source.representation)
  return {
    source: representationKey(operation.source.representation),
    target: representationKey(receiver),
    leaves,
    walks,
    expandoData,
    expandoKeys
  }
}

/** Certification reconstructs routes from the operation, never from the supplied plan. */
export const spreadCopyConversionPlanMatches = (
  operation: SpreadCopyOperation,
  plan: SpreadCopyConversionPlan | undefined,
  deriver: RepresentationDeriver,
  census: Pick<ConversionCensus, 'nodeFor' | 'nodeById'>
): boolean => {
  if (plan === undefined) return false
  const expected = spreadCopyConversionPlanOf(operation, deriver, census)
  return (
    plan.source === expected.source &&
    plan.target === expected.target &&
    plan.leaves.size === expected.leaves.size &&
    plan.walks.size === expected.walks.size &&
    plan.expandoData.size === expected.expandoData.size &&
    [...expected.expandoData].every(([key, entry]) => plan.expandoData.get(key)?.materializer === entry.materializer) &&
    [...expected.walks].every((key) => plan.walks.has(key)) &&
    [...expected.leaves].every(([key, node]) => plan.leaves.get(key) === node && census.nodeById(node.id) === node)
  )
}
