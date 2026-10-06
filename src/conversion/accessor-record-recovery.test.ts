import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { unboxedLoadText } from '../targets/cpp/emit-narrowing.js'
import { createConversionNodes } from './nodes.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const target: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'accessor-holder',
  ownership: 'shared-refcount',
  fields: [],
  accessors: [{ key: 'count', getter: 'get-count' as never, setter: null, value: { kind: 'scalar', domain: 'number' } }]
}

test('an accessor record recovers only its authenticated native payload', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(dynamic, target)
  assert.equal(node.capability.kind, 'atom')
  assert.ok(node.capability.kind === 'atom')
  assert.equal(node.capability.classifier.id, 'gea::Value::payloadType')
  assert.equal(node.capability.materializer.id, 'gea::detail::unboxValue')
  assert.equal(node.capability.classifier.domain, node.capability.materializer.domain)
  assert.equal(node.capability.materializer.allocates, false)
  const text = unboxedLoadText(target, 'readOnce()')
  assert.ok(text)
  assert.match(text, /gea::detail::unboxValue/)
  assert.equal(text.split('readOnce()').length - 1, 1)
  assert.doesNotMatch(text, /dynamicRecordHasField|dynamicRecordGetField|gea_get_count/)
})

test('owned and borrowed accessor records still cannot be recovered from a box', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const ownership of ['owned', 'borrowed'] as const) {
    const node = conversions.nodeFor(dynamic, { ...target, ownership })
    assert.equal(node.capability.kind, 'never')
  }
})

test('plain records retain checked product reconstruction', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(dynamic, { ...target, accessors: [], fields: [{ key: 'count', value: { kind: 'scalar', domain: 'number' }, required: true }] })
  assert.equal(node.capability.kind, 'product')
})
