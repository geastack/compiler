import { representationKey, type Representation } from '../representation/model.js'
import type { IrOperation } from './model.js'

/** The sequence/generator distinction is published by representation/publish.ts.
 * A sequence advances native storage; a generator can execute arbitrary code.
 * This is an effect query shared by provenance and reflection, not an admission
 * rule: lowering and certification still validate the complete cursor recipe.
 */
export const nativeSequenceTransportOf = (operation: IrOperation): boolean => {
  const sequence = (value: Representation): value is Extract<Representation, { kind: 'iterator' }> =>
    value.kind === 'iterator' && value.source === 'sequence' && value.resume.kind === 'undefined' && value.completion.kind === 'undefined'
  if (operation.kind === 'iterator-done')
    return (
      sequence(operation.iterator.representation) &&
      operation.result.representation.kind === 'scalar' &&
      operation.result.representation.domain === 'boolean'
    )
  if (operation.kind === 'iterator-next') {
    const cursor = operation.iterator.representation
    if (!sequence(cursor) || operation.value !== null) return false
    const result = operation.result.representation
    return (
      representationKey(result) === representationKey(cursor.element) ||
      (result.kind === 'optional' &&
        result.absence === 'undefined' &&
        representationKey(result.payload) === representationKey(cursor.element))
    )
  }
  if (operation.kind !== 'get-iterator' || operation.protocol !== 'iterator' || operation.method !== null) return false
  const cursor = operation.result.representation
  if (!sequence(cursor)) return false
  const carried = operation.receiver.representation
  const source = carried.kind === 'optional' ? carried.payload : carried
  if (source.kind === 'iterator') return sequence(source) && representationKey(source) === representationKey(cursor)
  if (source.kind === 'string') return cursor.element.kind === 'string'
  if (source.kind === 'array-object')
    return source.ownership === 'shared-refcount' && representationKey(source.element) === representationKey(cursor.element)
  if (source.kind === 'keyed-collection' && source.ownership === 'shared-refcount') {
    if (source.family === 'set') return representationKey(source.key) === representationKey(cursor.element)
    const pair = cursor.element
    return (
      source.family === 'map' &&
      source.value !== null &&
      pair.kind === 'record' &&
      pair.accessors.length === 0 &&
      pair.fields.length === 2 &&
      pair.fields.every(
        (field, i) =>
          field.key === String(i) &&
          field.required &&
          representationKey(field.value) === representationKey(i === 0 ? source.key : source.value!)
      )
    )
  }
  return (
    source.kind === 'record' &&
    source.accessors.length === 0 &&
    source.fields.length > 0 &&
    source.fields.every(
      (field, i) => field.key === String(i) && field.required && representationKey(field.value) === representationKey(cursor.element)
    )
  )
}
