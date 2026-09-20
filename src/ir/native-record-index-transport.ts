import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { conversionNodeIdOf, type ConversionCensus } from '../conversion/nodes.js'
import { nativePayloadTransportMatches } from '../conversion/native-payload-transport.js'
import { disjointNativeRecordIndexOf, nativeRecordIndexReadCarrierOf } from './native-record-index.js'
import type { IrOperation } from './model.js'

/** Runtime identity/numeric keys on a native shared record can use its
 * generated property-presence protocol without reflecting fixed payloads. */
export const nativeRecordIndexHasPropertyOf = (deriver: RepresentationDeriver, receiver: Representation, key: Representation): boolean =>
  'ownership' in receiver &&
  receiver.ownership === 'shared-refcount' &&
  (key.kind === 'symbol' || (key.kind === 'scalar' && key.domain === 'number')) &&
  disjointNativeRecordIndexOf(deriver, receiver, key) !== null

/** A disjoint typed index never selects a fixed-field protocol. The installed
 * value conversion must independently prove native payload transport; a key
 * domain proof alone says nothing about an adapting or dynamic value. */
export const nativeRecordIndexTransportOf = (
  operation: IrOperation,
  deriver: RepresentationDeriver | null,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined,
  constantKey: string | null
): boolean => {
  if (
    !deriver ||
    (operation.kind !== 'get' &&
      operation.kind !== 'set' &&
      operation.kind !== 'define-own-property' &&
      operation.kind !== 'delete' &&
      operation.kind !== 'has-property')
  )
    return false
  const index = disjointNativeRecordIndexOf(
    deriver,
    operation.receiver.representation,
    operation.key.representation,
    constantKey ?? undefined
  )
  if (!index) return false
  if (operation.kind === 'delete' || operation.kind === 'has-property') return true
  const source =
    operation.kind === 'get' ? nativeRecordIndexReadCarrierOf(index, operation.result.representation) : operation.value.representation
  const target = operation.kind === 'get' ? operation.result.representation : index.value
  const native = (value: Representation): boolean => value.kind !== 'dynamic' && value.kind !== 'unresolved'
  return (
    native(source) &&
    native(target) &&
    (representationKey(source) === representationKey(target) ||
      nativePayloadTransportMatches(source, target, conversions?.nodeById(conversionNodeIdOf(source, target))))
  )
}
