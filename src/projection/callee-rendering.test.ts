import assert from 'node:assert/strict'
import test from 'node:test'
import type { InvocationOperation } from '../semantics/model/operations.js'
import type { Representation } from '../representation/model.js'
import { calleeRenderingOf, hostMethodAliasDeclarations, type CalleeRenderingInput } from './callee.js'

const native: Representation = {
  kind: 'class-ref',
  declaration: 'native' as never,
  shapeId: 'native',
  ownership: 'shared-refcount',
  ancestors: []
}
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, ordinal) => ({
    tag: String(ordinal),
    semanticType: String(ordinal) as never,
    runtimeDiscriminator: { kind: 'carrier' as const },
    value
  }))
})
const rendering = (receiver: Representation, key = 'on', published?: Representation) => {
  const producer = {
    family: 'property',
    internalMethod: 'get',
    results: [{ id: 'callee', role: 'value' }],
    operands: [
      { role: 'receiver', ordinal: 0, source: { kind: 'result', result: 'receiver' } },
      { role: 'key', ordinal: 0, source: { kind: 'constant', literal: 'string', text: key } }
    ]
  }
  const input = {
    graph: { results: new Map([['callee', 'get']]), operations: new Map([['get', producer]]) },
    plan: { selected: new Map([['receiver', receiver], ...(published === undefined ? [] : [['callee', published] as const])]) },
    deriver: { derive: () => receiver },
    placements: new Map(),
    hostMethodAliasDeclarations: new Set()
  } as unknown as CalleeRenderingInput
  const operation = {
    internalMethod: 'call',
    operands: [{ role: 'callee', ordinal: 0, source: { kind: 'result', result: 'callee' } }]
  } as unknown as InvocationOperation
  return calleeRenderingOf(input, operation)
}

test('native object sums and optional wrappers retain their callable argument slots', () => {
  assert.equal(rendering(native), 'callable')
  assert.equal(rendering(sum(native, { ...native, declaration: 'other' as never, shapeId: 'other' })), 'callable')
  assert.equal(rendering({ kind: 'optional', payload: native, absence: 'undefined' }), 'callable')
  assert.equal(rendering(sum({ kind: 'optional', payload: native, absence: 'null' }, native)), 'callable')
})

test('native object prototype algorithms and heterogeneous builtin sums retain their explicit templates', () => {
  const record: Representation = { kind: 'record', shapeId: 'record', fields: [], accessors: [], ownership: 'shared-refcount' }
  assert.equal(rendering(sum(record, record), 'hasOwnProperty'), 'template')
  assert.equal(rendering(sum(native, { kind: 'string' })), 'callable')
  assert.equal(rendering({ kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }, 'trim'), 'template')
  assert.equal(rendering({ kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }), 'callable')
})

test('Proxy methods and real dictionary and array Function entries keep their callable frames', () => {
  const record: Representation = { kind: 'record', shapeId: 'record', fields: [], accessors: [], ownership: 'shared-refcount' }
  const fn: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], result: { kind: 'void' }, restFrom: null }
  }
  const proxy: Representation = { kind: 'proxy-object', target: record, handler: record }
  const dictionary: Representation = { kind: 'dictionary', key: 'string', value: fn, ownership: 'shared-refcount' }
  const array: Representation = { kind: 'array-object', element: fn, extension: null, ownership: 'shared-refcount' }
  assert.equal(rendering(proxy), 'callable')
  assert.equal(rendering({ kind: 'optional', payload: proxy, absence: 'undefined' }), 'callable')
  assert.equal(rendering(sum(record, proxy)), 'callable')
  assert.equal(rendering(dictionary, 'read'), 'callable')
  assert.equal(rendering(array, '0'), 'callable')
  assert.equal(rendering(array, 'slice'), 'template')
  const ownSlice: Representation = { ...array, extension: [{ key: 'slice', value: fn, required: true }] }
  assert.equal(rendering(ownSlice, 'slice'), 'callable')
  assert.equal(rendering({ ...record, fields: [{ key: 'hasOwnProperty', value: fn, required: true }] }, 'hasOwnProperty'), 'callable')
})

test('a complete builtin sum preserves exact noncallable alternatives without admitting callable dictionary entries', () => {
  const array: Representation = { kind: 'array-object', element: { kind: 'string' }, extension: null, ownership: 'shared-refcount' }
  const dictionary: Representation = { kind: 'dictionary', key: 'string', value: { kind: 'string' }, ownership: 'shared-refcount' }
  assert.equal(rendering(sum(dictionary, { kind: 'string' }, array), 'join'), 'template')
  const fn: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], result: { kind: 'string' }, restFrom: null }
  }
  assert.equal(rendering(sum({ ...dictionary, value: fn }, array), 'join'), 'callable')
})

test('authenticated reflection operations retain their native subject frame without a receiver-kind exemption', () => {
  const input = { graph: { operations: new Map(), results: new Map() } } as unknown as CalleeRenderingInput
  for (const intrinsicReflection of ['get', 'set', 'has', 'deleteProperty', 'getOwnPropertyDescriptor'] as const) {
    const operation = { internalMethod: 'call', intrinsicReflection, operands: [] } as unknown as InvocationOperation
    assert.equal(calleeRenderingOf(input, operation), 'template', intrinsicReflection)
    assert.equal(calleeRenderingOf(input, { internalMethod: 'call', operands: [] } as unknown as InvocationOperation), 'callable')
  }
})

test('Function source reads use the same exact direct and per-arm protocol as the native printer', () => {
  const fn: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], result: { kind: 'string' }, restFrom: null }
  }
  assert.equal(rendering(fn, 'toString', fn), 'template')
  assert.equal(rendering(sum({ kind: 'string' }, { kind: 'dynamic', reason: 'untyped-callable' }), 'toString', fn), 'template')
  assert.equal(rendering(sum({ kind: 'string' }, { kind: 'dynamic', reason: 'declared-any-never-narrowed' }), 'toString', fn), 'callable')
  assert.equal(rendering(fn, 'ownFunction', fn), 'callable')
})

test('immutable host method aliases authenticate constant computed keys and reject changed cells', () => {
  const declaration = 'alias' as never
  const host: Representation = {
    kind: 'native-handle',
    protocol: 'ArrayConstructor',
    native: null,
    version: 1,
    bases: [],
    call: null,
    construct: null
  }
  const producer = {
    family: 'property',
    internalMethod: 'get',
    keyIsComputed: true,
    operands: [
      { role: 'receiver', ordinal: 0, source: { kind: 'result', result: 'array' } },
      { role: 'key', ordinal: 0, source: { kind: 'constant', literal: 'string', text: 'isArray' } }
    ],
    results: [{ id: 'method', role: 'value' }]
  }
  const initialize = {
    family: 'binding',
    action: 'initialize',
    declaration,
    operands: [{ role: 'initializer', ordinal: 0, source: { kind: 'result', result: 'method' } }]
  }
  const graph = {
    operations: new Map<unknown, unknown>([
      ['get', producer],
      ['init', initialize]
    ])
  } as unknown as CalleeRenderingInput['graph']
  const plan = { selected: new Map([['array', host]]) } as unknown as CalleeRenderingInput['plan']
  const deriver = {} as CalleeRenderingInput['deriver']
  const members = new Map([['ArrayConstructor.isArray', { kind: 'method' as const, emit: 'native_is_array', arity: 1 as const }]])
  assert.equal(hostMethodAliasDeclarations(graph, plan, deriver, members).has(declaration), true)
  const changed = { ...graph, operations: new Map(graph.operations).set('second' as never, initialize as never) }
  assert.equal(hostMethodAliasDeclarations(changed, plan, deriver, members).has(declaration), false)
})
