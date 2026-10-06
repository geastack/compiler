import type { Representation } from '../representation/model.js'

export const IMPOSSIBLE_FIELD_READ = 'native:impossible-field-read'

const objectKinds: ReadonlySet<Representation['kind']> = new Set([
  'record',
  'record-with-index',
  'native-record-ref',
  'class-ref',
  'array-object',
  'dictionary',
  'keyed-collection',
  'promise',
  'typed-array',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'proxy-object'
])

/**
 * A declared native slot cannot contain a value of this narrowed carrier.
 * This is a property-read context, never permission to convert the pair at
 * an ordinary store. A lying user guard may reach it, so it throws rather
 * than reading the slot through an incompatible layout.
 */
export const impossibleFieldReadOf = (source: Representation, target: Representation): boolean => {
  if ((source.kind === 'string' || source.kind === 'scalar') && objectKinds.has(target.kind)) return true
  const record =
    source.kind === 'record' || source.kind === 'record-with-index' || (source.kind === 'native-record-ref' && source.native === null)
  return record && (target.kind === 'typed-array' || target.kind === 'array-buffer' || target.kind === 'data-view')
}
