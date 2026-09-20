import type { StructuralTypeId } from '../identity/ids.js'
import type { Ownership, Representation } from './model.js'

export interface NativeNumericIndex {
  readonly kind: 'elements' | 'dictionary' | 'record-index'
  readonly value: Representation
  readonly ownership: Ownership
}

/** The native indexed storage reached by a numeric property key.
 * A record's named numeric fields would need runtime field dispatch before
 * the sidecar lookup, so those are not admitted as a plain table access.
 */
export const nativeNumericIndexOf = (
  value: Representation,
  resolve: (id: StructuralTypeId) => Representation
): NativeNumericIndex | null => {
  if (value.kind === 'array-object' || value.kind === 'typed-array') {
    if (value.ownership !== 'shared-refcount') return null
    return {
      kind: 'elements',
      value: value.kind === 'array-object' ? value.element : { kind: 'scalar', domain: 'number' },
      ownership: value.ownership
    }
  }
  if (value.kind === 'dictionary' && value.key === 'number') return { kind: 'dictionary', value: value.value, ownership: value.ownership }
  const record = value.kind === 'native-record-ref' && value.native === null ? resolve(value.shapeId as StructuralTypeId) : value
  if (record.kind !== 'record-with-index') return null
  const index = record.indexes.find((candidate) => candidate.key === 'number' || candidate.key === 'string')
  if (!index) return null
  if (record.fields.some((field) => String(Number(field.key)) === field.key)) return null
  return { kind: 'record-index', value: index.value, ownership: record.ownership }
}

export const hasNativeNumericIndexArms = (value: Representation, resolve: (id: StructuralTypeId) => Representation): boolean =>
  value.kind === 'tagged-union' &&
  value.arms.some((arm) => nativeNumericIndexOf(arm.value, resolve) !== null) &&
  value.arms.every(
    (arm) => arm.value.kind === 'null' || arm.value.kind === 'undefined' || nativeNumericIndexOf(arm.value, resolve) !== null
  )
