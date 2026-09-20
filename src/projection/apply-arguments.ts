import type { StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { RecordField, Representation } from '../representation/model.js'
import type { StructuralType } from '../semantics/model/structural-types.js'

/**
 * The positions CreateListFromArrayLike reads from a closed typed tuple.
 * Arity comes from the semantic type; payload carriers come from physical
 * storage. Homogeneous tuples can use ArrayObject storage, while heterogeneous
 * tuples use positional records. Neither changes the tuple's stated arity.
 * Optional/open tuples retain the runtime-sized path.
 */
export const fixedApplyArgumentFieldsOf = (
  types: ReadonlyMap<StructuralTypeId, StructuralType>,
  type: StructuralTypeId,
  carrier: Representation,
  deriver: RepresentationDeriver
): readonly RecordField[] | null => {
  const shape = types.get(type)?.shape
  if (shape?.kind !== 'tuple' || shape.elements.some((element) => element.optional || element.rest || element.variadic)) return null
  if (carrier.kind === 'array-object') {
    return shape.elements.map((_, index) => ({ key: String(index), value: carrier.element, required: true }))
  }
  const layout = carrier.kind === 'native-record-ref' ? deriver.layoutOf(carrier.shapeId as StructuralTypeId) : carrier
  if (layout.kind !== 'record') return null
  const fields = shape.elements.map((_, index) => layout.fields.find((field) => field.key === String(index)))
  return fields.every((field): field is RecordField => field !== undefined && field.required) ? fields : null
}
