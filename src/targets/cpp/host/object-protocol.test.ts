import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../../representation/model.js'

await import('../../../compiler.js')
const { ownEnumerableKeysText } = await import('./object-protocol.js')

const record: Representation = { kind: 'record', shapeId: 'own-key-object', ownership: 'shared-refcount', fields: [], accessors: [] }

test('Object key enumeration checks its native reference before walking the shared own-key protocol', () => {
  for (const member of ['keys', 'getOwnPropertyNames']) {
    const text = ownEnumerableKeysText(
      member,
      { kind: 'known', representation: record, fields: [], receiver: 'read_object()', accessor: '->' },
      member
    )
    assert.equal(text.split('read_object()').length - 1, 1, 'the receiver evaluates once')
    assert.ok(text.includes('static_cast<bool>(gea_once)'))
    assert.ok(text.includes('throwRuntimeError("TypeError", "Cannot convert undefined or null to object")'))
    const helper = member === 'keys' ? 'nativeDynamicKeys' : 'nativeOwnPropertyNames'
    assert.ok(text.indexOf('throwRuntimeError') < text.indexOf(helper))
  }
})

test('a by-value record needs no nullish boundary and a dynamic Object call keeps its runtime ToObject', () => {
  const owned: Representation = { ...record, ownership: 'owned' }
  const text = ownEnumerableKeysText(
    'keys',
    { kind: 'known', representation: owned, fields: [], receiver: 'object', accessor: '.' },
    'keys'
  )
  assert.equal(text.includes('throwRuntimeError'), false)
  assert.equal(
    ownEnumerableKeysText('keys', { kind: 'dynamic', receiver: 'dynamic_object' }, 'keys'),
    'gea::host::ObjectConstructor::keys(dynamic_object)'
  )
})
