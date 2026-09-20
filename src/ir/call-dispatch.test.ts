import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrBody, IrOperation } from './model.js'
import { fillCallDispatchTargets } from './call-dispatch.js'
import type { Representation } from '../representation/model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'

const lineage = 'call-dispatch-test-lineage' as never
const operand = (value: string, representation: Representation) => ({ value: value as never, representation })

const bodyOf = (operations: readonly IrOperation[]): IrBody => {
  const entry = 'call-dispatch-entry' as never
  return {
    owner: 'call-dispatch-body' as never,
    sourceOwner: 'call-dispatch-owner' as never,
    abi: null,
    construct: null,
    entry,
    blocks: new Map([
      [entry, { id: entry, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } as never }]
    ]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}

const callOf = (callee: ReturnType<typeof operand>): IrOperation =>
  ({
    kind: 'call',
    lineage,
    callee,
    receiver: null,
    arguments: [],
    result: { id: 'call-result' as never, representation: { kind: 'scalar', domain: 'number' } }
  }) as never

const fill = (body: IrBody, placements = new Map()) =>
  fillCallDispatchTargets(
    new Map([[body.owner, body]]),
    placements,
    new Map(),
    () => null,
    () => false,
    { families: [], refused: [], dispatched: new Map() }
  )

test('dispatch publishes and consumes the omitted argument conversion in one census', () => {
  const functionId = 'optional-call-dispatch' as never
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: { kind: 'scalar', domain: 'boolean' } }
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: {
      receiver: null,
      parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }],
      restFrom: null,
      result: { kind: 'scalar', domain: 'number' }
    }
  }
  const body = bodyOf([
    {
      kind: 'allocate-callable',
      lineage,
      functionId,
      captures: [],
      result: { id: 'optional-callable' as never, representation }
    } as IrOperation,
    callOf(operand('optional-callable', representation))
  ])
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const published = fillCallDispatchTargets(
    new Map([[body.owner, body]]),
    new Map(),
    new Map(),
    () => representation.abi,
    () => true,
    { families: [], refused: [], dispatched: new Map() },
    null,
    conversions
  )
  const operation = published.get(body.owner)?.blocks.get(body.entry)?.operations[1] as Extract<IrOperation, { kind: 'call' }>
  assert.deepEqual(operation.closedCallee, { kind: 'exact', functionId })
  assert.deepEqual(operation.closedFrame, { abi: representation.abi, receivedArguments: 0, result: 'ignored' })
  assert.equal(operation.arguments.length, 0)
})

test('an allocated capturing callable publishes identity without physical direct dispatch', () => {
  const functionId = 'call-dispatch-capturing' as never
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } }
  }
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [operand('capture', { kind: 'scalar', domain: 'number' })],
    result: { id: 'callable', representation }
  } as never
  const body = bodyOf([allocation, callOf(operand('callable', representation))])
  const call = [...fill(body).values()][0]!.blocks.values().next().value!.operations[1] as Extract<IrOperation, { kind: 'call' }>
  assert.equal(call.target, undefined)
  assert.deepEqual(call.closedCallee, { kind: 'exact', functionId })
})

test('a uniquely written callable binding publishes identity even when it captures', () => {
  const functionId = 'call-dispatch-bound-capturing' as never
  const declaration = 'call-dispatch-binding' as never
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } }
  }
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [operand('capture', { kind: 'scalar', domain: 'number' })],
    result: { id: 'bound-callable', representation }
  } as never
  const write = { kind: 'binding-write', lineage, declaration, value: operand('bound-callable', representation) } as never
  const read = { kind: 'binding-read', lineage, declaration, result: { id: 'binding-read', representation } } as never
  const body = bodyOf([allocation, write, read, callOf(operand('binding-read', representation))])
  const placement = {
    storage: { kind: 'local', owner: body.owner },
    representation
  } as never
  const published = [...fill(body, new Map([[declaration, placement]])).values()][0]!.blocks.values().next().value!.operations
  const boundRead = published[2] as Extract<IrOperation, { kind: 'binding-read' }>
  assert.deepEqual(boundRead.closedCallable, { kind: 'exact', functionId })
  const call = published[3] as Extract<IrOperation, { kind: 'call' }>
  assert.equal(call.target, undefined)
  assert.deepEqual(call.closedCallee, { kind: 'exact', functionId })
})

test('a reassigned binding does not publish a closed callable identity', () => {
  const functionId = 'call-dispatch-reassigned' as never
  const declaration = 'call-dispatch-reassigned-binding' as never
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } }
  }
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [],
    result: { id: 'reassigned-callable', representation }
  } as never
  const write = () => ({ kind: 'binding-write', lineage, declaration, value: operand('reassigned-callable', representation) }) as never
  const read = { kind: 'binding-read', lineage, declaration, result: { id: 'reassigned-read', representation } } as never
  const body = bodyOf([allocation, write(), write(), read, callOf(operand('reassigned-read', representation))])
  const placement = { storage: { kind: 'local', owner: body.owner }, representation } as never
  const call = [...fill(body, new Map([[declaration, placement]])).values()][0]!.blocks.values().next().value!.operations[4] as Extract<
    IrOperation,
    { kind: 'call' }
  >
  assert.equal(call.closedCallee, undefined)
})

test('an external binding does not publish compiler-owned identity', () => {
  const functionId = 'call-dispatch-external' as never
  const declaration = 'call-dispatch-external-binding' as never
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } }
  }
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [],
    result: { id: 'external-callable', representation }
  } as never
  const write = { kind: 'binding-write', lineage, declaration, value: operand('external-callable', representation) } as never
  const read = { kind: 'binding-read', lineage, declaration, result: { id: 'external-read', representation } } as never
  const body = bodyOf([allocation, write, read, callOf(operand('external-read', representation))])
  const placement = { storage: { kind: 'external', linkageName: 'external_callback' }, representation } as never
  const call = [...fill(body, new Map([[declaration, placement]])).values()][0]!.blocks.values().next().value!.operations[3] as Extract<
    IrOperation,
    { kind: 'call' }
  >
  assert.equal(call.closedCallee, undefined)
})

test('an authenticated class member publishes identity while capture-free dispatch remains refused', () => {
  const declaration = 'call-dispatch-class' as never
  const functionId = 'call-dispatch-method' as never
  const instance: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'call-dispatch-class-shape' as never,
    ownership: 'shared-refcount',
    ancestors: []
  }
  const methodAbi = { receiver: instance, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } } as const
  const method: Representation = { kind: 'function', functionId, abi: methodAbi }
  const receiver = { kind: 'receiver', lineage, result: { id: 'receiver', representation: instance } } as never
  const key = {
    kind: 'constant',
    lineage,
    text: 'run',
    literal: 'string',
    result: { id: 'member-key', representation: { kind: 'string' } }
  } as never
  const get = {
    kind: 'get',
    lineage,
    receiver: operand('receiver', instance),
    key: operand('member-key', { kind: 'string' }),
    result: { id: 'method', representation: method }
  } as never
  const body = bodyOf([receiver, key, get, callOf(operand('method', method))])
  const classes = new Map([
    [
      declaration,
      {
        declaration,
        base: null,
        nativeBase: null,
        construct: null,
        instance,
        constructor: null,
        fields: [],
        fieldOwnership: [],
        methods: [{ key: 'run', callable: functionId }],
        accessors: [],
        staticFields: [],
        staticMethods: [],
        staticAccessors: [],
        name: null,
        length: null
      }
    ]
  ]) as never
  const result = fillCallDispatchTargets(
    new Map([[body.owner, body]]),
    new Map(),
    classes,
    () => methodAbi,
    () => false,
    { families: [], refused: [], dispatched: new Map() }
  )
  const read = [...result.values()][0]!.blocks.values().next().value!.operations[2] as Extract<IrOperation, { kind: 'get' }>
  assert.deepEqual(read.closedCallable, { kind: 'exact', functionId })
  const call = [...result.values()][0]!.blocks.values().next().value!.operations[3] as Extract<IrOperation, { kind: 'call' }>
  assert.equal(call.target, undefined)
  assert.deepEqual(call.closedCallee, { kind: 'exact', functionId })
})

test('an unresolved computed member call publishes no identity', () => {
  const functionId = 'call-dispatch-computed' as never
  const representation: Representation = {
    kind: 'function',
    functionId,
    abi: { receiver: null, parameters: [], restFrom: null, result: { kind: 'scalar', domain: 'number' } }
  }
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [],
    result: { id: 'computed-callable', representation }
  } as never
  const get = {
    kind: 'get',
    lineage,
    receiver: operand('object', { kind: 'record', shapeId: 'computed-object' as never, fields: [], accessors: [], ownership: 'owned' }),
    key: operand('computed-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    result: { id: 'computed-method', representation }
  } as never
  const body = bodyOf([allocation, get, callOf(operand('computed-method', representation))])
  const call = [...fill(body).values()][0]!.blocks.values().next().value!.operations[2] as Extract<IrOperation, { kind: 'call' }>
  assert.equal(call.closedCallee, undefined)
})
