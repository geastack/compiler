import type { Representation } from '../representation/model.js'

/** @semanticCategory generic-primitive */
export type FunctionSourceReadClaim = 'direct' | 'union'

const directCallableKinds: ReadonlySet<Representation['kind']> = new Set([
  'function',
  'function-family',
  'function-value-dispatch',
  'function-and-constructor'
])

/** A registered Function source is a fused native read; other values keep their ordinary property/call protocol. */
export const functionSourceReadProtocolOf = (receiver: Representation, result: Representation): FunctionSourceReadClaim | null => {
  if (directCallableKinds.has(receiver.kind)) return 'direct'
  const everyLeafHasSource = (value: Representation): boolean =>
    value.kind === 'tagged-union'
      ? value.arms.length > 0 && value.arms.every((arm) => everyLeafHasSource(arm.value))
      : value.kind === 'string' || (value.kind === 'dynamic' && value.reason === 'untyped-callable')
  return receiver.kind === 'tagged-union' && result.kind === 'function-value-dispatch' && everyLeafHasSource(receiver) ? 'union' : null
}
