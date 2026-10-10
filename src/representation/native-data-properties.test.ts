import assert from 'node:assert/strict'
import test from 'node:test'
import { declarationId } from '../identity/ids.js'
import type { Representation } from './model.js'
import { binaryToStringTagOf, nativeDataPropertyOf } from './native-data-properties.js'

const tagDeclaration = declarationId('native-data-properties', 0)
const otherDeclaration = declarationId('native-data-properties', 1)
const symbols = new Map([
  [tagDeclaration, 'toStringTag'],
  [otherDeclaration, 'iterator']
])
const buffer: Representation = { kind: 'array-buffer', ownership: 'shared-refcount' }

test('binary tags require the frontend declaration identity, not a member spelling', () => {
  assert.equal(nativeDataPropertyOf(buffer, 'toStringTag', symbols), null)
  assert.equal(nativeDataPropertyOf(buffer, `sym(${otherDeclaration})`, symbols), null)
  assert.equal(nativeDataPropertyOf(buffer, `sym(${tagDeclaration})`), null)
  assert.deepEqual(nativeDataPropertyOf(buffer, `sym(${tagDeclaration})`, symbols), {
    kind: 'to-string-tag',
    result: { kind: 'string' },
    tag: 'ArrayBuffer'
  })
  assert.equal(nativeDataPropertyOf({ kind: 'string' }, `sym(${tagDeclaration})`, symbols), null)
})

test('native geometry retains the actual backing block and does not invent primitive fields', () => {
  const sharedView: Representation = {
    kind: 'typed-array',
    element: 'uint8',
    buffer: 'shared-array-buffer',
    ownership: 'shared-refcount'
  }
  assert.deepEqual(nativeDataPropertyOf(sharedView, 'buffer')?.result, {
    kind: 'shared-array-buffer',
    ownership: 'shared-refcount'
  })
  assert.deepEqual(nativeDataPropertyOf(sharedView, 'length')?.result, { kind: 'scalar', domain: 'number' })
  assert.deepEqual(nativeDataPropertyOf(buffer, 'byteLength')?.result, { kind: 'scalar', domain: 'number' })
  assert.equal(nativeDataPropertyOf(buffer, 'length'), null)
  assert.equal(nativeDataPropertyOf({ kind: 'scalar', domain: 'number' }, 'length'), null)
  assert.equal(binaryToStringTagOf(sharedView), 'Uint8Array')
})
