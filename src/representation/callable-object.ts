import type { Representation } from './model.js'

/** These carriers preserve a Function object's shared property-table identity. */
export const isNativeCallableCarrier = (kind: Representation['kind']): boolean =>
  kind === 'function' ||
  kind === 'function-family' ||
  kind === 'function-value-family' ||
  kind === 'function-value-dispatch' ||
  kind === 'function-and-constructor'
