import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import { certifiedIterableObjectViewPlan, certifiedProtocolIteratorPlan } from './certified-iterator-protocols.js'
import { structuralConversionKey } from './structural-plan.js'
import { recipeClosureOf } from './recipe-closure.js'
import { thrownValueCarrier, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { certifiedProtocolIteratorText } from '../targets/cpp/emit-protocol-iterator.js'
import { certifiedIterableObjectViewText } from '../targets/cpp/emit-iterable-object-view.js'
import type { ConversionSite } from '../targets/cpp/emit-narrowing.js'

const string: Representation = { kind: 'string' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const result: Representation = {
  kind: 'record',
  shapeId: 'result',
  ownership: 'shared-refcount',
  fields: [
    { key: 'done', value: boolean, required: true },
    { key: 'value', value: string, required: true }
  ],
  accessors: []
}
const callable = (result: Representation): Extract<Representation, { kind: 'function-value-dispatch' }> => ({
  kind: 'function-value-dispatch',
  abi: { receiver: null, parameters: [], restFrom: null, result }
})

test('protocol callbacks cite thrown-value transport and preserve the holder as logical this', () => {
  const next = callable(result)
  const raise: Representation = {
    ...next,
    abi: { ...next.abi, parameters: [{ value: dynamic, ownership: 'owned', passing: 'by-value' }] }
  }
  const source: Representation = {
    kind: 'record',
    shapeId: 'protocol-object',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'next', value: next, required: true },
      { key: 'throw', value: raise, required: false }
    ]
  }
  const target: Representation = {
    kind: 'iterator',
    source: 'sequence',
    element: string,
    completion: { kind: 'undefined' },
    resume: { kind: 'undefined' }
  }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const plan = certifiedProtocolIteratorPlan(layouts, source, target, census.nodeFor, census.nodeById)
  assert.ok(plan)
  assert.equal(plan.leaves.get(structuralConversionKey(thrownValueCarrier, dynamic)), census.nodeFor(thrownValueCarrier, dynamic))
  const ctx = {
    conversions: {
      ...census,
      nodeFor: () => {
        throw new Error('a protocol callback may not mint a conversion pair')
      }
    },
    layouts,
    classes: new Map(),
    captures: {},
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  const rendered = certifiedProtocolIteratorText(ctx, plan, 'iteratorObject')
  assert.ok(rendered)
  assert.match(rendered, /callWithReceiver\(gea::NativeCallReceiver::object\(gea_protocol_holder\)/)
  assert.ok(ctx.printerDrift.every((row) => row.kind === 'converted'))
})

test('an iterable collection view cites the complete nested cursor-object recipe', () => {
  const yielded: Representation = {
    ...result,
    fields: [
      { key: 'done', value: boolean, required: true },
      { key: 'value', value: dynamic, required: true }
    ]
  }
  const object: Representation = { kind: 'native-record-ref', shapeId: 'iterator-object', ownership: 'shared-refcount', native: null }
  const target: Representation = { ...object, shapeId: 'iterable-object' }
  const next = callable(yielded)
  const open = callable(object)
  const layouts = {
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: (shape: string) =>
      shape === 'iterable-object' ? [{ key: 'iterator', value: open, required: true }] : [{ key: 'next', value: next, required: true }],
    wellKnownSymbolOfKey: () => 'iterator' as const
  }
  const source: Representation = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const plan = certifiedIterableObjectViewPlan(layouts, source, target, census.nodeFor, census.nodeById)
  assert.ok(plan)
  const cursor = plan.leaves.get(structuralConversionKey(plan.view.cursor, object))
  assert.ok(cursor)
  const completion = census.nodeFor({ kind: 'undefined' }, dynamic)
  assert.equal(recipeClosureOf([cursor], census.nodeById).get(completion.id), completion)
  const ctx = {
    conversions: {
      ...census,
      nodeFor: () => {
        throw new Error('an iterable callback may not mint a conversion pair')
      }
    },
    layouts,
    classes: new Map(),
    captures: {},
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  assert.ok(certifiedIterableObjectViewText(ctx, plan, 'collection'))
})
