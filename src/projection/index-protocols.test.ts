import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../identity/ids.js'
import type { PhysicalClassLayout } from './classes.js'
import { classIndexProtocolsOf } from './index-protocols.js'

const layout = (name: string, base: string | null): PhysicalClassLayout => ({
  declaration: name as DeclarationId,
  base: base as DeclarationId | null,
  nativeBase: null,
  instance: { kind: 'class-ref', declaration: name as DeclarationId, shapeId: name, ownership: 'owned', ancestors: [] }
})

const classes = new Map(
  [layout('leaf', 'root'), layout('sibling', 'root'), layout('root', null), layout('separate', null)].map((value) => [
    value.declaration,
    value
  ])
)

test('a closed family without index storage omits the whole index protocol', () => {
  const result = classIndexProtocolsOf(classes, () => ({ fields: [], indexes: [] }))
  assert.deepEqual([...result.values()], [false, false, false, false])
})

test('a descendant index store retains virtual support on ancestors and siblings only', () => {
  const result = classIndexProtocolsOf(classes, (shape) => ({
    fields: [],
    indexes: shape === 'leaf' ? [{ key: 'string', value: { kind: 'string' } }] : []
  }))
  assert.deepEqual([...result.values()], [true, true, true, false])
})

test('missing shape evidence retains the entire affected family', () => {
  const result = classIndexProtocolsOf(classes, (shape) => (shape === 'leaf' ? null : { fields: [], indexes: [] }))
  assert.deepEqual([...result.values()], [true, true, true, false])
})

test('missing base evidence cannot prove index support absent', () => {
  const orphan = layout('orphan', 'missing')
  const result = classIndexProtocolsOf(new Map([[orphan.declaration, orphan]]), () => ({ fields: [], indexes: [] }))
  assert.equal(result.get(orphan.declaration), true)
})

test('an unavailable instance layout cannot prove index support absent', () => {
  const result = classIndexProtocolsOf(new Map([['external' as DeclarationId, { instance: null, base: null, nativeBase: null }]]), () => ({
    fields: [],
    indexes: []
  }))
  assert.equal(result.get('external' as DeclarationId), true)
})
