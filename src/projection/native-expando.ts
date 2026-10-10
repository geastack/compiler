import type { Representation } from '../representation/model.js'

/** Native objects whose ordinary own properties retain shared allocation identity. */
export const nativeExpandoSidecarOf = (value: Representation): boolean =>
  'ownership' in value &&
  value.ownership === 'shared-refcount' &&
  (value.kind === 'record' ||
    value.kind === 'record-with-index' ||
    value.kind === 'native-record-ref' ||
    value.kind === 'class-ref' ||
    value.kind === 'array-object' ||
    value.kind === 'typed-array' ||
    value.kind === 'array-buffer' ||
    value.kind === 'shared-array-buffer' ||
    value.kind === 'data-view' ||
    value.kind === 'keyed-collection')
