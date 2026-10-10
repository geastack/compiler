import assert from 'node:assert/strict'
import test from 'node:test'
import { contributesOnlyAbsence, isDeadMergeContribution, type Representation } from './model.js'

const ref: Representation = { kind: 'native-record-ref', native: null, shapeId: 'node', ownership: 'shared-refcount' }

test('an optional native record contributes only its tagged absence to the falsy logical arm', () => {
  const source: Representation = { kind: 'optional', payload: ref, absence: 'undefined' }
  assert.equal(isDeadMergeContribution(source), true)
  assert.equal(contributesOnlyAbsence(source), true)
  assert.equal(isDeadMergeContribution(ref), false)
  assert.equal(contributesOnlyAbsence(ref), true)
})

test('tagged native object arms cannot supply a falsy payload while primitive arms remain live', () => {
  const sum = (values: Representation[]): Representation => ({
    kind: 'tagged-union',
    arms: values.map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  })
  const record: Representation = { kind: 'record', shapeId: 'record', fields: [], accessors: [], ownership: 'shared-refcount' }
  const indexed: Representation = { kind: 'record-with-index', shapeId: 'indexed', fields: [], indexes: [], ownership: 'shared-refcount' }
  for (const payload of [ref, record, indexed]) {
    assert.equal(isDeadMergeContribution({ kind: 'optional', payload, absence: 'undefined' }), true)
    assert.equal(isDeadMergeContribution(payload), false)
  }
  assert.equal(isDeadMergeContribution(sum([ref, { kind: 'undefined' }])), false)
  assert.equal(contributesOnlyAbsence(sum([ref, { kind: 'undefined' }])), false)
  assert.equal(contributesOnlyAbsence({ kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }), false)
})
