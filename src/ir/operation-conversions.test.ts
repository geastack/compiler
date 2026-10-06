import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { IrOperation } from './model.js'
import { operationConversionInputsOf, operationConversionsMatch, operationConversionsOf } from './operation-conversions.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const operand = (representation: Representation) => ({ value: 'operand' as never, representation })
const result = (representation: Representation) => ({ id: 'result' as never, representation })
const deriver = {} as RepresentationDeriver

test('union dictionary reads certify each physical value into the optional payload', () => {
  const receiver = sum(
    { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' },
    { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' }
  )
  const payload = sum(number, string)
  const operation: IrOperation = {
    kind: 'get',
    lineage: 'read' as never,
    receiver: operand(receiver),
    key: operand(string),
    result: result({ kind: 'optional', payload, absence: 'undefined' })
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.deepEqual(inputs.map((input) => input.role), ['index-read', 'index-read'])
  assert.ok(inputs.every((input) => representationKey(input.target) === representationKey(payload)))
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(operationConversionsMatch(inputs, recipes, census), true)
  assert.equal(operationConversionsMatch(inputs, recipes.slice(1), census), false)
  assert.equal(operationConversionsMatch(inputs, recipes.map((recipe) => ({ ...recipe, role: 'descriptor' })), census), false)
  assert.equal(operationConversionsMatch(inputs, recipes.map((recipe) => ({ ...recipe, target: dynamic })), census), false)
})

test('strict equality certifies only genuinely dynamic comparisons that need value transport', () => {
  const operation: IrOperation = {
    kind: 'compute',
    lineage: 'compare' as never,
    form: 'equality',
    operator: '===',
    operands: [operand(sum(dynamic, number)), operand(string)],
    result: result({ kind: 'scalar', domain: 'boolean' })
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.role, 'equality')
  assert.equal(inputs[0]?.source, string)
  assert.equal(inputs[0]?.target, dynamic)
  assert.equal(
    operationConversionInputsOf({ ...operation, nativeEquality: { dynamicOperand: 0, primitive: 'string', negate: false } }, null, deriver, new Map()).length,
    0
  )
})

test('an indexed native descriptor cites its held value separately from the incoming operand', () => {
  const receiver: Representation = {
    kind: 'record-with-index',
    shapeId: 'indexed',
    ownership: 'shared-refcount',
    fields: [],
    indexes: [{ key: 'string', value: sum(number, string) }]
  }
  const operation: IrOperation = {
    kind: 'define-own-property',
    lineage: 'define' as never,
    receiver: operand(receiver),
    key: operand(string),
    value: operand(number),
    attributes: { writable: true, enumerable: true, configurable: true },
    result: null
  }
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map())
  const descriptor = inputs.find((input) => input.role === 'descriptor')
  assert.ok(descriptor)
  assert.equal(descriptor.source, receiver.indexes[0]?.value)
  assert.equal(descriptor.target, dynamic)
})
