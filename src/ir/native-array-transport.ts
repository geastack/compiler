import { canonicalIndexLiteral } from '../representation/array-index.js'
import { representationKey } from '../representation/model.js'
import type { IrOperation } from './model.js'

/**
 * Native array transport does not publish the fields of its elements. This
 * proves absence of reflection effects, not admission of an array operation:
 * lowering and conversion guards still own whether it can be performed.
 */
export const nativeArrayTransportOf = (operation: IrOperation, constantKey: string | null): boolean => {
  if (operation.kind === 'allocate-array-object') {
    const target = operation.result.representation
    if (target.kind !== 'array-object' || target.ownership !== 'shared-refcount') return false
    const element = representationKey(target.element)
    return operation.elements.every((slot) => {
      if (slot.kind === 'hole') return true
      if (slot.kind === 'element') return representationKey(slot.value.representation) === element
      if (slot.kind !== 'spread' || slot.element !== undefined) return false
      const source = slot.value.representation
      return source.kind === 'array-object' && representationKey(source.element) === element
    })
  }
  if (operation.kind !== 'get' && operation.kind !== 'set') return false
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'array-object') return false
  const value = operation.kind === 'get' ? operation.result.representation : operation.value.representation
  if (constantKey === 'length') return value.kind === 'scalar' && value.domain === 'number'
  // A string-shaped runtime key can name an ordinary property or method.
  // Only a known canonical index or an already numeric key enters this path.
  const indexed =
    constantKey !== null
      ? canonicalIndexLiteral(constantKey) !== null
      : operation.key.representation.kind === 'scalar' && operation.key.representation.domain === 'number'
  if (!indexed) return false
  const element = representationKey(receiver.element)
  if (representationKey(value) === element) return true
  // A checked indexed read represents a hole/out-of-bounds access separately
  // from its existing native payload. It does not adapt or expose that payload.
  return (
    operation.kind === 'get' && value.kind === 'optional' && value.absence === 'undefined' && representationKey(value.payload) === element
  )
}
