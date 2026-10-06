import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { certifiedRecordViewPlan, recordToArrayPlan, structuralConversionKey, type AcceptedConversion } from './structural-plan.js'
import type { Representation } from '../representation/model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const proof = (source: Representation, target: Representation): ConversionNode => ({
  id: structuralConversionKey(source, target),
  source,
  target,
  capability:
    structuralConversionKey(source, source) === structuralConversionKey(source, target)
      ? { kind: 'identity' }
      : { kind: 'static', materializer: { id: 'test:native-leaf', domain: 'test:native-leaf', allocates: false } }
})
const identity: AcceptedConversion = (source, target) => {
  const node = proof(source, target)
  return node.capability.kind === 'identity' ? node : null
}
const record = (values: readonly Representation[]): Extract<Representation, { kind: 'record' }> => ({
  kind: 'record',
  shapeId: 'tuple',
  ownership: 'owned',
  fields: values.map((value, index) => ({ key: String(index), value, required: true })),
  accessors: []
})
const array = (element: Representation): Extract<Representation, { kind: 'array-object' }> => ({
  kind: 'array-object',
  ownership: 'shared-refcount',
  element,
  extension: null
})

test('tuple materialization carries the exact accepted conversion for each field', () => {
  const source = record([number, dynamic])
  const target = array(dynamic)
  const nodes = [proof(number, dynamic), proof(dynamic, dynamic)]
  const plan = recordToArrayPlan(
    source,
    target,
    (from, into) => nodes.find((node) => node.id === structuralConversionKey(from, into)) ?? null
  )
  assert.ok(plan)
  assert.deepEqual(
    plan.fields.map((field) => field.conversion),
    nodes
  )
  assert.equal(plan.fields[0]?.conversion, nodes[0])
  assert.equal(plan.source, source)
  assert.equal(plan.target, target)
})

test('tuple materialization refuses a leaf the authority rejects', () => {
  assert.equal(recordToArrayPlan(record([number, string]), array(number), identity), null)
})

test('tuple materialization refuses gaps, empty storage and borrowed output', () => {
  const source = record([number])
  assert.equal(recordToArrayPlan({ ...source, fields: [{ key: '1', value: number, required: true }] }, array(number), identity), null)
  assert.equal(recordToArrayPlan(record([]), array(number), identity), null)
  assert.equal(recordToArrayPlan(source, { ...array(number), ownership: 'borrowed' }, identity), null)
})

test('structural view seals only the chosen field conversion and preserves its identity proof', () => {
  const source = record([number])
  const target: Representation = { ...source, shapeId: 'other-layout' }
  const leaf = proof(number, number)
  const plan = certifiedRecordViewPlan({ forShape: () => null }, source, target, (from, into) =>
    leaf.id === structuralConversionKey(from, into) ? leaf : null
  )
  assert.ok(plan)
  assert.equal(plan.view.kind, 'fields')
  assert.equal(plan.leaves.size, 1)
  assert.equal(plan.leaves.get(leaf.id), leaf)
})

test('structural view never accepts a never-node returned as a leaf proof', () => {
  const source = record([number])
  const target: Representation = { ...source, shapeId: 'other-layout' }
  assert.equal(
    certifiedRecordViewPlan({ forShape: () => null }, source, target, (from, into) => ({
      id: structuralConversionKey(from, into),
      source: from,
      target: into,
      capability: { kind: 'never', reason: 'test refusal' }
    })),
    null
  )
})

test('tuple materialization rejects a leaf proof for different carriers', () => {
  assert.throws(() => recordToArrayPlan(record([number]), array(number), () => proof(string, number)), /different carriers/)
})
