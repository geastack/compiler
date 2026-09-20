import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallOperation } from './model.js'
import type { RecordField, Representation } from '../representation/model.js'
import { nativeReflectFieldTransportOf } from './native-reflect-field.js'

test('native Reflect field transport requires exact typed storage and authenticated operation', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const field: RecordField = { key: 'value', value: number, required: true }
  const get = {
    kind: 'call',
    intrinsicReflection: 'get',
    arguments: [],
    result: { id: 'result', representation: number }
  } as unknown as CallOperation
  const set = {
    ...get,
    intrinsicReflection: 'set',
    arguments: [null, null, { value: 'written', representation: number }]
  } as unknown as CallOperation
  assert.equal(nativeReflectFieldTransportOf(get, field), 'native-read')
  assert.equal(nativeReflectFieldTransportOf(set, field), 'native-write')
  const { intrinsicReflection: _intrinsic, ...ordinary } = get
  assert.equal(nativeReflectFieldTransportOf(ordinary, field), null)
  assert.equal(nativeReflectFieldTransportOf({ ...get, argumentsAreSpread: true }, field), null)
  assert.equal(nativeReflectFieldTransportOf(get, { ...field, required: false }), null)
  assert.equal(nativeReflectFieldTransportOf(get, { ...field, value: dynamic }), null)
  assert.equal(nativeReflectFieldTransportOf({ ...get, result: { ...get.result!, representation: dynamic } }, field), null)
  assert.equal(
    nativeReflectFieldTransportOf(
      { ...set, arguments: [...set.arguments.slice(0, 2), { value: 'written' as never, representation: dynamic }] },
      field
    ),
    null
  )
})

test('native property descriptors transport their exact value field without boxing optional source storage', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const descriptor = (value: Representation): Representation => ({
    kind: 'optional',
    absence: 'undefined',
    payload: {
      kind: 'record',
      shapeId: 'descriptor',
      fields: [{ key: 'value', value, required: true }],
      accessors: [],
      ownership: 'shared-refcount'
    }
  })
  const operation = {
    kind: 'call',
    intrinsicReflection: 'getOwnPropertyDescriptor',
    arguments: [],
    result: { id: 'result', representation: descriptor(number) }
  } as unknown as CallOperation
  const field: RecordField = { key: 'detail', value: number, required: false }
  assert.equal(nativeReflectFieldTransportOf(operation, field), 'native-read')
  assert.equal(nativeReflectFieldTransportOf({ ...operation, argumentsAreSpread: true }, field), null)
  assert.equal(nativeReflectFieldTransportOf(operation, { ...field, value: dynamic }), null)
  assert.equal(
    nativeReflectFieldTransportOf({ ...operation, result: { ...operation.result!, representation: descriptor(dynamic) } }, field),
    null
  )
  const { intrinsicReflection: _intrinsic, ...ordinary } = operation
  assert.equal(nativeReflectFieldTransportOf(ordinary, field), null)
})
