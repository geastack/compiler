import type { Representation } from '../../representation/model.js'

export const cppErrorNativeType = 'gea::runtime::Error'

export const errorConstructorNames: ReadonlyMap<string, string> = new Map([
  ['ErrorConstructor', 'Error'],
  ['EvalErrorConstructor', 'EvalError'],
  ['RangeErrorConstructor', 'RangeError'],
  ['ReferenceErrorConstructor', 'ReferenceError'],
  ['SyntaxErrorConstructor', 'SyntaxError'],
  ['TypeErrorConstructor', 'TypeError'],
  ['URIErrorConstructor', 'URIError']
])

export const isNativeError = (carrier: Representation): boolean =>
  carrier.kind === 'native-record-ref' && carrier.native === cppErrorNativeType && carrier.ownership === 'shared-refcount'
