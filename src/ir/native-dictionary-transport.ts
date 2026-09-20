import { representationKey } from '../representation/model.js'
import type { IrOperation } from './model.js'

/** Native dictionary storage transports its declared values. A computed key
 * selects an entry; it does not reflect on the fields of that entry's value.
 * Dynamic key coercions and value adapters are deliberately outside this proof.
 */
export const nativeDictionaryTransportOf = (operation: IrOperation): boolean => {
  if (operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object') {
    const target = operation.result.representation
    if (target.kind !== 'dictionary' || target.ownership !== 'shared-refcount') return false
    return (
      operation.kind === 'allocate-ordinary-object' ||
      operation.fields.every((field) => representationKey(field.value.representation) === representationKey(target.value))
    )
  }
  if (
    operation.kind !== 'get' &&
    operation.kind !== 'set' &&
    operation.kind !== 'define-own-property' &&
    operation.kind !== 'delete' &&
    operation.kind !== 'has-property'
  )
    return false
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'dictionary' || receiver.ownership !== 'shared-refcount') return false
  const key = operation.key.representation
  // String-keyed dictionaries also accept native numeric keys through their
  // canonical spelling. Objects and erased keys can invoke user coercions.
  if (
    (receiver.key !== 'string' && receiver.key !== 'number') ||
    (key.kind !== 'string' && !(key.kind === 'scalar' && key.domain === 'number'))
  )
    return false
  if (operation.kind === 'delete' || operation.kind === 'has-property') return true
  const value = operation.kind === 'get' ? operation.result.representation : operation.value.representation
  return (
    representationKey(value) === representationKey(receiver.value) ||
    (operation.kind === 'get' &&
      value.kind === 'optional' &&
      value.absence === 'undefined' &&
      representationKey(value.payload) === representationKey(receiver.value))
  )
}
