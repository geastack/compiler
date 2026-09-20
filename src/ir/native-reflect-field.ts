import type { RecordField } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import type { CallOperation } from './model.js'

/** Exact native field transport shared by Reflect emission and protocol demand. */
export const nativeReflectFieldTransportOf = (
  operation: CallOperation,
  field: RecordField | null,
  deriver: RepresentationDeriver | null = null
): 'native-read' | 'native-write' | null => {
  if (!field || field.value.kind === 'dynamic' || operation.argumentsAreSpread) return null
  if (operation.intrinsicReflection === 'getOwnPropertyDescriptor' && operation.result) {
    const result = operation.result.representation
    const descriptor = result.kind === 'optional' ? result.payload : result
    const fields =
      descriptor.kind === 'record' || descriptor.kind === 'record-with-index'
        ? descriptor.fields
        : descriptor.kind === 'native-record-ref' && deriver
          ? recordFieldsOfShape(deriver, descriptor.shapeId)
          : null
    const value = fields?.find((item) => item.key === 'value')
    // A descriptor reports absence separately from its typed value. Unlike
    // Reflect.get, deleting the source field does not force its value through
    // a dynamic carrier or require the field to be permanently present.
    if (value && representationKey(value.value) === representationKey(field.value)) return 'native-read'
    return null
  }
  if (!field.required) return null
  if (
    operation.intrinsicReflection === 'get' &&
    operation.result &&
    representationKey(operation.result.representation) === representationKey(field.value)
  )
    return 'native-read'
  const written = operation.arguments[2]
  if (operation.intrinsicReflection === 'set' && written && representationKey(written.representation) === representationKey(field.value))
    return 'native-write'
  return null
}
