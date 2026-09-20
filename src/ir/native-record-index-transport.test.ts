import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { IrOperation } from './model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { nativeRecordIndexHasPropertyOf, nativeRecordIndexTransportOf } from './native-record-index-transport.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const symbol: Representation = { kind: 'symbol' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const receiver: Representation = {
  kind: 'record-with-index',
  shapeId: 'indexed',
  ownership: 'shared-refcount',
  fields: [{ key: 'label', value: string, required: true }],
  indexes: [{ key: 'symbol', value: number }]
}
const deriver = { layoutOf: () => receiver } as unknown as RepresentationDeriver
const operation = (kind: string, value: Representation = number, key: Representation = symbol, target = receiver): IrOperation =>
  ({
    kind,
    receiver: { value: 'receiver', representation: target },
    key: { value: 'key', representation: key },
    value: { value: 'value', representation: value },
    result: { id: 'result', representation: value },
    attributes: { writable: true, configurable: true, enumerable: true }
  }) as unknown as IrOperation

test('typed disjoint index operations do not demand fixed-field reflection', () => {
  for (const kind of ['get', 'set', 'define-own-property', 'delete', 'has-property']) {
    assert.equal(nativeRecordIndexTransportOf(operation(kind), deriver, undefined, null), true, kind)
  }
  assert.equal(
    nativeRecordIndexTransportOf(operation('get', { kind: 'optional', payload: number, absence: 'undefined' }), deriver, undefined, null),
    true
  )
  assert.equal(nativeRecordIndexTransportOf(operation('get'), null, undefined, null), false)
  assert.equal(nativeRecordIndexTransportOf(operation('set', dynamic), deriver, undefined, null), false)
  assert.equal(nativeRecordIndexTransportOf(operation('get', dynamic), deriver, undefined, null), false)
  assert.equal(
    nativeRecordIndexTransportOf(
      operation('get', number, string, { ...receiver, indexes: [{ key: 'string', value: number }] }),
      deriver,
      undefined,
      null
    ),
    false
  )
})

test('index adapters require the installed native payload conversion', () => {
  const nullable: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const stored: Representation = { ...receiver, indexes: [{ key: 'symbol', value: nullable }] }
  const write = operation('set', number, symbol, stored)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(nativeRecordIndexTransportOf(write, deriver, census, null), false)
  const selected = census.nodeFor(number, nullable)
  assert.equal(nativeRecordIndexTransportOf(write, deriver, census, null), true)
  assert.equal(nativeRecordIndexTransportOf(write, deriver, { nodeById: () => ({ ...selected, source: string }) }, null), false)
})

test('indexed presence requires native shared ownership and a disjoint key domain', () => {
  assert.equal(nativeRecordIndexHasPropertyOf(deriver, receiver, symbol), true)
  const numeric: Representation = { ...receiver, indexes: [{ key: 'number', value: number }] }
  assert.equal(nativeRecordIndexHasPropertyOf(deriver, numeric, number), true)
  assert.equal(
    nativeRecordIndexHasPropertyOf(deriver, { ...numeric, fields: [{ key: '1', value: string, required: true }] }, number),
    false
  )
  assert.equal(nativeRecordIndexHasPropertyOf(deriver, { ...receiver, ownership: 'owned' }, symbol), false)
  assert.equal(nativeRecordIndexHasPropertyOf(deriver, receiver, dynamic), false)
  assert.equal(nativeRecordIndexHasPropertyOf(deriver, receiver, string), false)
})
