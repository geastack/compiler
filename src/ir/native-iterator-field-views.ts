import type { ConversionCensus } from '../conversion/nodes.js'
import type { FunctionId } from '../identity/ids.js'
import { recordAccessorsOfShape, recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { IrOperand } from './model.js'
import { nativeFieldViewReadFor, nativeFieldViewReceiptMatches, type NativeFieldViewRead } from './native-field-view-facts.js'

/** The internal protocol read has a callable result distinct from the step's yielded value. */
export interface NativeIteratorFieldRead {
  readonly value: Representation
  readonly read: NativeFieldViewRead
}

export const nativeIteratorMethodCarrierOf = (
  receiver: Representation,
  key: 'next' | 'return',
  deriver: RepresentationDeriver,
  abis: ReadonlyMap<FunctionId, CallableAbi>
): Representation | null => {
  if (receiver.kind === 'optional' || receiver.kind === 'borrowed-ref')
    return nativeIteratorMethodCarrierOf(receiver.kind === 'optional' ? receiver.payload : receiver.referent, key, deriver, abis)
  if (receiver.kind === 'tagged-union') {
    const values = receiver.arms.map((arm) => nativeIteratorMethodCarrierOf(arm.value, key, deriver, abis))
    const first = values[0]
    return first && values.every((value) => value !== null && representationKey(value) === representationKey(first)) ? first : null
  }
  const fields =
    receiver.kind === 'record'
      ? receiver.fields
      : receiver.kind === 'native-record-ref'
        ? recordFieldsOfShape(deriver, receiver.shapeId)
        : null
  const accessors =
    receiver.kind === 'record'
      ? receiver.accessors
      : receiver.kind === 'native-record-ref'
        ? recordAccessorsOfShape(deriver, receiver.shapeId)
        : null
  const field = fields?.find((entry) => entry.key === key)
  if (field) return field.value
  const getter = accessors?.find((entry) => entry.key === key)?.getter
  return getter ? (abis.get(getter)?.result ?? null) : null
}

/** Public protocol frames and exact source storage jointly admit the lazy native read. */
export const nativeIteratorFieldReadOf = (
  receiver: IrOperand,
  key: 'next' | 'return',
  deriver: RepresentationDeriver,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  flow: Parameters<typeof nativeFieldViewReadFor>[3],
  conversions: ConversionCensus
): NativeIteratorFieldRead | null => {
  const value = nativeIteratorMethodCarrierOf(receiver.representation, key, deriver, abis)
  if (!value) return null
  const read = nativeFieldViewReadFor(receiver, key, value, flow, conversions)
  return read ? { value, read } : null
}

export const nativeIteratorFieldReadMatches = (
  expected: NativeIteratorFieldRead | null,
  actual: NativeIteratorFieldRead | undefined
): boolean =>
  expected !== null &&
  actual !== undefined &&
  representationKey(expected.value) === representationKey(actual.value) &&
  nativeFieldViewReceiptMatches(expected.read, actual.read)
