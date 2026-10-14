import type { Representation } from '../representation/model.js'
import type { ConvertOperation } from './model.js'

/** The table pair an unshared-dictionary rebuild copies between: the source table and the slot's own table, or its optional's payload. */
export const unsharedDictionaryPairOf = (
  source: Representation,
  target: Representation
): {
  readonly source: Extract<Representation, { kind: 'dictionary' }>
  readonly target: Extract<Representation, { kind: 'dictionary' }>
} | null => {
  const table = target.kind === 'optional' ? target.payload : target
  if (source.kind !== 'dictionary' || table.kind !== 'dictionary') return null
  if (source.key !== 'string' || table.key !== 'string') return null
  if (source.ownership !== 'shared-refcount' || table.ownership !== 'shared-refcount') return null
  if (source.recursive !== undefined || table.recursive !== undefined) return null
  return { source, target: table }
}

/** A fresh array or table rebuild cites its element (entry) conversion, including after await. */
export const convertCarriersOf = (
  operation: Pick<ConvertOperation, 'source' | 'result' | 'rebuild'>
): { readonly source: Representation; readonly target: Representation } | null => {
  let source = operation.source.representation
  let target = operation.result.representation
  if (operation.rebuild === 'unshared-dictionary') {
    const pair = unsharedDictionaryPairOf(source, target)
    return pair === null ? null : { source: pair.source.value, target: pair.target.value }
  }
  if (operation.rebuild !== 'unshared-array') return { source, target }
  while (source.kind === 'promise' && target.kind === 'promise') {
    source = source.value
    target = target.value
  }
  return source.kind === 'array-object' && target.kind === 'array-object' ? { source: source.element, target: target.element } : null
}
