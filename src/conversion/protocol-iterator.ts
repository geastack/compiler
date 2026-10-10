import type { CallableAbi, RecordField, Representation } from '../representation/model.js'
import { thrownValueCarrier } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { holdsAbsence, type PairConvertible } from './record-view.js'

/**
 * A program object that implements the iterator protocol by hand, read as the
 * cursor carrier (`iterator`) its declared type names.
 *
 * A stream adapter building `{ next() {...}, return() {...}, throw(err)
 * {...}, [Symbol.asyncIterator]() { return this } }` typed `AsyncGenerator<
 * Buffer> & AsyncDisposable`: the intersection derives to a record, while
 * `AsyncGenerator<Buffer>` alone -- `[Symbol.asyncIterator]`'s own result, and
 * the field it is stored into -- derives to the
 * `async-generator` carrier. The two are one object, so the conversion is a
 * VIEW: the carrier's steps call the same object's own members
 * (`gea_runtime.h`'s `AsyncGenerator::ProtocolSteps`, or
 * `Iterator::ProtocolSteps` for a synchronous iterator object), never a copy of
 * what it held when converted.
 *
 * Only a shared-refcount object qualifies, because only a reference preserves
 * that identity; a by-value record would be a snapshot. Each member the
 * protocol calls must be a callable field whose parameters the call can omit,
 * answering an `IteratorResult`. An async generator's step hands the member's
 * promise straight back, mapped onto its step; a synchronous cursor's step
 * cannot wait for one -- a blocking read inside a callback is the nested pump
 * the runtime refuses -- so a synchronous target admits no promise-answering
 * member. `next` must
 * always be there; `return`/`throw` may be optional members, as
 * `IterableIterator<T>` declares them.
 */
export interface ProtocolIteratorMember {
  readonly key: 'next' | 'return' | 'throw'
  /**
   * How the object says the member is there: always (`required`), or only
   * when its presence bit is set (`flag`, an optional field) and, for an
   * `optional(...)` value, when that holds a payload too. An optional member
   * is asked at every step, never once at conversion: `IterableIterator<T>`'s
   * `return?`/`throw?` may be installed after the cursor is made, and one that
   * is absent when the step runs behaves exactly as a missing member.
   */
  readonly presence: { readonly flag: boolean; readonly payload: boolean }
  readonly abi: CallableAbi
  /** The `IteratorResult` the member answers, after awaiting a promise result. */
  readonly result: Representation
  readonly awaited: boolean
}

export interface ProtocolIteratorPlan {
  readonly source: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
  /**
   * The cursor the object is read as: the synchronous `iterator` (a
   * `Generator`/`IterableIterator`-typed object), or an `async-generator`
   * (a hand-written stream adapter typed `AsyncGenerator<Buffer>`), whose steps hand the
   * member's promise back instead of reading it -- `gea::AsyncGenerator`'s
   * `ProtocolSteps`.
   */
  readonly target: Extract<Representation, { kind: 'iterator' | 'async-generator' }>
  readonly next: ProtocolIteratorMember
  readonly finish: ProtocolIteratorMember | null
  readonly raise: ProtocolIteratorMember | null
}

export interface IteratorResultRecord {
  readonly record: Representation
  readonly value: RecordField
  readonly done: RecordField
  /** Whether a step can find this arm not done (a yielded value) and done (a completion). */
  readonly yields: boolean
  readonly returns: boolean
}

/**
 * The `{ value, done }` records an `IteratorResult` can be: every arm of a
 * union, or the one record. The library's union is told apart the way
 * `record-view.ts`'s `iteratorResultHomes` tells it apart: the return arm
 * REQUIRES `done` (`done: true`), the yield arm leaves it optional (`done?:
 * false`), since boolean literals do not survive structural normalization. A
 * shape with no such split can be either.
 */
export const iteratorResultRecordsOf = (layouts: RecordLayoutPolicy, result: Representation): readonly IteratorResultRecord[] | null => {
  const arms = result.kind === 'tagged-union' ? result.arms.map((arm) => arm.value) : [result]
  const found: { readonly record: Representation; readonly value: RecordField; readonly done: RecordField }[] = []
  for (const arm of arms) {
    const fields = arm.kind === 'record' ? arm.fields : arm.kind === 'native-record-ref' ? layouts.forShape(arm.shapeId) : null
    if (fields === null) return null
    const value = fields.find((field) => field.key === 'value')
    const done = fields.find((field) => field.key === 'done')
    if (value === undefined || done === undefined) return null
    found.push({ record: arm, value, done })
  }
  const split = found.some((arm) => arm.done.required) && found.some((arm) => !arm.done.required)
  return found.map((arm) => ({ ...arm, yields: !split || !arm.done.required, returns: !split || arm.done.required }))
}

const omittable = (abi: CallableAbi, from: number): boolean =>
  abi.parameters.every(
    (parameter, position) =>
      position < from ||
      (abi.restFrom !== null && position >= abi.restFrom ? parameter.value.kind === 'array-object' : holdsAbsence(parameter.value))
  )

const memberOf = (
  layouts: RecordLayoutPolicy,
  fields: readonly RecordField[],
  source: Representation,
  key: ProtocolIteratorMember['key'],
  convertible: PairConvertible
): ProtocolIteratorMember | 'absent' | null => {
  const field = fields.find((candidate) => candidate.key === key)
  if (field === undefined) return 'absent'
  const payload = field.value.kind === 'optional'
  const value = field.value.kind === 'optional' ? field.value.payload : field.value
  // `next` is what makes the object an iterator at all.
  if (key === 'next' && (payload || !field.required)) return null
  if (value.kind !== 'function-value-dispatch') return null
  const abi = value.abi
  if (abi.receiver !== null && !convertible(source, abi.receiver)) return null
  // `throw(e)` hands the thrown value on as its first argument.
  if (key === 'throw') {
    const first = abi.parameters[0]
    if (first === undefined || (abi.restFrom !== null && abi.restFrom === 0) || !convertible(thrownValueCarrier, first.value)) return null
  }
  if (!omittable(abi, key === 'throw' ? 1 : 0)) return null
  const awaited = abi.result.kind === 'promise'
  const result = abi.result.kind === 'promise' ? abi.result.value : abi.result
  if (iteratorResultRecordsOf(layouts, result) === null) return null
  return { key, presence: { flag: !field.required, payload }, abi, result, awaited }
}

export const protocolIteratorPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  convertible: PairConvertible
): ProtocolIteratorPlan | null => {
  if (target.kind !== 'iterator' && target.kind !== 'async-generator') return null
  if ((source.kind !== 'record' && source.kind !== 'native-record-ref') || source.ownership !== 'shared-refcount') return null
  const fields = source.kind === 'record' ? source.fields : layouts.forShape(source.shapeId)
  if (fields === null) return null
  const next = memberOf(layouts, fields, source, 'next', convertible)
  if (next === null || next === 'absent') return null
  const finish = memberOf(layouts, fields, source, 'return', convertible)
  const raise = memberOf(layouts, fields, source, 'throw', convertible)
  if (finish === null || raise === null) return null
  if (target.kind === 'iterator' && [next, finish, raise].some((member) => member !== 'absent' && member.awaited)) return null
  // Every value a step can hand the cursor must reach its carrier: a yielded
  // `value` the element, a done `value` the completion.
  const completionValueless = target.completion.kind === 'void' || target.completion.kind === 'undefined'
  for (const member of [next, raise === 'absent' ? null : raise]) {
    if (member === null) continue
    for (const arm of iteratorResultRecordsOf(layouts, member.result) ?? []) {
      if (arm.yields && !convertible(arm.value.value, target.element)) return null
      if (arm.returns && !completionValueless && !convertible(arm.value.value, target.completion)) return null
    }
  }
  return { source, target, next, finish: finish === 'absent' ? null : finish, raise: raise === 'absent' ? null : raise }
}
