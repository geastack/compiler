import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { nativeEnumerationPlanOf } from './native-enumeration.js'
import { enumerateGetIteratorCarrierKeyOf } from './certify/carrier-keys.js'

const record: Representation = { kind: 'record', shapeId: 'row', fields: [], accessors: [], ownership: 'shared-refcount' }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})

test('native enumeration retains nested record alternatives and skips either absence', () => {
  const source: Representation = { kind: 'optional', absence: 'undefined', payload: sum(record, { kind: 'null' }) }
  assert.deepEqual(nativeEnumerationPlanOf(source), {
    kind: 'optional',
    present: { kind: 'union', arms: [{ kind: 'fields' }, { kind: 'empty' }] }
  })
  assert.equal(enumerateGetIteratorCarrierKeyOf(source.kind, source), 'native-sum')
  assert.deepEqual(nativeEnumerationPlanOf({ kind: 'null' }), { kind: 'empty' })
  assert.deepEqual(nativeEnumerationPlanOf({ kind: 'undefined' }), { kind: 'empty' })
})

test('one unproven field protocol prevents the entire native enumeration claim', () => {
  const unproven: Representation[] = [
    { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    { ...record, ownership: 'owned' },
    { kind: 'native-record-ref', shapeId: 'host-row', native: 'HostRow', ownership: 'shared-refcount' }
  ]
  for (const unsupported of unproven) {
    const source: Representation = { kind: 'optional', absence: 'null', payload: sum(record, unsupported) }
    assert.equal(nativeEnumerationPlanOf(source), null)
    assert.notEqual(enumerateGetIteratorCarrierKeyOf(source.kind, source), 'native-sum')
  }
  assert.equal(nativeEnumerationPlanOf(sum()), null)
})
