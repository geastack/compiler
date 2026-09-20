import type { IrOperation } from './model.js'

/** The sealed absence proof eliminates lookup, while native references still require a null check. */
export const nativeAbsentPropertyReadOf = (operation: IrOperation): 'checked-reference' | 'primitive' | null => {
  if (
    operation.kind !== 'get' ||
    operation.normalResult !== 'undefined' ||
    operation.result.representation.kind !== 'undefined' ||
    operation.key.representation.kind !== 'scalar' ||
    operation.key.representation.domain !== 'number'
  )
    return null
  const receiver = operation.receiver.representation
  if (receiver.kind === 'class-ref' && receiver.ownership === 'shared-refcount') return 'checked-reference'
  return receiver.kind === 'scalar' || receiver.kind === 'string' || receiver.kind === 'symbol' ? 'primitive' : null
}
