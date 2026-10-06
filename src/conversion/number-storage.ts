import type { Representation } from '../representation/model.js'

export type NumberScalar = Extract<Representation, { readonly kind: 'scalar' }> & { readonly domain: 'number' }

/** Changing a Number's native width is a numeric store, never a change of its JS type. */
export const numberStorageTarget = (source: Representation, target: Representation): NumberScalar | null =>
  source.kind === 'scalar' &&
  source.domain === 'number' &&
  target.kind === 'scalar' &&
  target.domain === 'number' &&
  source.integerWidth !== target.integerWidth
    ? (target as NumberScalar)
    : null
