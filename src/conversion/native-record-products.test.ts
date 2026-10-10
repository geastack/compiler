import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import { nativeRecordProductsOf } from './native-record-products.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { Representation } from '../representation/model.js'

const source: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'source',
  ownership: 'owned',
  accessors: [],
  fields: [{ key: '$type', value: { kind: 'string' }, required: true }]
}
const target: Extract<Representation, { kind: 'record' }> = { ...source, shapeId: 'target', ownership: 'shared-refcount' }
const nodes = createConversionNodes({
  nodes: new Map(),
  registry: createCppConversionRegistry()
})

test('a sealed owned product publishes its newly allocated physical descriptor', () => {
  const node = nodes.nodeFor(source, target)
  assert.notEqual(node.capability.kind, 'never')
  const products = nativeRecordProductsOf(node)
  assert.equal(products.length, 1)
  assert.equal(products[0]?.source, source)
  assert.equal(products[0]?.target, target)
  assert.deepEqual(products[0]?.fields, [{ key: '$type', identity: true }])
})

test('a shared live projection retains its original allocation rather than nominating target cells', () => {
  const shared = { ...source, ownership: 'shared-refcount' as const }
  const node = nodes.nodeFor(shared, target)
  assert.notEqual(node.capability.kind, 'never')
  assert.deepEqual(nativeRecordProductsOf(node), [])
})

test('an owned product does not transport a stored origin through a converted field', () => {
  const wrapped: Extract<Representation, { kind: 'record' }> = {
    ...target,
    shapeId: 'wrapped-target',
    fields: [{ key: '$type', value: { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }, required: true }]
  }
  const node = nodes.nodeFor(source, wrapped)
  assert.notEqual(node.capability.kind, 'never')
  assert.deepEqual(nativeRecordProductsOf(node)[0]?.fields, [{ key: '$type', identity: false }])
})
