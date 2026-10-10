export { cppErrorNativeType, isNativeError } from '../../representation/prototype-domains.js'

export const errorConstructorNames: ReadonlyMap<string, string> = new Map([
  ['ErrorConstructor', 'Error'],
  ['EvalErrorConstructor', 'EvalError'],
  ['RangeErrorConstructor', 'RangeError'],
  ['ReferenceErrorConstructor', 'ReferenceError'],
  ['SyntaxErrorConstructor', 'SyntaxError'],
  ['TypeErrorConstructor', 'TypeError'],
  ['URIErrorConstructor', 'URIError']
])
