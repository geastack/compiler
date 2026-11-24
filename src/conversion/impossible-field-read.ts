import type { Representation } from '../representation/model.js'

export const IMPOSSIBLE_FIELD_READ = 'native:impossible-field-read'
export const ABSENT_ONLY_FIELD_READ = 'native:absent-only-field-read'

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

const bufferKinds: ReadonlySet<Representation['kind']> = new Set(['typed-array', 'array-buffer', 'shared-array-buffer', 'data-view'])

/**
 * A declared native slot cannot contain a value of this narrowed carrier.
 * This is a property-read context, never permission to convert the pair at
 * an ordinary store. A lying user guard may reach it, so it throws rather
 * than reading the slot through an incompatible layout.
 */
export const impossibleFieldReadOf = (source: Representation, target: Representation): boolean => {
  if ((source.kind === 'string' || source.kind === 'scalar') && objectKinds.has(target.kind)) return true
  // A byte container is an integer-indexed exotic object, never an Array
  // exotic one: a slot holding one cannot hold the Array a narrowed read
  // names (a `{ value: chunk }` iterator result reached through a dead
  // union arm of a Map entry step, whose own checked view would throw too).
  if (bufferKinds.has(source.kind) && target.kind === 'array-object') return true
  const record =
    source.kind === 'record' || source.kind === 'record-with-index' || (source.kind === 'native-record-ref' && source.native === null)
  return record && (target.kind === 'typed-array' || target.kind === 'array-buffer' || target.kind === 'data-view')
}

/**
 * No value of a byte container's carrier is an instance of a compiled class
 * whose instance is no native object: the class's struct derives from no
 * buffer, so no common subtype exists (a class extending a collection, error
 * or promise names that base in `nativeBase` and stays out).
 */
const disjointPayloadOf = (source: Representation, target: Representation): boolean =>
  impossibleFieldReadOf(source, target) || (bufferKinds.has(source.kind) && target.kind === 'class-ref' && target.nativeBase === undefined)

/**
 * One route of a live view's field read whose present payload can never be
 * the target's (a TLS `session` held as bytes, read through a view as a
 * client session object). Its only legal outcome is the shared absence; a
 * present value takes the impossible read's checked failure. Anything that
 * could convert keeps its ordinary conversion -- this answers only `never`.
 */
export const absentOnlyFieldReadOf = (source: Representation, target: Representation): boolean =>
  source.kind === 'optional' &&
  target.kind === 'optional' &&
  source.absence === target.absence &&
  disjointPayloadOf(source.payload, target.payload)
