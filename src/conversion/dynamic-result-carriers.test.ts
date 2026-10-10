import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { dynamicResultCarriersOf } from './dynamic-result-carriers.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const record: Representation = { kind: 'record', shapeId: 'normal-object', fields: [], accessors: [], ownership: 'shared-refcount' }
const proxy: Representation = { kind: 'proxy-object', target: record, handler: record }
const sum: Representation = {
  kind: 'tagged-union',
  arms: [record, proxy].map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
}
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })

test('the exact installed dynamic union reader admits only its executable destinations', () => {
  const conversions = censusOf()
  const node = conversions.nodeFor(dynamic, sum)
  const destinations = dynamicResultCarriersOf(node, conversions.nodeById)
  assert.ok(destinations)
  assert.equal(destinations.length, 1)
  assert.equal(destinations[0], record)
  assert.ok('materializer' in node.capability && node.capability.materializer.dynamicWrapper?.kind === 'union')
  assert.equal(node.capability.materializer.dynamicWrapper.arms[0]?.conversion.target, record)
  assert.equal(conversions.nodeFor(dynamic, proxy).capability.kind, 'never')
})

test('a forged selected arm and an unrelated or uninstalled child supply no narrowed unknown domain', () => {
  const conversions = censusOf()
  const node = conversions.nodeFor(dynamic, sum)
  assert.ok('materializer' in node.capability && node.capability.materializer.dynamicWrapper?.kind === 'union')
  const wrapper = node.capability.materializer.dynamicWrapper
  const changed = {
    ...node,
    capability: {
      ...node.capability,
      materializer: {
        ...node.capability.materializer,
        dynamicWrapper: { ...wrapper, arms: wrapper.arms.map((arm) => ({ ...arm, index: 1 })) }
      }
    }
  }
  assert.equal(
    dynamicResultCarriersOf(changed, (id) => (id === changed.id ? changed : conversions.nodeById(id))),
    null
  )
  assert.equal(
    dynamicResultCarriersOf(node, (id) => (id === wrapper.arms[0]?.conversion.id ? null : conversions.nodeById(id))),
    null
  )
  assert.equal(dynamicResultCarriersOf(conversions.nodeFor(dynamic, proxy), conversions.nodeById), null)
  assert.equal(dynamicResultCarriersOf(conversions.nodeFor(sum, sum), conversions.nodeById), null)
})

test('an equal-element native array envelope retains its selected normal destination beside an unavailable Proxy arm', () => {
  const conversions = censusOf()
  const array: Representation = { kind: 'array-object', element: dynamic, ownership: 'shared-refcount', extension: null }
  const target: Representation = {
    kind: 'tagged-union',
    arms: sum.arms.map((arm, index) => ({ ...arm, value: index === 0 ? array : proxy }))
  }
  const node = conversions.nodeFor(dynamic, target)
  assert.deepEqual(dynamicResultCarriersOf(node, conversions.nodeById), [array])
  assert.ok('materializer' in node.capability && node.capability.materializer.dynamicWrapper?.kind === 'union')
  const selected = node.capability.materializer.dynamicWrapper.arms[0]?.conversion
  assert.ok(selected && 'materializer' in selected.capability && selected.capability.materializer.nativeArrayView)
  assert.equal(selected.capability.materializer.nativeArrayView.read.capability.kind, 'identity')
})
