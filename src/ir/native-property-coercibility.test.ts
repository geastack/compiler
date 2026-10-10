import assert from 'node:assert/strict'
import test from 'node:test'
import { nativePropertyReadNeedsCoercibility } from './native-property-coercibility.js'
import type { Representation } from '../representation/model.js'

const receiver: Representation = {
  kind: 'class-ref',
  declaration: 'receiver' as never,
  shapeId: 'receiver',
  ownership: 'shared-refcount',
  ancestors: []
}
const callable: Representation = {
  kind: 'function-value-dispatch',
  abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'string' } }
}
test('native callable and optimized method-presence reads retain their property coercibility', () => {
  assert.equal(nativePropertyReadNeedsCoercibility(receiver, callable), true)
  assert.equal(nativePropertyReadNeedsCoercibility({ kind: 'optional', payload: receiver, absence: 'undefined' }, callable), true)
  assert.equal(nativePropertyReadNeedsCoercibility(receiver, { kind: 'scalar', domain: 'boolean' }, true), true)
  assert.equal(nativePropertyReadNeedsCoercibility(receiver, { kind: 'string' }), false)
  assert.equal(nativePropertyReadNeedsCoercibility({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, callable), false)
})
