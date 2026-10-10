import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import type { ConvertOperation } from './model.js'
import { convertCarriersOf } from './convert-carriers.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const array = (element: Representation): Representation => ({
  kind: 'array-object',
  element,
  ownership: 'shared-refcount',
  extension: null
})
const operation = (source: Representation, target: Representation, rebuild?: 'unshared-array') =>
  ({ source: { representation: source }, result: { representation: target }, rebuild }) as ConvertOperation

test('ordinary conversions authenticate their complete carriers', () => {
  const source = array(dynamic)
  const target = array(number)
  assert.deepEqual(convertCarriersOf(operation(source, target)), { source, target })
})

test('fresh array rebuilds authenticate the cited element conversion', () => {
  assert.deepEqual(convertCarriersOf(operation(array(dynamic), array(number), 'unshared-array')), { source: dynamic, target: number })
})

test('a rebuild cannot claim freshness for a scalar or asymmetric promise', () => {
  assert.equal(convertCarriersOf(operation(number, array(number), 'unshared-array')), null)
  assert.equal(convertCarriersOf(operation(array(dynamic), number, 'unshared-array')), null)
  assert.equal(convertCarriersOf(operation({ kind: 'promise', value: array(dynamic) }, array(number), 'unshared-array')), null)
})

test('pending fresh arrays cite the conversion applied after fulfillment', () => {
  assert.deepEqual(
    convertCarriersOf(operation({ kind: 'promise', value: array(dynamic) }, { kind: 'promise', value: array(number) }, 'unshared-array')),
    { source: dynamic, target: number }
  )
})
