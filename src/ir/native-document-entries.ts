import type { ConversionCensus } from '../conversion/nodes.js'
import type { ConversionNodeId } from '../conversion/algebra.js'
import { nativeDocumentEntryValueIsNative, nativeDocumentEntryViewOf } from '../conversion/document-record-view.js'
import { dictionaryEntryReadIsLive, dictionaryEntryWriteIsTotal } from '../conversion/dictionary-view.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { NativeCallableFlow } from './callable-class-flow.js'
import type { GetOperation, IrOperand, SetOperation } from './model.js'
import { nativeDocumentArrayEntryOf, type NativeDocumentArrayEntry } from './native-document-array-entries.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { symbolPropertyKeyDeclarationOf } from '../semantics/model/structural-types.js'

/** The actual receiver retains every installed original Document entry route.
 * Keys are runtime strings; this is independent of a finite key/field census.
 * @semanticCategory generic-primitive
 */
export interface NativeDocumentEntry {
  readonly receiver: IrOperand
  readonly entry: Representation
  readonly views: readonly ConversionNodeId[]
  readonly conversion: ConversionNodeId
  readonly arrayEntry?: NativeDocumentArrayEntry
}

/** A `dynamic` arm (an `any` entry recursed into the same parameter) reads
 * through its own `gea::Value` [[Get]] and the same entry leaf; it is a read
 * route only, so a write keeps requiring a pure Document surface. */
const sharedDocumentSurface = (carrier: Representation, dynamicArms = false): boolean =>
  carrier.kind === 'optional'
    ? sharedDocumentSurface(carrier.payload, dynamicArms)
    : carrier.kind === 'tagged-union'
      ? carrier.arms.some((arm) => arm.value.kind !== 'dynamic') &&
        carrier.arms.every((arm) => (dynamicArms && arm.value.kind === 'dynamic') || sharedDocumentSurface(arm.value, dynamicArms))
      : carrier.kind === 'undefined' ||
        carrier.kind === 'null' ||
        ((carrier.kind === 'record' ||
          carrier.kind === 'record-with-index' ||
          (carrier.kind === 'native-record-ref' && carrier.native === null)) &&
          carrier.ownership === 'shared-refcount')

/** Reconstruct the complete installed source protocol and its future leaf. */
export const nativeDocumentEntryOf = (
  operation: GetOperation | SetOperation,
  flow: Pick<NativeCallableFlow, 'nativeDocumentEntryValues'> & Partial<Pick<NativeCallableFlow, 'nativeDocumentArrayEntryValues'>>,
  conversions: ConversionCensus,
  deriver?: Pick<RepresentationDeriver, 'layoutOf'> | null,
  staticKey?: string | null
): NativeDocumentEntry | null => {
  // A static symbol member (`decrypted[kDecoratedKeys]`) reaches the IR as its
  // `sym(<declaration>)` string constant; it names a declared field route of the
  // view, never a runtime string entry of the Document.
  if (staticKey !== undefined && staticKey !== null && symbolPropertyKeyDeclarationOf(staticKey) !== null) return null
  if (operation.key.representation.kind !== 'string' || !sharedDocumentSurface(operation.receiver.representation, operation.kind === 'get'))
    return null
  const arrayEntry = flow.nativeDocumentArrayEntryValues?.get(operation.receiver.value)
  const protocol =
    flow.nativeDocumentEntryValues?.get(operation.receiver.value) ??
    (arrayEntry === undefined ? undefined : { entry: arrayEntry.entry, views: arrayEntry.readers.map((reader) => reader.element) })
  if (
    !protocol ||
    protocol.entry.kind !== 'dynamic' ||
    protocol.entry.reason !== 'declared-any-never-narrowed' ||
    protocol.views.length === 0
  )
    return null
  for (const id of protocol.views) {
    const node = conversions.nodeById(id)
    const entry = node === null ? null : nativeDocumentEntryViewOf(node, conversions.nodeById)
    if (entry === null || representationKey(entry) !== representationKey(protocol.entry)) return null
  }
  if (arrayEntry !== undefined) {
    if (operation.kind !== 'get' || representationKey(operation.result.representation) !== representationKey(arrayEntry.entry)) return null
    const nodes = arrayEntry.readers.map((reader) => conversions.nodeById(reader.array))
    if (nodes.some((node) => node === null)) return null
    // The receipt must replay the actual ordinary index, independently of
    // the selected Document branch. A public string:any spelling alone does
    // not install a Document protocol on the receiver.
    const replay = nativeDocumentArrayEntryOf(
      operation.receiver.representation,
      nodes as NonNullable<(typeof nodes)[number]>[],
      conversions.nodeById,
      deriver
    )
    if (replay === null || JSON.stringify(replay) !== JSON.stringify(arrayEntry)) return null
  }
  if (operation.kind === 'set' && !nativeDocumentEntryValueIsNative(operation.value.representation)) return null
  const leaf =
    operation.kind === 'get'
      ? conversions.dictionaryReadFor(protocol.entry, operation.result.representation)
      : conversions.nodeFor(operation.value.representation, protocol.entry)
  if (
    leaf === null ||
    (operation.kind === 'get'
      ? !dictionaryEntryReadIsLive(leaf, conversions.nodeById)
      : !dictionaryEntryWriteIsTotal(leaf, conversions.nodeById))
  )
    return null
  return {
    receiver: operation.receiver,
    entry: protocol.entry,
    views: protocol.views,
    conversion: leaf.id,
    ...(arrayEntry === undefined ? {} : { arrayEntry })
  }
}

export const nativeDocumentEntryMatches = (expected: NativeDocumentEntry | null, actual: NativeDocumentEntry | undefined): boolean =>
  expected !== null && actual !== undefined && JSON.stringify(expected) === JSON.stringify(actual)
