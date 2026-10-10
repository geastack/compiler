import type { CallableAbi, RecordField, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { iteratorObjectViewPlan } from './iterator-object-view.js'
import type { PairConvertible } from './record-view.js'

/**
 * An Array or a Set read as the iterable OBJECT an interface declares --
 * `Iterable<T>`, whose one member is `[Symbol.iterator]()`.
 *
 * A stream library's `Readable.from(iterable: Iterable<unknown>)` is a static
 * method the parameter census cannot count every caller of, so its parameter
 * keeps the declared `Iterable<unknown>` record, and every caller hands it an
 * array (`Readable.from(['a', 'b'])`), a Set, or a Buffer list. The array is
 * not a record, and the program the checker accepted has no other way to
 * reach the declared type.
 *
 * The record is a VIEW, not a snapshot: its `[Symbol.iterator]` closes over
 * the source collection itself and, each time it is called, opens a fresh
 * cursor over whatever the collection holds at that moment (ECMA-262 23.1.3.35
 * `Array.prototype[@@iterator]`, 24.2.3.11 `Set.prototype[@@iterator]`). The
 * cursor is then read as the iterator object the member declares by
 * `iterator-object-view.ts`'s own plan, so the element carrier reaches the
 * declared `value` the same way it does for any native cursor.
 *
 * Only the member `[Symbol.iterator]` is carried: an `Iterable<T>` target with
 * any other required member is not an iterable view of a collection.
 */
export interface IterableObjectViewPlan {
  readonly source: Extract<Representation, { kind: 'array-object' | 'keyed-collection' }>
  readonly target: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
  /** The cursor carrier each call of `[Symbol.iterator]` opens over the collection. */
  readonly cursor: Extract<Representation, { kind: 'iterator' }>
  readonly field: RecordField
  readonly abi: CallableAbi
  /** The iterator object `[Symbol.iterator]` answers, which the cursor is read as. */
  readonly result: Representation
}

/** The elements a collection yields, or `null` when it is not a sequence this view covers. */
export const iterableElementOf = (source: Representation): Representation | null => {
  if (source.kind === 'array-object') {
    return source.ownership === 'shared-refcount' && source.recursive === undefined && source.extension === null ? source.element : null
  }
  if (source.kind === 'keyed-collection' && source.family === 'set') {
    return source.ownership === 'shared-refcount' && source.recursive === undefined && source.readOnlyView !== true ? source.key : null
  }
  return null
}

export const iterableObjectViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  convertible: PairConvertible
): IterableObjectViewPlan | null => {
  if (source.kind !== 'array-object' && source.kind !== 'keyed-collection') return null
  const element = iterableElementOf(source)
  if (element === null) return null
  if (target.kind !== 'record' && target.kind !== 'native-record-ref') return null
  if (target.kind === 'native-record-ref' && target.native !== null) return null
  if (target.ownership !== 'shared-refcount') return null
  if (target.kind === 'record' && target.accessors.length !== 0) return null
  const fields = target.kind === 'record' ? target.fields : layouts.forShape(target.shapeId)
  if (fields === null || fields.length !== 1) return null
  const field = fields[0]!
  if (layouts.wellKnownSymbolOfKey?.(field.key) !== 'iterator') return null
  const value = field.value.kind === 'optional' ? field.value.payload : field.value
  if (value.kind !== 'function-value-dispatch') return null
  const abi = value.abi
  if (abi.receiver !== null && !convertible(source, abi.receiver)) return null
  if (abi.parameters.some((parameter) => parameter.value.kind !== 'undefined' && parameter.value.kind !== 'void' && abi.restFrom === null))
    return null
  const cursor: Extract<Representation, { kind: 'iterator' }> = {
    kind: 'iterator',
    element,
    resume: { kind: 'undefined' },
    completion: { kind: 'undefined' },
    source: 'sequence'
  }
  const result = abi.result
  const object = result.kind === 'optional' ? result.payload : result
  if (iteratorObjectViewPlan(layouts, cursor, object, convertible) === null) return null
  if (representationKey(source) === representationKey(target)) return null
  return { source, target, cursor, field, abi, result }
}
