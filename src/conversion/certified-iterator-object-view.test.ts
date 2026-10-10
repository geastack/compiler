import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import { recipeClosureOf } from './recipe-closure.js'
import { structuralConversionKey } from './structural-plan.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { certifiedIteratorObjectViewText } from '../targets/cpp/emit-iterator-object-view.js'
import type { ConversionSite } from '../targets/cpp/emit-narrowing.js'
import type { Representation } from '../representation/model.js'
import type { ConversionNode } from './algebra.js'
import { certifiedIteratorObjectViewPlan } from './certified-iterator-object-view.js'

test('an async iterator object seals terminal undefined and both result arms before rendering a deferred next', () => {
  const string: Representation = { kind: 'string' }
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const yieldRecord: Representation = {
    kind: 'record',
    shapeId: 'yielded',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'done', value: { kind: 'optional', payload: boolean, absence: 'undefined' }, required: false },
      { key: 'value', value: string, required: true }
    ]
  }
  const returnRecord: Representation = {
    ...yieldRecord,
    shapeId: 'returned',
    fields: [
      { key: 'done', value: boolean, required: true },
      { key: 'value', value: dynamic, required: true }
    ]
  }
  const result: Representation = {
    kind: 'tagged-union',
    arms: [yieldRecord, returnRecord].map((value, index) => ({
      tag: String(index),
      semanticType: `type|result-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' },
      value
    }))
  }
  const source: Representation = { kind: 'async-generator', element: string, completion: { kind: 'void' }, resume: { kind: 'undefined' } }
  const target: Representation = { kind: 'native-record-ref', shapeId: 'async-iterator', ownership: 'shared-refcount', native: null }
  const next: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'promise', value: result } }
  }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => [{ key: 'next', value: next, required: true }] }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const selected = census.nodeFor(source, target)
  assert.ok(selected.capability.kind === 'atom' || selected.capability.kind === 'static')
  const plan = selected.capability.materializer.iteratorObjectView
  assert.ok(plan)
  const completion = census.nodeFor({ kind: 'undefined' }, dynamic)
  assert.equal(plan.leaves.get(structuralConversionKey(completion.source, completion.target)), completion)
  assert.ok(selected.capability.materializer.dependencies?.includes(completion))
  const closure = recipeClosureOf([selected], census.nodeById)
  assert.equal(closure.get(completion.id), completion)
  const ctx = {
    conversions: {
      ...census,
      nodeFor: () => {
        throw new Error('a deferred step cannot decide a new conversion pair')
      }
    },
    layouts,
    classes: new Map(),
    captures: {},
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  const rendered = certifiedIteratorObjectViewText(ctx, plan, 'cursor')
  assert.ok(rendered)
  assert.ok(rendered.includes('gea_step.done'))
  assert.ok(rendered.includes('gea_step.value'))
  assert.ok(ctx.printerDrift.every((row) => row.kind === 'converted'))
})

test('a deferred iterator step refuses a guarded payload hidden inside an otherwise admitted leaf', () => {
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const from: Representation = { kind: 'promise', value: { kind: 'string' } }
  const into: Representation = { kind: 'promise', value: { kind: 'scalar', domain: 'number' } }
  const proof = (source: Representation, target: Representation): ConversionNode => ({
    id: structuralConversionKey(source, target),
    source,
    target,
    capability:
      structuralConversionKey(source, source) === structuralConversionKey(source, target)
        ? { kind: 'identity' }
        : { kind: 'static', materializer: { id: 'test:admitted', domain: 'admitted', allocates: false } }
  })
  const guarded: ConversionNode = {
    ...proof(from, into),
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:future-payload',
        domain: 'future-payload',
        allocates: true,
        dependencies: [
          {
            ...proof({ kind: 'string' }, { kind: 'scalar', domain: 'number' }),
            capability: {
              kind: 'static',
              materializer: { id: 'test:guarded', domain: 'guarded', allocates: false, requiresSourceGuard: true }
            }
          }
        ]
      }
    }
  }
  const yielded: Representation = {
    kind: 'record',
    shapeId: 'guarded-yield',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'done', value: { kind: 'optional', payload: boolean, absence: 'undefined' }, required: false },
      { key: 'value', value: into, required: true }
    ]
  }
  const returned: Representation = {
    ...yielded,
    shapeId: 'guarded-return',
    fields: [
      { key: 'done', value: boolean, required: true },
      { key: 'value', value: { kind: 'undefined' }, required: true }
    ]
  }
  const result: Representation = {
    kind: 'tagged-union',
    arms: [yielded, returned].map((value, index) => ({
      tag: String(index),
      semanticType: `type|guarded-result-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' },
      value
    }))
  }
  const next: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'promise', value: result } }
  }
  const source: Representation = {
    kind: 'async-generator',
    element: from,
    completion: { kind: 'undefined' },
    resume: { kind: 'undefined' }
  }
  const target: Representation = { kind: 'native-record-ref', shapeId: 'guarded-iterator', ownership: 'shared-refcount', native: null }
  assert.equal(
    certifiedIteratorObjectViewPlan(
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => [{ key: 'next', value: next, required: true }] },
      source,
      target,
      (source, target) => (structuralConversionKey(source, target) === guarded.id ? guarded : proof(source, target))
    ),
    null
  )
})
