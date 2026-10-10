import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { structuralConversionKey } from '../conversion/structural-plan.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { SpreadCopyOperation } from './model.js'
import { spreadCopyConversionPlanMatches, spreadCopyConversionPlanOf } from './spread-conversions.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const operand = (representation: Representation) => ({ value: 'value' as never, representation })
const copy = (source: Representation, receiver: Representation): SpreadCopyOperation => ({
  kind: 'spread-copy',
  lineage: 'copy' as never,
  source: operand(source),
  receiver: operand(receiver)
})

test('a class spread seals optional field transport and its admitted creation-order frame', () => {
  const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
  const fields = [{ key: 'tag', value: optional, required: false }]
  const source: Representation = {
    kind: 'class-ref',
    declaration: 'point' as never,
    shapeId: 'point',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const target: Representation = { kind: 'dictionary', key: 'string', value: dynamic, ownership: 'shared-refcount' }
  const deriver = {
    layoutOf: () => ({ kind: 'record', shapeId: 'point', ownership: 'shared-refcount', fields, accessors: [] })
  } as unknown as RepresentationDeriver
  const census = createConversionNodes({
    registry: createCppConversionRegistry({ indexesForShape: () => [], accessorsForShape: () => [], forShape: () => fields }),
    nodes: new Map()
  })
  const operation = copy(source, target)
  const plan = spreadCopyConversionPlanOf(operation, deriver, census)
  assert.equal(plan.leaves.get(structuralConversionKey(optional, dynamic)), census.nodeFor(optional, dynamic))
  assert.equal(plan.leaves.get(structuralConversionKey(dynamic, dynamic)), census.nodeFor(dynamic, dynamic))
  assert.equal(plan.walks.size, 1)
  assert.equal(spreadCopyConversionPlanMatches(operation, plan, deriver, census), true)
  assert.equal(spreadCopyConversionPlanMatches(operation, { ...plan, leaves: new Map() }, deriver, census), false)
  assert.equal(spreadCopyConversionPlanMatches(operation, { ...plan, walks: new Set() }, deriver, census), false)
})

test('an unsupported optional walk does not become a mandatory spread conversion', () => {
  const source: Representation = {
    kind: 'record',
    shapeId: 'source',
    ownership: 'shared-refcount',
    fields: [{ key: 'x', value: number, required: true }],
    accessors: []
  }
  const target: Representation = { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const refused: ConversionNode = {
    id: structuralConversionKey(dynamic, number),
    source: dynamic,
    target: number,
    capability: { kind: 'never', reason: 'this runtime key frame is not admitted' }
  }
  const conversions = {
    ...census,
    nodeFor: (from: Representation, into: Representation) =>
      structuralConversionKey(from, into) === refused.id ? refused : census.nodeFor(from, into),
    nodeById: (id: string) => (id === refused.id ? refused : census.nodeById(id))
  }
  const plan = spreadCopyConversionPlanOf(copy(source, target), {} as RepresentationDeriver, conversions)
  assert.equal(plan.walks.size, 0)
  assert.deepEqual([...plan.leaves.values()], [census.nodeFor(number, number)])
})

test('static spread routes respect source keys and overwritten values before conversion admission', () => {
  const source: Representation = {
    kind: 'record',
    shapeId: 'source',
    ownership: 'owned',
    fields: [
      { key: 'replaced', value: string, required: true },
      { key: 'kept', value: number, required: true },
      { key: 'excluded', value: string, required: true }
    ],
    accessors: []
  }
  const target: Representation = { ...source, shapeId: 'target', fields: source.fields.map((field) => ({ ...field, value: number })) }
  const operation = { ...copy(source, target), keys: ['replaced', 'kept'], overwritten: ['replaced'] }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const plan = spreadCopyConversionPlanOf(operation, {} as RepresentationDeriver, census)
  assert.deepEqual([...plan.leaves.values()], [census.nodeFor(number, number)])
  assert.equal(plan.walks.size, 0)
})
