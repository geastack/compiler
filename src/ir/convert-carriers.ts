import type { Representation } from '../representation/model.js'
import type { ConvertOperation } from './model.js'

/** A fresh array rebuild cites its element conversion, including after await. */
export const convertCarriersOf = (
  operation: Pick<ConvertOperation, 'source' | 'result' | 'rebuild'>
): { readonly source: Representation; readonly target: Representation } | null => {
  let source = operation.source.representation
  let target = operation.result.representation
  if (operation.rebuild !== 'unshared-array') return { source, target }
  while (source.kind === 'promise' && target.kind === 'promise') {
    source = source.value
    target = target.value
  }
  return source.kind === 'array-object' && target.kind === 'array-object' ? { source: source.element, target: target.element } : null
}
