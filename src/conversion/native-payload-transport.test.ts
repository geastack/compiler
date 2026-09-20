import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createConversionNodes } from './nodes.js'
import { nativePayloadTransportMatches } from './native-payload-transport.js'

const record: Representation = { kind: 'record', shapeId: 'slot', ownership: 'shared-refcount', fields: [], accessors: [] }
const reference: Representation = { kind: 'native-record-ref', shapeId: 'slot', ownership: 'shared-refcount', native: null }
const optional = (payload: Representation): Representation => ({ kind: 'optional', payload, absence: 'null' })
const conversions = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })

test('selected native record presence conversions preserve payload origins, including empty initialization', () => {
  const census = conversions()
  for (const payload of [record, reference]) {
    const nullable = optional(payload)
    for (const [source, target] of [
      [payload, payload],
      [payload, nullable],
      [nullable, payload],
      [{ kind: 'null' }, nullable]
    ] as const) {
      assert.ok(nativePayloadTransportMatches(source, target, census.nodeFor(source, target)), `${source.kind} -> ${target.kind}`)
    }
  }
})

test('payload transport requires the cited recipe and a stronger proof than absence of field access', () => {
  const target = optional(reference)
  const node = conversions().nodeFor(reference, target)
  assert.equal(nativePayloadTransportMatches(reference, target, null), false)
  assert.equal(nativePayloadTransportMatches(record, target, node), false)
  assert.equal(nativePayloadTransportMatches(reference, record, node), false)
  assert.ok(node.capability.kind === 'atom')
  const { nativePayloadTransport: _proof, ...unproved } = node.capability.materializer
  for (const materializer of [
    unproved,
    { ...node.capability.materializer, allocates: true },
    { ...node.capability.materializer, nativeFieldProtocol: undefined }
  ]) {
    // Omit an absent optional field rather than constructing an invalid contract.
    const { nativeFieldProtocol, ...rest } = materializer
    assert.equal(
      nativePayloadTransportMatches(reference, target, {
        ...node,
        capability: { ...node.capability, materializer: { ...rest, ...(nativeFieldProtocol ? { nativeFieldProtocol } : {}) } }
      }),
      false
    )
  }
})

test('structural reconstruction and dynamic boundaries do not publish payload transport', () => {
  const census = conversions()
  const otherRecord: Representation = { ...record, shapeId: 'other-slot' }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  for (const [source, target] of [
    [record, otherRecord],
    [record, optional(otherRecord)],
    [reference, dynamic],
    [dynamic, reference]
  ]) {
    assert.ok(source && target)
    assert.equal(nativePayloadTransportMatches(source, target, census.nodeFor(source, target)), false)
  }
})
