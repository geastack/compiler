import type { CallableAbi, RecordField, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { iteratorResultRecordsOf, type IteratorResultRecord } from './protocol-iterator.js'
import type { PairConvertible } from './record-view.js'

/**
 * A native cursor (`iterator`) read as the iterator OBJECT an interface
 * declares -- `IterableIterator<T>`, `Iterator<T>`, `IteratorObject<T>` --
 * the reverse of `protocol-iterator.ts`. An async generator
 * (`async-generator`) is read the same way as an `AsyncIterator<T>` /
 * `AsyncIterableIterator<T>`: its `next` hands the generator's own step
 * promise back, mapped onto the record, and so can only fill an awaited
 * `next`.
 *
 * A `URLSearchParams` written in TypeScript implements `keys()` as a generator behind an
 * `IterableIterator<string>` overload, so its call result is the cursor
 * (`semantics/normalize/physical-overload-result.ts`), while
 * a library subclass may override it as `keys():
 * IterableIterator<K> { return super.keys() as IterableIterator<K> }`: an
 * interface result, which derives to a record, built from a cursor.
 *
 * The record is a VIEW, not a snapshot: its `next` steps one shared cursor, so
 * a step taken through any copy of the record is seen by every other, and a
 * source that re-reads its storage (a generator over live arrays) still does.
 * `[Symbol.iterator]()` answers the same record, which is what
 * `%IteratorPrototype%[@@iterator]` and a generator's own `@@iterator` return
 * -- never a second view of the cursor.
 *
 * `return`/`throw` are carried only as ABSENT: a sequence cursor
 * (`%ArrayIteratorPrototype%` and its siblings) has neither, and a generator
 * source's would need the cursor's abrupt-resume steps as members, which no
 * program has asked for yet; a target that REQUIRES either is refused.
 *
 * `next`'s argument is ignored, which is exact for every cursor this admits:
 * a sequence cursor never reads it, and a cursor whose `resume` carrier is
 * `undefined` has no resume channel a generator body could read (see the
 * `iterator` kind's own comment in `model.ts`). A cursor with a real resume
 * carrier is refused.
 */
export interface IteratorObjectViewPlan {
  readonly source: Extract<Representation, { kind: 'iterator' | 'async-generator' }>
  readonly target: Extract<Representation, { kind: 'record' | 'native-record-ref' }>
  /** The target's fields, in its layout order, each with what fills it. */
  readonly fields: readonly IteratorObjectViewField[]
}

export type IteratorObjectViewField =
  | {
      readonly kind: 'next'
      readonly field: RecordField
      readonly abi: CallableAbi
      /** The `IteratorResult` arms `next` builds: one that yields and one that completes. */
      readonly yieldArm: IteratorResultArm
      readonly returnArm: IteratorResultArm
      /**
       * The `IteratorResult` union the arms are positioned in: `abi.result`
       * itself, or -- for an `AsyncIterator` -- the promise's payload, which
       * `next` answers settled.
       */
      readonly settled: Representation
      /** Whether `next` answers a promise of the record (`AsyncIterator<T>`), not the record. */
      readonly awaited: boolean
    }
  | { readonly kind: 'self'; readonly field: RecordField; readonly abi: CallableAbi }
  | { readonly kind: 'absent'; readonly field: RecordField }

export interface IteratorResultArm {
  /** The arm's position in a sum result, or `null` when the result is the one record. */
  readonly index: number | null
  readonly record: IteratorResultRecord
}

const trace = (source: Representation, target: Representation, why: string): null => {
  if (process.env['GEA_ITERATOR_VIEW_DEBUG'])
    console.log(`[ITERATOR-VIEW] ${representationKey(source)} -> ${representationKey(target)}: ${why}`)
  return null
}

const armOf = (records: readonly IteratorResultRecord[], result: Representation, role: 'yields' | 'returns'): IteratorResultArm | null => {
  // One arm per role: two arms `done` cannot tell apart would leave the step
  // choosing between them by guess.
  const fitting = records.flatMap((record, index) => (record[role] ? [index] : []))
  if (fitting.length !== 1) return null
  const chosen = fitting[0]!
  const record = records[chosen]!
  if (record.record.kind !== 'record' && record.record.kind !== 'native-record-ref') return null
  return { index: result.kind === 'tagged-union' ? chosen : null, record }
}

export const iteratorObjectViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  convertible: PairConvertible
): IteratorObjectViewPlan | null => {
  if (source.kind !== 'iterator' && source.kind !== 'async-generator') return null
  if (target.kind !== 'record' && target.kind !== 'native-record-ref') return null
  if (target.kind === 'native-record-ref' && target.native !== null) return null
  // `[Symbol.iterator]()` answers the record itself, and only a reference
  // carries that identity.
  if (target.ownership !== 'shared-refcount') return trace(source, target, 'target is not a shared record')
  if (target.kind === 'record' && target.accessors.length !== 0) return trace(source, target, 'target has accessors')
  if (source.resume.kind !== 'undefined' && source.resume.kind !== 'void') return trace(source, target, 'cursor has a resume channel')
  const fields = target.kind === 'record' ? target.fields : layouts.forShape(target.shapeId)
  if (fields === null) return trace(source, target, 'target layout unknown')
  const planned: IteratorObjectViewField[] = []
  let sawNext = false
  let asyncView: boolean | null = null
  for (const field of fields) {
    const value = field.value.kind === 'optional' ? field.value.payload : field.value
    if (field.key === 'next') {
      if (value.kind !== 'function-value-dispatch') return trace(source, target, 'next is not a callable member')
      const abi = value.abi
      if (abi.receiver !== null && !convertible(target, abi.receiver)) return trace(source, target, 'next takes a foreign receiver')
      // `AsyncIterator<T>.next` answers `Promise<IteratorResult<T>>`. A sync
      // cursor's step is handed back settled; an async generator's step is
      // itself a promise, so only an awaited `next` can carry it.
      const awaited = abi.result.kind === 'promise'
      if (source.kind === 'async-generator' && !awaited) return trace(source, target, 'an async generator cannot answer a settled next')
      const settled = abi.result.kind === 'promise' ? abi.result.value : abi.result
      const records = iteratorResultRecordsOf(layouts, settled)
      if (records === null) return trace(source, target, `next answers no IteratorResult: ${representationKey(abi.result)}`)
      if (asyncView !== null && asyncView !== awaited) return trace(source, target, 'next mixes a settled and an awaited result')
      asyncView = awaited
      const yieldArm = armOf(records, settled, 'yields')
      const returnArm = armOf(records, settled, 'returns')
      if (yieldArm === null || returnArm === null) return trace(source, target, 'IteratorResult has no distinct yield/return arm')
      if (!convertible(source.element, yieldArm.record.value.value))
        return trace(source, target, `element ${representationKey(source.element)} does not reach the yielded value`)
      // A completion the cursor carries no value for is `undefined`.
      const completion = source.completion.kind === 'void' ? { kind: 'undefined' as const } : source.completion
      if (!convertible(completion, returnArm.record.value.value))
        return trace(source, target, `completion does not reach ${representationKey(returnArm.record.value.value)}`)
      planned.push({ kind: 'next', field, abi, yieldArm, returnArm, settled, awaited })
      sawNext = true
      continue
    }
    const symbol = layouts.wellKnownSymbolOfKey?.(field.key) ?? null
    if (symbol === 'iterator' || symbol === 'asyncIterator') {
      // `@@iterator` belongs to a sync iterator object and `@@asyncIterator`
      // to an async one (`AsyncIterableIterator<T>`); `next`'s result, read in
      // any order against this, says which the target is.
      const awaited = symbol === 'asyncIterator'
      if (asyncView !== null && asyncView !== awaited) return trace(source, target, `@${symbol} on the other protocol's object`)
      if (source.kind === 'async-generator' && !awaited) return trace(source, target, '@@iterator on an async generator')
      asyncView = awaited
      if (value.kind !== 'function-value-dispatch') return trace(source, target, '@@iterator is not a callable member')
      const abi = value.abi
      // The member answers `this`. Declared as a method it receives the record
      // and hands it back; declared with no receiver (an interface method
      // signature's ordinary convention) nothing but the record itself can
      // ever reach it, so the member holds the record it lives in.
      if (abi.receiver !== null && representationKey(abi.receiver) !== representationKey(target))
        return trace(source, target, `@@iterator takes a foreign receiver: ${representationKey(abi.receiver)}`)
      if (
        abi.parameters.some((parameter) => parameter.value.kind !== 'undefined' && parameter.value.kind !== 'void' && abi.restFrom === null)
      )
        return trace(source, target, '@@iterator declares parameters')
      if (!convertible(target, abi.result)) return trace(source, target, '@@iterator result is not the record')
      planned.push({ kind: 'self', field, abi })
      continue
    }
    if ((field.key === 'return' || field.key === 'throw') && !field.required) {
      planned.push({ kind: 'absent', field })
      continue
    }
    return trace(source, target, `field ${field.key} has no cursor answer`)
  }
  if (!sawNext) return trace(source, target, 'target declares no next')
  return { source, target, fields: planned }
}
