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

/**
 * The error prototypes the runtime models as intrinsic objects on the dynamic
 * substrate (`gea::detail::IntrinsicErrorPrototype`, gea_runtime.h): a handle
 * of one of these protocols boxes to that object.
 */
export const errorPrototypeProtocols: ReadonlySet<string> = new Set([...errorConstructorNames.values()].map((name) => `${name}.prototype`))

export const isNativeError = (carrier: Representation): boolean =>
  carrier.kind === 'native-record-ref' && carrier.native === cppErrorNativeType && carrier.ownership === 'shared-refcount'
