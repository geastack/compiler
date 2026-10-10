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
  assert.equal(node.capability.materializer.nativeAccessorPayload, 'preserved')
  assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
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

test('plain records retain checked live Document field reads instead of borrowing accessor payload identity', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(dynamic, {
    ...target,
    accessors: [],
    fields: [{ key: 'count', value: { kind: 'scalar', domain: 'number' }, required: true }]
  })
  assert.ok('materializer' in node.capability)
  assert.equal(node.capability.materializer.nativeAccessorPayload, undefined)
  const plan = node.capability.materializer.documentRecordView
  assert.ok(plan?.step.kind === 'document' && plan.step.payload.kind === 'view')
  assert.equal(plan.step.conversion, conversions.nodeFor(dynamic, plan.step.payload.view.source))
  const field = plan.step.payload.view.fields[0]!
  assert.equal(field.read, conversions.dictionaryReadFor(dynamic, { kind: 'scalar', domain: 'number' }))
  assert.deepEqual(field.write, { kind: 'conversion', conversion: conversions.nodeFor({ kind: 'scalar', domain: 'number' }, dynamic) })
  assert.equal('materializer' in field.read.capability && field.read.capability.materializer.executesSourceGuard, true)
  assert.equal(node.capability.materializer.nativeFieldViewProtocol, 'live')
})

test('an opaque accessor layout retains its exact native payload contract through optional absence', () => {
  const layouts = {
    indexesForShape: () => [],
    forShape: () => [],
    plainFieldsForShape: () => [],
    accessorsForShape: () => target.accessors
  }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const named: Representation = {
    kind: 'native-record-ref',
    shapeId: target.shapeId,
    ownership: 'shared-refcount',
    native: null
  }
  const node = conversions.nodeFor(dynamic, named)
  assert.equal(node.capability.kind, 'atom')
  assert.ok(node.capability.kind === 'atom')
  assert.equal(node.capability.materializer.nativeAccessorPayload, 'preserved')
  assert.equal(node.capability.materializer.documentRecordView, undefined)
  const wrapped = conversions.nodeFor(dynamic, { kind: 'optional', payload: named, absence: 'undefined' })
  assert.equal(wrapped.capability.kind, 'optional')
  assert.ok(wrapped.capability.kind === 'optional' && wrapped.capability.payload.kind === 'atom')
  assert.equal(wrapped.capability.payload.materializer.nativeAccessorPayload, 'preserved')
  for (const carrier of [
    { kind: 'dictionary' as const, key: 'string' as const, value: dynamic, ownership: 'shared-refcount' as const },
    {
      kind: 'record-with-index' as const,
      fields: [],
      indexes: [{ key: 'string' as const, value: dynamic }],
      shapeId: 'table',
      ownership: 'shared-refcount' as const
    }
  ]) {
    const pair = createCppConversionRegistry().boxedIdentityMaterializer(carrier)
    assert.equal(
      pair?.materializer.nativeAccessorPayload,
      undefined,
      'aliasing or allocating unbox implementations have no accessor identity proof'
    )
  }
})
