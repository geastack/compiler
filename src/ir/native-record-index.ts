import type { RepresentationDeriver } from '../representation/derive.js'
import {
  isCanonicalNumberPropertyKeyText,
  recordIndexForKeyCarrier,
  type RecordIndexKey,
  type RecordIndexSidecar,
  type Representation
} from '../representation/model.js'
import { symbolPropertyKeyDeclarationOf } from '../semantics/model/structural-types.js'
import type { StructuralTypeId } from '../identity/ids.js'

/** Whether a native index domain can select a fixed slot. Symbol identities
 * never alias string keys; numeric indexes use canonical Number::toString. */
export const recordIndexDomainContainsKey = (domain: RecordIndexKey, key: string): boolean => {
  const symbol = symbolPropertyKeyDeclarationOf(key) !== null
  return domain === 'symbol' ? symbol : !symbol && (domain === 'string' || isCanonicalNumberPropertyKeyText(key))
}

/** A typed sidecar whose key cannot alias any fixed field. Both transport
 * emission and protocol demand consume this proof; absence remains an entry
 * lookup fact, not an implicit promise that the key exists. */
export const disjointNativeRecordIndexOf = (
  deriver: RepresentationDeriver,
  receiver: Representation,
  key: Representation,
  constantText?: string
): RecordIndexSidecar | null => {
  const layout =
    receiver.kind === 'native-record-ref' && receiver.native === null ? deriver.layoutOf(receiver.shapeId as StructuralTypeId) : receiver
  if (layout.kind !== 'record-with-index') return null
  const index = recordIndexForKeyCarrier(layout.indexes, key, constantText)
  return index && layout.fields.every((field) => !recordIndexDomainContainsKey(index.key, field.key)) ? index : null
}

/** An erased read recovering undefined must test entry presence before reading
 * the native slot. Keep that lookup carrier shared with reflection demand. */
export const nativeRecordIndexReadCarrierOf = (index: RecordIndexSidecar, result: Representation): Representation => {
  if (result.kind !== 'optional' || result.absence !== 'undefined') return index.value
  if (index.value.kind === 'optional' && index.value.absence === 'undefined') return index.value
  return { kind: 'optional', payload: index.value, absence: 'undefined' }
}
