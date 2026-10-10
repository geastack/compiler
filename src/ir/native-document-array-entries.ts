import type { ConversionNode, ConversionNodeResolver } from '../conversion/algebra.js'
import { nativeArrayRootViewPlansOf } from '../conversion/array-view.js'
import { nativeDocumentEntryViewOf } from '../conversion/document-record-view.js'
import type { StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'

export interface NativeDocumentArrayEntry {
  readonly entry: Representation
  readonly ordinaryIndex: Representation
  readonly readers: readonly { readonly array: string; readonly element: string }[]
}

/** An exact erased array reader also admits the already-native target array.
 * Its elements therefore have two distinct protocols: an installed Document
 * view, or the independently projected ordinary string:any index. */
export const nativeDocumentArrayEntryOf = (
  receiver: Representation,
  nodes: Iterable<ConversionNode>,
  resolve: ConversionNodeResolver,
  deriver: Pick<RepresentationDeriver, 'layoutOf'> | null | undefined
): NativeDocumentArrayEntry | null => {
  if (receiver.kind === 'optional') return nativeDocumentArrayEntryOf(receiver.payload, nodes, resolve, deriver)
  if (
    (receiver.kind !== 'record-with-index' && receiver.kind !== 'native-record-ref') ||
    receiver.ownership !== 'shared-refcount' ||
    (receiver.kind === 'native-record-ref' && (receiver.native !== null || receiver.recursive !== undefined))
  )
    return null
  const layout = receiver.kind === 'record-with-index' ? receiver : deriver?.layoutOf(receiver.shapeId as StructuralTypeId)
  if (layout?.kind !== 'record-with-index' || layout.indexes.length !== 1) return null
  const index = layout.indexes[0]!
  if (index.key !== 'string' || index.value.kind !== 'dynamic' || index.value.reason !== 'declared-any-never-narrowed') return null
  const readers = new Map<string, NativeDocumentArrayEntry['readers'][number]>()
  for (const node of nodes) {
    if (resolve(node.id) !== node) return null
    for (const plan of nativeArrayRootViewPlansOf(node, resolve)) {
      if (representationKey(plan.target.element) !== representationKey(receiver)) continue
      const entry = nativeDocumentEntryViewOf(plan.read, resolve)
      if (
        plan.storage.element.kind !== 'dynamic' ||
        plan.storage.element.reason !== 'declared-any-never-narrowed' ||
        entry === null ||
        representationKey(entry) !== representationKey(index.value)
      )
        return null
      readers.set(JSON.stringify([node.id, plan.read.id]), { array: node.id, element: plan.read.id })
    }
  }
  return readers.size === 0 ? null : { entry: index.value, ordinaryIndex: index.value, readers: [...readers.values()] }
}
