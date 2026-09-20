import assert from 'node:assert/strict'
import test from 'node:test'
import type { IrBody, IrOperation } from './model.js'
import { finalizeTypedComputedReads, reflectionExposureOf } from './reflection-demand.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeMergeTransportOf } from './native-merge-transport.js'
import { nativeArrayTransportOf } from './native-array-transport.js'
import { nativeDictionaryTransportOf } from './native-dictionary-transport.js'
import { nativeSequenceTransportOf } from './native-sequence-transport.js'
import { nativeKeyQueryOf } from './native-key-query.js'
import { hasClosedFixedLayout, hasNativePropertyLayout } from './native-fixed-layout.js'
import { nativeCallableBindTransportOf } from './native-callable-bind.js'

test('certified numeric absence needs no reflected fields, but an undefined result alone is no proof', () => {
  const declaration = 'absent-context' as never
  const receiver: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'absent-context-shape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const classes = new Map([[declaration, provenFamilyLayoutOf(declaration, receiver, 'TEXTURE_2D', number)]])
  const shape = record('absent-context-shape', [{ key: 'TEXTURE_2D', value: number }])
  const read: Extract<IrOperation, { kind: 'get' }> = {
    kind: 'get',
    lineage,
    receiver: operand('context', receiver),
    key: operand('numeric-key', number),
    result: { id: 'absent-read' as never, representation: { kind: 'undefined' } }
  }
  const demand = (operation: IrOperation) =>
    reflectionExposureOf([bodyOf([operation])], classes, { layoutOf: () => shape } as never, {
      representations: [receiver],
      shakeComplete: true
    }).classes.get(declaration)?.level
  assert.equal(demand(read), 'full')
  assert.equal(demand({ ...read, normalResult: 'undefined' }), 'keys-only')
})

test('native bind retains its typed prefix without exposing fields; dynamic and mismatched bind frames retain demand', () => {
  const payload: Representation = {
    kind: 'record',
    shapeId: 'bind-prefix-payload',
    fields: [{ key: 'code', value: { kind: 'scalar', domain: 'number' }, required: true }],
    accessors: [],
    ownership: 'shared-refcount'
  }
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const abi = {
    receiver: null,
    parameters: [
      { value: payload, ownership: 'owned' as const, passing: 'by-value' as const },
      { value: number, ownership: 'owned' as const, passing: 'by-value' as const }
    ],
    restFrom: null,
    result: number
  }
  const bound: Extract<IrOperation, { kind: 'bind-callable' }> = {
    kind: 'bind-callable',
    lineage,
    source: operand('source', { kind: 'function-value-dispatch', abi }),
    sourceFunctionId: null,
    sourceAbi: abi,
    thisArgument: null,
    receiver: null,
    bound: [operand('prefix', payload)],
    detached: false,
    result: {
      id: 'bound' as never,
      representation: { kind: 'function-value-dispatch', abi: { ...abi, parameters: abi.parameters.slice(1) } }
    }
  }
  assert.equal(nativeCallableBindTransportOf(bound), true)
  const demand = (operation: IrOperation) =>
    reflectionExposureOf([bodyOf([operation])], new Map(), null, {
      representations: [payload],
      shakeComplete: true
    }).records.get('bind-prefix-payload' as never)?.level
  assert.equal(demand(bound), 'keys-only')
  const dynamic = { ...bound, source: operand('source', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }) }
  assert.equal(nativeCallableBindTransportOf(dynamic), false)
  assert.equal(demand(dynamic), 'full')
  const mismatched = { ...bound, sourceAbi: { ...abi, receiver: payload } }
  assert.equal(nativeCallableBindTransportOf(mismatched), false)
  assert.equal(demand(mismatched), 'full')
})

const record = (shapeId: string, fields: readonly { key: string; value: Representation }[]): Representation => ({
  kind: 'record',
  shapeId,
  fields: fields.map((field) => ({ ...field, required: true })),
  accessors: [],
  ownership: 'owned'
})

const recordWithIndex = (shapeId: string, fields: readonly { key: string; value: Representation }[]): Representation => ({
  kind: 'record-with-index',
  shapeId,
  fields: fields.map((field) => ({ ...field, required: true })),
  indexes: [{ key: 'string', value: { kind: 'scalar', domain: 'number' } }],
  ownership: 'owned'
})

test('a field read consumes a cited native payload conversion without retaining boxed field reads', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
  const receiver = record('converted-field-read', [{ key: 'value', value: number }])
  const operations: IrOperation[] = [
    {
      kind: 'constant',
      lineage,
      literal: 'string',
      text: 'value',
      result: { id: 'field-key' as never, representation: { kind: 'string' } }
    },
    {
      kind: 'get',
      lineage,
      receiver: operand('receiver', receiver),
      key: operand('field-key', { kind: 'string' }),
      result: { id: 'field-read' as never, representation: optional }
    }
  ]
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const demand = () =>
    reflectionExposureOf([bodyOf(operations)], new Map(), null, {
      representations: [receiver],
      conversions,
      shakeComplete: true
    }).records.get('converted-field-read' as never)?.level
  assert.equal(demand(), 'full', 'a compatible shape alone is not a conversion proof')
  conversions.nodeFor(number, optional)
  assert.equal(demand(), 'keys-only')
})

const bodyOf = (operations: readonly IrOperation[]): IrBody => {
  const id = 'reflection-test-body' as IrBody['entry']
  return {
    owner: 'reflection-test-owner' as IrBody['owner'],
    sourceOwner: 'reflection-test-owner' as IrBody['sourceOwner'],
    abi: null,
    construct: null,
    entry: id,
    blocks: new Map([[id, { id, operations: operations as never, terminator: { kind: 'return', lineage: null, value: null } as never }]]),
    blockOrder: [id],
    values: new Map(),
    tryRegions: []
  }
}

const functionBodyOf = (
  functionId: string,
  abi: NonNullable<IrBody['abi']>,
  operations: readonly IrOperation[],
  returnValue: ReturnType<typeof operand> | null = null,
  construct: NonNullable<IrBody['construct']> | null = null
): IrBody => {
  const id = `${functionId}-entry` as IrBody['entry']
  return {
    owner: `${functionId}-body` as IrBody['owner'],
    sourceOwner: functionId as IrBody['sourceOwner'],
    abi,
    construct,
    entry: id,
    blocks: new Map([
      [id, { id, operations: operations as never, terminator: { kind: 'return', lineage: null, value: returnValue } as never }]
    ]),
    blockOrder: [id],
    values: new Map(),
    tryRegions: []
  }
}

const operand = (value: string, representation: Representation) => ({ value: value as never, representation })
const lineage = 'reflection-test-lineage' as never

test('native dictionary lookup reflects neither its stored records nor their optional fields', () => {
  const point = record('dictionary-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const dictionary: Representation = { kind: 'dictionary', key: 'string', value: point, ownership: 'shared-refcount' }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const get: Extract<IrOperation, { kind: 'get' }> = {
    kind: 'get',
    lineage,
    receiver: operand('dictionary', dictionary),
    key: operand('key', { kind: 'string' }),
    result: { id: 'point' as never, representation: { kind: 'optional', payload: point, absence: 'undefined' } }
  }
  const demand = (operations: readonly IrOperation[]) =>
    reflectionExposureOf([bodyOf(operations)], new Map(), null, { representations: [dictionary, point], shakeComplete: true }).records.get(
      'dictionary-point' as never
    )?.level
  assert.equal(nativeDictionaryTransportOf(get), true)
  assert.equal(demand([get]), 'keys-only')
  const erased = { ...get, result: { id: 'point' as never, representation: dynamic } }
  assert.equal(nativeDictionaryTransportOf(erased), false)
  assert.equal(demand([erased]), 'full')
  const coercingKey = { ...get, key: operand('key', dynamic) }
  assert.equal(nativeDictionaryTransportOf(coercingKey), false)
  assert.equal(demand([coercingKey]), 'full')
  assert.equal(
    demand([
      get,
      {
        kind: 'call',
        lineage,
        callee: operand('external', dynamic),
        receiver: null,
        arguments: [operand('dictionary', dictionary)],
        result: null
      }
    ]),
    'full'
  )
})

test('native sequence steps transport typed elements without reflecting their fields', () => {
  const point = record('sequence-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const array: Representation = { kind: 'array-object', element: point, ownership: 'shared-refcount', extension: null }
  const cursor: Representation = {
    kind: 'iterator',
    source: 'sequence',
    element: point,
    resume: { kind: 'undefined' },
    completion: { kind: 'undefined' }
  }
  const get: Extract<IrOperation, { kind: 'get-iterator' }> = {
    kind: 'get-iterator',
    lineage,
    protocol: 'iterator',
    method: null,
    receiver: operand('array', array),
    result: { id: 'cursor' as never, representation: cursor }
  }
  const next: Extract<IrOperation, { kind: 'iterator-next' }> = {
    kind: 'iterator-next',
    lineage,
    iterator: operand('cursor', cursor),
    value: null,
    result: { id: 'point' as never, representation: point }
  }
  const options = { representations: [array, cursor, point], shakeComplete: true }
  const demand = (operations: readonly IrOperation[]) =>
    reflectionExposureOf([bodyOf(operations)], new Map(), null, options).records.get('sequence-point' as never)?.level
  assert.equal(demand([get, next]), 'keys-only')
  assert.equal(nativeSequenceTransportOf(get), true)
  assert.equal(nativeSequenceTransportOf(next), true)
  assert.equal(
    nativeSequenceTransportOf({ ...get, method: operand('custom', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }) }),
    false
  )
  assert.equal(nativeSequenceTransportOf({ ...get, protocol: 'async-iterator' }), false)
  assert.equal(nativeSequenceTransportOf({ ...next, iterator: operand('generator', { ...cursor, source: 'generator' }) }), false)
  assert.equal(nativeSequenceTransportOf({ ...next, value: operand('sent', point) }), false)
  assert.equal(nativeSequenceTransportOf({ ...next, result: { id: 'bad' as never, representation: { kind: 'string' } } }), false)
  assert.equal(
    demand([
      get,
      next,
      {
        kind: 'call',
        lineage,
        callee: operand('external', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
        receiver: null,
        arguments: [operand('cursor', cursor)],
        result: null
      }
    ]),
    'full'
  )
  assert.equal(demand([{ ...next, iterator: operand('generator', { ...cursor, source: 'generator' }) }]), 'full')
})

test('deferred result inventory is not publication; unknown stepping and awaiting publish actual payloads', () => {
  const point = record('deferred-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  for (const deferred of [
    { kind: 'promise', value: point },
    { kind: 'iterator', source: 'generator', element: point, resume: { kind: 'undefined' }, completion: { kind: 'undefined' } }
  ] satisfies Representation[]) {
    const options = { representations: [deferred, point], shakeComplete: true }
    const held: IrOperation = { kind: 'parameter', lineage, ordinal: 0, result: { id: 'held' as never, representation: deferred } }
    const demand = (operations: readonly IrOperation[]) =>
      reflectionExposureOf([bodyOf(operations)], new Map(), null, options).records.get('deferred-point' as never)?.level
    assert.equal(demand([held]), 'keys-only')
    const operation: IrOperation =
      deferred.kind === 'promise'
        ? { kind: 'await', lineage, operand: operand('held', deferred), result: { id: 'payload' as never, representation: point } }
        : {
            kind: 'iterator-next',
            lineage,
            iterator: operand('held', deferred),
            value: null,
            result: { id: 'payload' as never, representation: point }
          }
    assert.equal(demand([held, operation]), 'full')
    assert.equal(demand([held, { kind: 'throw', lineage, value: operand('held', deferred) }]), 'full')
  }
})

test('native frames expose received values only when transport is dynamic or inexact', () => {
  const point = record('unreceived-call-input', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const abi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' as const } }
  const native: Representation = { kind: 'function-value-dispatch', abi }
  const call: Extract<IrOperation, { kind: 'call' }> = {
    kind: 'call',
    lineage,
    callee: operand('external-native-callable', native),
    receiver: null,
    arguments: [operand('point', point)],
    result: null
  }
  const demand = (operation: typeof call, preceding: readonly IrOperation[] = []) =>
    reflectionExposureOf([bodyOf([...preceding, operation])], new Map(), null, {
      representations: [point, operation.callee.representation],
      shakeComplete: true
    }).records.get('unreceived-call-input' as never)?.level
  assert.equal(demand(call), 'keys-only')
  assert.equal(demand({ ...call, argumentsAreSpread: true }), 'full')
  assert.equal(demand({ ...call, callee: operand('dynamic-callable', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }) }), 'full')
  const received: Representation = {
    kind: 'function-value-dispatch',
    abi: { ...abi, parameters: [{ value: point, ownership: 'owned', passing: 'by-value' }] }
  }
  assert.equal(demand({ ...call, callee: operand('receiving-callable', received) }), 'keys-only')
  // A stated native convention is insufficient when this actual frame does
  // not supply its receiver. Its received input must retain full reflection.
  assert.equal(
    demand({ ...call, callee: operand('missing-receiver-callable', { ...received, abi: { ...received.abi, receiver: point } }) }),
    'full'
  )
  const rest: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      ...abi,
      restFrom: 0,
      parameters: [
        {
          value: { kind: 'array-object', element: point, ownership: 'shared-refcount', extension: null },
          ownership: 'shared-refcount',
          passing: 'by-value'
        }
      ]
    }
  }
  // Exact rest elements are packed into their native array without exposure.
  assert.equal(demand({ ...call, callee: operand('rest-callable', rest) }), 'keys-only')
  const adaptingRest: Representation = {
    ...rest,
    abi: {
      ...rest.abi,
      parameters: [
        {
          ...rest.abi.parameters[0]!,
          value: {
            kind: 'array-object',
            element: { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
            ownership: 'shared-refcount',
            extension: null
          }
        }
      ]
    }
  }
  assert.equal(demand({ ...call, callee: operand('adapting-rest-callable', adaptingRest) }), 'full')
  // A discarded result does not erase a preceding getter/call's effects.
  assert.equal(
    demand(call, [{ ...call, callee: operand('effectful-source', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }) }]),
    'full'
  )
})

test('a sealed native merge does not expose discarded object payloads and rejects a stale live-arm claim', () => {
  const point = record('merge-discarded-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const union = (...values: Representation[]): Representation => ({
    kind: 'tagged-union',
    arms: values.map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `merge-type-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  })
  const source = union({ kind: 'undefined' }, point)
  const target = union({ kind: 'undefined' }, { kind: 'scalar', domain: 'boolean' })
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const nativeTransport = nativeMergeTransportOf(source, target, [0], false, conversions)
  assert.ok(nativeTransport)
  const operation: Extract<IrOperation, { kind: 'merge-live-arm-rebuild' }> = {
    kind: 'merge-live-arm-rebuild',
    lineage,
    source: operand('merge-source', source),
    result: { id: 'merge-result' as never, representation: target },
    liveArms: [0],
    sourceAbsenceLive: false,
    nativeTransport
  }
  const demand = (value: typeof operation) =>
    reflectionExposureOf([bodyOf([value])], new Map(), null, {
      representations: [source, target],
      shakeComplete: true,
      conversions
    }).byRepresentation.get(representationKey(point))?.level
  assert.equal(demand(operation), 'keys-only')
  assert.equal(demand({ ...operation, liveArms: [1] }), 'full')
})

test('discarded signatures and exact native calls stay private while dynamic calls expose actual values', () => {
  const input = record('callable-input-frame', [{ key: 'input', value: { kind: 'scalar', domain: 'number' } }])
  const receiver = record('callable-this-frame', [{ key: 'receiver', value: { kind: 'scalar', domain: 'number' } }])
  const output = record('callable-output-value', [{ key: 'output', value: { kind: 'scalar', domain: 'number' } }])
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      parameters: [{ value: input, ownership: 'owned', passing: 'by-value' }],
      receiver,
      result: output,
      restFrom: null
    }
  }
  const discard = {
    kind: 'compute',
    form: 'unary',
    lineage,
    operator: 'void',
    operands: [operand('published-callable', callable)],
    result: { id: 'discarded-callable' as never, representation: { kind: 'undefined' } }
  } as IrOperation
  const options = { representations: [callable], shakeComplete: true }
  const exposure = reflectionExposureOf([bodyOf([discard])], new Map(), null, options)
  assert.equal(exposure.records.get('callable-input-frame' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('callable-this-frame' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('callable-output-value' as never)?.level, 'keys-only')

  const call = {
    kind: 'call',
    lineage,
    callee: operand('published-callable', callable),
    receiver: operand('actual-receiver', receiver),
    arguments: [operand('actual-input', input)],
    result: { id: 'actual-output' as never, representation: output }
  } as IrOperation
  const actualCall = reflectionExposureOf([bodyOf([call])], new Map(), null, options)
  assert.equal(actualCall.records.get('callable-input-frame' as never)?.level, 'keys-only')
  assert.equal(actualCall.records.get('callable-this-frame' as never)?.level, 'keys-only')
  assert.equal(actualCall.records.get('callable-output-value' as never)?.level, 'keys-only')
  const dynamicCall = {
    ...call,
    callee: operand('dynamic-callable', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
  } as IrOperation
  const dynamic = reflectionExposureOf([bodyOf([dynamicCall])], new Map(), null, {
    ...options,
    representations: [callable, input, receiver, output]
  })
  assert.equal(dynamic.records.get('callable-input-frame' as never)?.level, 'full')
  assert.equal(dynamic.records.get('callable-this-frame' as never)?.level, 'full')
  assert.equal(dynamic.records.get('callable-output-value' as never)?.level, 'full')

  const incomplete = reflectionExposureOf([bodyOf([discard])], new Map(), null, { ...options, shakeComplete: false })
  assert.equal(incomplete.records.get('callable-input-frame' as never)?.level, 'full')
  assert.equal(incomplete.records.get('callable-this-frame' as never)?.level, 'full')
})

test('a returned callback exposes its result without exposing its input convention', () => {
  const input = record('returned-callback-input', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const output = record('returned-callback-output', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const callback: Representation = {
    kind: 'function-value-dispatch',
    abi: { parameters: [{ value: input, ownership: 'owned', passing: 'by-value' }], receiver: null, result: output, restFrom: null }
  }
  const factory: Representation = {
    kind: 'function-value-dispatch',
    abi: { parameters: [], receiver: null, result: callback, restFrom: null }
  }
  const discard = {
    kind: 'compute',
    form: 'unary',
    lineage,
    operator: 'void',
    operands: [operand('factory', factory)],
    result: { id: 'discarded-factory' as never, representation: { kind: 'undefined' } }
  } as IrOperation
  const options = { representations: [factory], shakeComplete: true }
  const unused = reflectionExposureOf([bodyOf([discard])], new Map(), null, options)
  assert.equal(unused.records.get('returned-callback-output' as never)?.level, 'keys-only')
  const publish = { kind: 'return', lineage, value: operand('factory', factory) } as IrOperation
  const exposure = reflectionExposureOf([bodyOf([publish])], new Map(), null, options)
  assert.equal(exposure.records.get('returned-callback-input' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('returned-callback-output' as never)?.level, 'full')
})

test('reflection tracing retains later causes through an already-expanded shared child', () => {
  const child = record('trace-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const left = record('trace-left', [{ key: 'child', value: child }])
  const right = record('trace-right', [{ key: 'child', value: child }])
  const calls = [left, right].map((value, index) => ({
    kind: 'call',
    lineage,
    callee: operand('unknown-callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand(`root-${index}`, value)],
    result: null
  })) as IrOperation[]
  const options = { representations: [left, right, child], shakeComplete: true }
  const traced = reflectionExposureOf([bodyOf(calls)], new Map(), null, { ...options, trace: true })
  const ordinary = reflectionExposureOf([bodyOf(calls)], new Map(), null, options)
  assert.deepEqual([...traced.byRepresentation], [...ordinary.byRepresentation])
  const trace = traced.boundaries!
  assert.deepEqual(trace.parents.get(representationKey(child)), new Set([representationKey(left), representationKey(right)]))
  const visited = new Set<string>()
  const pending = [representationKey(child)]
  const origins = new Set<number>()
  while (pending.length) {
    const key = pending.pop()!
    if (visited.has(key)) continue
    visited.add(key)
    for (const origin of trace.affecting.get(key) ?? []) origins.add(origin)
    pending.push(...(trace.parents.get(key) ?? []))
  }
  assert.deepEqual(
    new Set([...origins].map((index) => representationKey(trace.origins[index]!.carrier))),
    new Set([representationKey(left), representationKey(right)])
  )
})

test('native carrier tests and same-carrier joins do not publish field values', () => {
  const value = record('tested-record', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const source = operand('tested-value', value)
  const operations = [
    {
      kind: 'compute',
      form: 'equality',
      operator: '===',
      operands: [source, source],
      result: { id: 'equal', representation: boolean },
      lineage
    },
    {
      kind: 'compute',
      form: 'typeof',
      operator: 'typeof',
      operands: [source],
      result: { id: 'type', representation: { kind: 'string' } },
      lineage
    },
    { kind: 'test', predicate: 'to-boolean', value: source, result: { id: 'truth', representation: boolean }, lineage },
    {
      kind: 'phi',
      incoming: [
        { block: 'left', value: source },
        { block: 'right', value: source }
      ],
      result: { id: 'joined', representation: value },
      lineage
    }
  ] as unknown as IrOperation[]
  const exposure = reflectionExposureOf([bodyOf(operations)], new Map(), null, { representations: [value], shakeComplete: true })
  assert.equal(exposure.records.get('tested-record' as never)?.level, 'keys-only')
  const coercive = { ...operations[0], operator: '==' } as IrOperation
  const coerciveExposure = reflectionExposureOf([bodyOf([coercive])], new Map(), null, { representations: [value], shakeComplete: true })
  assert.equal(coerciveExposure.records.get('tested-record' as never)?.level, 'full')
})

test('truthiness and discarding a native object do not publish its fields, while numeric coercion does', () => {
  const value = record('truthy-record', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  for (const operator of ['!', 'void', '+']) {
    const compute = {
      kind: 'compute',
      form: 'unary',
      operator,
      operands: [operand('truthy-object', value)],
      result: {
        id: 'truthy-result' as never,
        representation: operator === 'void' ? { kind: 'undefined' } : { kind: 'scalar', domain: operator === '+' ? 'number' : 'boolean' }
      },
      lineage
    } as IrOperation
    const exposure = reflectionExposureOf([bodyOf([compute])], new Map(), null, { representations: [value], shakeComplete: true })
    assert.equal(exposure.records.get('truthy-record' as never)?.level, operator === '+' ? 'full' : 'keys-only')
  }
})

test('ObjectTag reads only the authenticated well-known symbol and retains unknown-demand fallback', () => {
  const tagDeclaration = 'object-tag-symbol' as never
  const tagKey = `sym(${tagDeclaration})`
  const value = record('tagged-record', [{ key: 'toString', value: { kind: 'string' } }])
  const operation = {
    kind: 'compute',
    form: 'unary',
    operator: 'ObjectTag',
    operands: [operand('tagged', value)],
    result: { id: 'tag-result' as never, representation: { kind: 'string' } },
    lineage
  } as IrOperation
  const options = { representations: [value], shakeComplete: true }
  const exposed = reflectionExposureOf([bodyOf([operation])], new Map(), null, {
    ...options,
    wellKnownSymbols: new Map([[tagDeclaration, 'toStringTag']])
  }).records.get('tagged-record' as never)
  assert.deepEqual([...exposed!.fieldOperations!.keys()], [tagKey])
  assert.deepEqual([...exposed!.fieldOperations!.get(tagKey)!], ['read'])
  const unknown = reflectionExposureOf([bodyOf([operation])], new Map(), null, options).records.get('tagged-record' as never)
  assert.equal(unknown?.level, 'full')
  assert.equal(unknown?.fieldOperations, undefined)
})

test('a conversion-census native transfer omits demand but an unknown recipe or mismatched citation does not', () => {
  const value = record('wrapped-record', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const target: Representation = { kind: 'optional', payload: value, absence: 'undefined' }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(value, target)
  assert.ok(node.capability.kind !== 'never')
  const convert = {
    kind: 'convert',
    lineage,
    conversionUse: node.id,
    source: operand('wrapped-value', value),
    result: { id: 'wrapped-result' as never, representation: target }
  } as IrOperation
  const exposure = reflectionExposureOf([bodyOf([convert])], new Map(), null, {
    representations: [value, target],
    conversions,
    shakeComplete: true
  })
  assert.equal(exposure.records.get('wrapped-record' as never)?.level, 'keys-only')
  const unknown = reflectionExposureOf([bodyOf([convert])], new Map(), null, { representations: [value, target], shakeComplete: true })
  assert.equal(unknown.records.get('wrapped-record' as never)?.level, 'full')
  const mismatched = { ...convert, result: { id: 'wrong-result', representation: { kind: 'string' } } } as IrOperation
  const invalid = reflectionExposureOf([bodyOf([mismatched])], new Map(), null, {
    representations: [value],
    conversions,
    shakeComplete: true
  })
  assert.equal(invalid.records.get('wrapped-record' as never)?.level, 'full')
})

test('optional payload loads and absence selections retain native records without their boxed protocol', () => {
  const value = record('optional-native-record', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const source: Representation = { kind: 'optional', payload: value, absence: 'undefined' }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const target of [value, { kind: 'undefined' } as const]) {
    const node = conversions.nodeFor(source, target)
    assert.notEqual(node.capability.kind, 'never')
    const convert = {
      kind: 'convert',
      lineage,
      conversionUse: node.id,
      source: operand('optional-native-source', source),
      result: { id: 'optional-native-result' as never, representation: target }
    } as IrOperation
    const exposure = reflectionExposureOf([bodyOf([convert])], new Map(), null, {
      representations: [source, value],
      conversions,
      shakeComplete: true
    })
    assert.equal(exposure.records.get('optional-native-record' as never)?.level, 'keys-only')
    const boxed = { kind: 'dynamic', reason: 'declared-any-never-narrowed' } as const
    const escape = {
      ...convert,
      conversionUse: conversions.nodeFor(source, boxed).id,
      result: { id: 'optional-native-escape' as never, representation: boxed }
    } as IrOperation
    const escaped = reflectionExposureOf([bodyOf([convert, escape])], new Map(), null, {
      representations: [source, value],
      conversions,
      shakeComplete: true
    })
    assert.equal(escaped.records.get('optional-native-record' as never)?.level, 'full')
  }
})

test('native structural record copies do not expose discarded fields but a boxed destination still exposes its payload', () => {
  const child = record('native-copy-child', [{ key: 'amount', value: { kind: 'scalar', domain: 'number' } }])
  const source = record('native-copy-source', [
    { key: 'child', value: child },
    { key: 'discarded', value: { kind: 'string' } }
  ])
  const target = record('native-copy-target', [{ key: 'child', value: child }])
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const [from, to] of [
    [source, target],
    [
      { kind: 'optional', payload: source, absence: 'undefined' },
      { kind: 'optional', payload: target, absence: 'undefined' }
    ]
  ] as const) {
    const node = conversions.nodeFor(from, to)
    assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
    assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
    const convert = {
      kind: 'convert',
      lineage,
      conversionUse: node.id,
      source: operand('native-copy-source', from),
      result: { id: 'native-copy-result' as never, representation: to }
    } as IrOperation
    const exposure = reflectionExposureOf([bodyOf([convert])], new Map(), null, {
      representations: [source, target, child, from, to],
      conversions,
      shakeComplete: true
    })
    for (const id of ['native-copy-source', 'native-copy-target', 'native-copy-child'])
      assert.equal(exposure.records.get(id as never)?.level, 'keys-only')
    const unknown = reflectionExposureOf([bodyOf([convert])], new Map(), null, {
      representations: [source, target, child, from, to],
      shakeComplete: true
    })
    assert.equal(unknown.records.get('native-copy-source' as never)?.level, 'full')
  }
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const boxedTarget = record('native-copy-boxed-target', [{ key: 'child', value: dynamic }])
  const node = conversions.nodeFor(source, boxedTarget)
  assert.notEqual(node.capability.kind, 'never')
  if (node.capability.kind === 'atom' || node.capability.kind === 'static')
    assert.notEqual(node.capability.materializer.nativeFieldProtocol, 'unused')
  const boxed = {
    kind: 'convert',
    lineage,
    conversionUse: node.id,
    source: operand('native-copy-source', source),
    result: { id: 'native-copy-boxed-result' as never, representation: boxedTarget }
  } as IrOperation
  const exposure = reflectionExposureOf([bodyOf([boxed])], new Map(), null, {
    representations: [source, boxedTarget, child],
    conversions,
    shakeComplete: true
  })
  assert.equal(exposure.records.get('native-copy-child' as never)?.level, 'full')
})

test('native class downcasts publish their no-field-protocol contract through the conversion census', () => {
  const base: Representation = {
    kind: 'class-ref',
    declaration: 'Base' as never,
    shapeId: 'BaseShape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const left: Representation = { ...base, declaration: 'Left' as never, shapeId: 'LeftShape', ancestors: ['Base' as never] }
  const right: Representation = { ...base, declaration: 'Right' as never, shapeId: 'RightShape', ancestors: ['Base' as never] }
  const descendants: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'left', value: left, semanticType: 'LeftShape' as never, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'right', value: right, semanticType: 'RightShape' as never, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  const nullable: Representation = { kind: 'optional', payload: base, absence: 'null' }
  const presenceUnion: Representation = {
    kind: 'tagged-union',
    arms: [base, { kind: 'null' } as const, { kind: 'undefined' } as const].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const instances = [base, left, right]
  const classes = new Map(
    instances.map((instance) => [
      instance.declaration,
      {
        declaration: instance.declaration,
        base: instance.ancestors[0] ?? null,
        nativeBase: null,
        construct: null,
        instance,
        constructor: null,
        fields: [],
        fieldOwnership: [],
        methods: [],
        accessors: [],
        staticFields: [],
        staticMethods: [],
        staticAccessors: [],
        name: null,
        length: null
      }
    ])
  )
  const deriver = { layoutOf: (id: string) => record(id, []) } as never
  for (const [source, target] of [
    [base, left],
    [base, descendants],
    [nullable, left],
    [presenceUnion, left]
  ] as const) {
    const node = conversions.nodeFor(source, target)
    assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static' || node.capability.kind === 'class-family')
    assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
    const convert = {
      kind: 'convert',
      lineage,
      conversionUse: node.id,
      source: operand('downcast-source', source),
      result: { id: 'downcast-result' as never, representation: target }
    } as IrOperation
    const exposure = reflectionExposureOf([bodyOf([convert])], classes, deriver, {
      representations: [...instances, source, target],
      conversions,
      shakeComplete: true
    })
    for (const instance of instances) assert.equal(exposure.classes.get(instance.declaration)?.level, 'keys-only')
    const unknown = reflectionExposureOf([bodyOf([convert])], classes, deriver, {
      representations: [...instances, source, target],
      shakeComplete: true
    })
    assert.equal(unknown.classes.get(base.declaration)?.level, 'full')
  }
  const mixed: Representation = {
    kind: 'tagged-union',
    arms: [base, record('mixed-record', [])].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const mixedPair = createCppConversionRegistry().narrowing(mixed, left)
  assert.ok(mixedPair)
  assert.equal(mixedPair.materializer.nativeFieldProtocol, undefined)
})

test('authenticated own-key queries preserve native property layouts but unknown calls still expose them', () => {
  const value = record('queried-container', [
    { key: 'items', value: { kind: 'array-object', element: { kind: 'string' }, ownership: 'owned', extension: null } }
  ])
  const query = {
    kind: 'call',
    lineage,
    callee: operand('intrinsic-keys', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('queried-container', value)],
    result: null,
    intrinsicOwnKeys: true
  } as IrOperation
  const exposure = reflectionExposureOf([bodyOf([query])], new Map(), null, { representations: [value], shakeComplete: true })
  assert.equal(exposure.records.get('queried-container' as never)?.level, 'keys-only')
  const { intrinsicOwnKeys: _proof, ...unknown } = query as Extract<IrOperation, { kind: 'call' }>
  const escaped = reflectionExposureOf([bodyOf([query, unknown])], new Map(), null, { representations: [value], shakeComplete: true })
  assert.equal(escaped.records.get('queried-container' as never)?.level, 'full')
  const nativeIndex = recordWithIndex('queried-indexed', [])
  const indexed = { ...query, arguments: [operand('indexed', nativeIndex)] } as IrOperation
  const retained = reflectionExposureOf([bodyOf([indexed])], new Map(), null, { representations: [nativeIndex], shakeComplete: true })
  assert.equal(retained.records.get('queried-indexed' as never)?.level, 'keys-only')
})

test('a typed fixed record field read retains keys-only protocol', () => {
  const point = record('point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const key = {
    kind: 'constant',
    lineage,
    text: 'x',
    literal: 'string',
    result: { id: 'key', representation: { kind: 'string' } }
  } as never
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('point', point),
    key: operand('key', { kind: 'string' }),
    result: { id: 'read', representation: { kind: 'scalar', domain: 'number' } }
  } as never
  const exposure = reflectionExposureOf([bodyOf([key, read])], new Map(), null, { representations: [point], shakeComplete: true })
  assert.equal(exposure.records.get('point' as never)?.level, 'keys-only')
})

test('native presence queries do not publish field payloads, including runtime keys', () => {
  const child = record('presence-child', [{ key: 'number', value: { kind: 'scalar', domain: 'number' } }])
  const point = record('presence-point', [{ key: 'child', value: child }])
  const key = {
    kind: 'constant',
    lineage,
    text: 'child',
    literal: 'string',
    result: { id: 'presence-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const has = {
    kind: 'has-property',
    lineage,
    receiver: operand('point', point),
    key: operand('presence-key', { kind: 'string' }),
    result: { id: 'present' as never, representation: { kind: 'scalar', domain: 'boolean' } }
  } as IrOperation
  const options = { representations: [point, child], shakeComplete: true }
  for (const operations of [[key, has], [has]]) {
    const exposure = reflectionExposureOf([bodyOf(operations)], new Map(), null, options)
    assert.equal(exposure.records.get('presence-point' as never)?.level, 'keys-only')
    assert.equal(exposure.records.get('presence-child' as never)?.level, 'keys-only')
  }
  const unknown = {
    kind: 'call',
    lineage,
    callee: operand('unknown', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('point', point)],
    result: null
  } as IrOperation
  const escaped = reflectionExposureOf([bodyOf([key, has, unknown])], new Map(), null, options)
  assert.equal(escaped.records.get('presence-point' as never)?.level, 'full')
  assert.equal(escaped.records.get('presence-child' as never)?.level, 'full')
  const incomplete = reflectionExposureOf([bodyOf([key, has])], new Map(), null, { ...options, shakeComplete: false })
  assert.equal(incomplete.records.get('presence-point' as never)?.level, 'full')
})

test('a certified finite-key computed read retains keys-only protocol', () => {
  const point = record('computed-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const number = { kind: 'scalar', domain: 'number' } as const
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('computed-point', point),
    key: operand('computed-key', { kind: 'string' }),
    result: { id: 'computed-read', representation: number },
    typedComputedRead: {
      kind: 'closed-record',
      receiver: representationKey(point),
      result: representationKey(number),
      arms: [{ key: 'x', source: number, conversion: 'conversion:test' }]
    }
  } as never
  const exposure = reflectionExposureOf([bodyOf([read])], new Map(), null, {
    representations: [point],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('computed-point' as never)?.level, 'keys-only')
})

test('computed-read finalization keeps only recipes covered by joined record demand', () => {
  const point = record('finalize-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const number = { kind: 'scalar', domain: 'number' } as const
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('finalize-point', point),
    key: operand('finalize-key', { kind: 'string' }),
    result: { id: 'finalize-read', representation: number },
    typedComputedRead: {
      kind: 'closed-record',
      receiver: representationKey(point),
      result: representationKey(number),
      arms: [{ key: 'x', source: number, conversion: 'conversion:finalize' }]
    }
  } as never
  const body = bodyOf([read])
  const bodyId = 'finalize-body' as never
  const retain = finalizeTypedComputedReads(
    new Map([[bodyId, body]]),
    reflectionExposureOf([body], new Map(), null, { representations: [point], shakeComplete: true })
  )
  const retained = [...retain.values()][0]!
  const retainedOperation = [...retained.blocks.values()][0]!.operations[0] as { typedComputedRead?: unknown }
  assert.equal(retainedOperation.typedComputedRead !== undefined, true)

  const drop = finalizeTypedComputedReads(
    new Map([[bodyId, body]]),
    reflectionExposureOf([body], new Map(), null, { representations: [point], shakeComplete: false })
  )
  const dropped = [...drop.values()][0]!
  const droppedOperation = [...dropped.blocks.values()][0]!.operations[0] as { typedComputedRead?: unknown }
  assert.equal(droppedOperation.typedComputedRead, undefined)

  const incomplete = finalizeTypedComputedReads(new Map([[bodyId, body]]), {
    ...reflectionExposureOf([body], new Map(), null, { representations: [point], shakeComplete: true }),
    complete: false
  })
  const incompleteOperation = [...[...incomplete.values()][0]!.blocks.values()][0]!.operations[0] as { typedComputedRead?: unknown }
  assert.equal(incompleteOperation.typedComputedRead, undefined)
})

test('a sealed local binding write remains keys-only when its carrier matches', () => {
  const point = record('bound-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const binding = 'binding-point' as never
  const write = {
    kind: 'binding-write',
    lineage,
    declaration: binding,
    value: operand('point', point)
  } as never
  const key = {
    kind: 'constant',
    lineage,
    text: 'x',
    literal: 'string',
    result: { id: 'bound-key', representation: { kind: 'string' } }
  } as never
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('point', point),
    key: operand('bound-key', { kind: 'string' }),
    result: { id: 'bound-read', representation: { kind: 'scalar', domain: 'number' } }
  } as never
  const exposure = reflectionExposureOf([bodyOf([write, key, read])], new Map(), null, {
    representations: [point],
    shakeComplete: true,
    placements: new Map([[binding, { storage: { kind: 'local', owner: 'reflection-test-owner' as never }, representation: point }]])
  })
  assert.equal(exposure.records.get('bound-point' as never)?.level, 'keys-only')
})

test('a mismatched native field result refuses keys-only omission', () => {
  const point = record('mismatch-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const key = {
    kind: 'constant',
    lineage,
    text: 'x',
    literal: 'string',
    result: { id: 'mismatch-key', representation: { kind: 'string' } }
  } as never
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('point', point),
    key: operand('mismatch-key', { kind: 'string' }),
    result: { id: 'mismatch-read', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const exposure = reflectionExposureOf([bodyOf([key, read])], new Map(), null, { representations: [point], shakeComplete: true })
  assert.equal(exposure.records.get('mismatch-point' as never)?.level, 'full')
})

test('a compiler-owned fixed class field read keeps the class protocol keys-only', () => {
  const declaration = 'ClassPoint' as never
  const child = record('class-point-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const callbackResult = record('class-point-callback-result', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const callback: Representation = {
    kind: 'function',
    functionId: 'class-point-callback' as never,
    abi: { parameters: [], result: callbackResult, receiver: null, restFrom: null }
  }
  const shape = record('class-point-shape', [
    { key: 'x', value: { kind: 'scalar', domain: 'number' } },
    { key: 'child', value: child },
    { key: 'callback', value: callback }
  ])
  const point: Representation = { kind: 'class-ref', declaration, shapeId: 'class-point-shape', ownership: 'owned', ancestors: [] }
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    construct: null,
    instance: point,
    constructor: null,
    fields: [
      {
        declaration: 'ClassPoint.x' as never,
        key: 'x',
        initializer: null,
        representation: { kind: 'scalar', domain: 'number' },
        syntheticSubclassMemberOverlay: false
      },
      {
        declaration: 'ClassPoint.child' as never,
        key: 'child',
        initializer: null,
        representation: child,
        syntheticSubclassMemberOverlay: false
      },
      {
        declaration: 'ClassPoint.callback' as never,
        key: 'callback',
        initializer: null,
        representation: callback,
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  } as never
  const key = {
    kind: 'constant',
    lineage,
    text: 'x',
    literal: 'string',
    result: { id: 'class-key', representation: { kind: 'string' } }
  } as never
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('class-point', point),
    key: operand('class-key', { kind: 'string' }),
    result: { id: 'class-read', representation: { kind: 'scalar', domain: 'number' } }
  } as never
  const deriver = { layoutOf: () => shape } as never
  const exposure = reflectionExposureOf([bodyOf([key, read])], new Map([[declaration, layout]]), deriver, {
    representations: [point, child, callbackResult],
    shakeComplete: true
  })
  assert.equal(exposure.classes.get(declaration)?.level, 'keys-only')
  assert.equal(exposure.records.get('class-point-child' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('class-point-callback-result' as never)?.level, 'keys-only')
})

test('a class-to-dynamic escape promotes the parent and every nested carrier', () => {
  const declaration = 'EscapingClass' as never
  const child = record('escaping-class-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const callbackResult = record('escaping-class-callback-result', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const callback: Representation = {
    kind: 'function',
    functionId: 'escaping-class-callback' as never,
    abi: { parameters: [], result: callbackResult, receiver: null, restFrom: null }
  }
  const shape = record('escaping-class-shape', [
    { key: 'child', value: child },
    { key: 'callback', value: callback }
  ])
  const value: Representation = { kind: 'class-ref', declaration, shapeId: 'escaping-class-shape', ownership: 'owned', ancestors: [] }
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    construct: null,
    instance: value,
    constructor: null,
    fields: [
      {
        declaration: 'EscapingClass.child' as never,
        key: 'child',
        initializer: null,
        representation: child,
        syntheticSubclassMemberOverlay: false
      },
      {
        declaration: 'EscapingClass.callback' as never,
        key: 'callback',
        initializer: null,
        representation: callback,
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  } as never
  const converted = {
    kind: 'convert',
    lineage,
    source: operand('escaping-class', value),
    result: { id: 'escaping-dynamic', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const exposure = reflectionExposureOf([bodyOf([converted])], new Map([[declaration, layout]]), { layoutOf: () => shape } as never, {
    representations: [value, child, callbackResult],
    shakeComplete: true
  })
  assert.equal(exposure.classes.get(declaration)?.level, 'full')
  assert.equal(exposure.records.get('escaping-class-child' as never)?.level, 'full')
  assert.equal(exposure.records.get('escaping-class-callback-result' as never)?.level, 'full')
})

test('a class shape with an index sidecar cannot use the fixed-slot proof', () => {
  const declaration = 'IndexedClass' as never
  const shape = recordWithIndex('indexed-class-shape', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const value: Representation = { kind: 'class-ref', declaration, shapeId: 'indexed-class-shape', ownership: 'owned', ancestors: [] }
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    construct: null,
    instance: value,
    constructor: null,
    fields: [
      {
        declaration: 'IndexedClass.x' as never,
        key: 'x',
        initializer: null,
        representation: { kind: 'scalar', domain: 'number' },
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  } as never
  const exposure = reflectionExposureOf([], new Map([[declaration, layout]]), { layoutOf: () => shape } as never, {
    representations: [value],
    shakeComplete: true
  })
  assert.equal(exposure.classes.get(declaration)?.level, 'full')
})

test('retaining a prototype accessor does not expose a class own-field protocol', () => {
  const base = 'AccessorBase' as never
  const derived = 'AccessorDerived' as never
  const baseShape = record('accessor-base-shape', [])
  const derivedShape = record('accessor-derived-shape', [])
  const baseValue: Representation = {
    kind: 'class-ref',
    declaration: base,
    shapeId: 'accessor-base-shape',
    ownership: 'owned',
    ancestors: []
  }
  const derivedValue: Representation = {
    kind: 'class-ref',
    declaration: derived,
    shapeId: 'accessor-derived-shape',
    ownership: 'owned',
    ancestors: [base]
  }
  const layout = (declaration: never, value: Representation, classBase: string | null, accessors: readonly unknown[]) =>
    ({
      declaration,
      base: classBase,
      nativeBase: null,
      construct: null,
      instance: value,
      constructor: null,
      fields: [],
      fieldOwnership: [],
      methods: [],
      accessors,
      staticFields: [],
      staticMethods: [],
      staticAccessors: [],
      name: null,
      length: null
    }) as never
  const classes = new Map([
    [base, layout(base, baseValue, null, [{ key: 'value', getter: 'get-value' as never, setter: null }])],
    [derived, layout(derived, derivedValue, base, [])]
  ]) as never
  const exposure = reflectionExposureOf(
    [],
    classes,
    { layoutOf: (shapeId: string) => (shapeId === 'accessor-base-shape' ? baseShape : derivedShape) } as never,
    {
      representations: [derivedValue],
      shakeComplete: true
    }
  )
  assert.equal(exposure.classes.get(derived)?.level, 'keys-only')
  const payload = record('unproven-accessor-payload', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const getter = functionBodyOf('get-value', { receiver: baseValue, result: payload, parameters: [], restFrom: null }, [])
  const unknownRead = bodyOf([
    {
      kind: 'constant',
      lineage,
      literal: 'string',
      text: 'value',
      result: { id: 'accessor-key' as never, representation: { kind: 'string' } }
    },
    {
      kind: 'get',
      lineage,
      receiver: operand('instance', derivedValue),
      key: operand('accessor-key', { kind: 'string' }),
      result: { id: 'erased-accessor-result' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
    }
  ])
  const observed = reflectionExposureOf(
    [unknownRead, getter],
    classes,
    { layoutOf: (shapeId: string) => (shapeId === 'accessor-base-shape' ? baseShape : derivedShape) } as never,
    { representations: [derivedValue, payload], shakeComplete: true }
  )
  assert.equal(observed.classes.get(derived)?.level, 'full')
  assert.equal(observed.records.get('unproven-accessor-payload' as never)?.level, 'full')
})

test('a class setter entry consumes a cited payload-preserving argument conversion', () => {
  // three's `this.image = images` (CubeDepthTexture.js:35): the setter's formal
  // is a sum the written array is one arm of.
  const declaration = 'AccessorTexture' as never
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const texture: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'accessor-texture-shape',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const images: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
  const image: Representation = {
    kind: 'optional',
    absence: 'undefined',
    payload: {
      kind: 'tagged-union',
      arms: [texture, images].map((value, index) => ({
        tag: String(index),
        value,
        semanticType: `accessor-image-${index}` as never,
        runtimeDiscriminator: { kind: 'carrier' as const }
      }))
    }
  }
  const classes = new Map([
    [
      declaration,
      {
        declaration,
        base: null,
        nativeBase: null,
        construct: null,
        instance: texture,
        constructor: null,
        fields: [],
        fieldOwnership: [],
        methods: [],
        accessors: [{ key: 'image', getter: null, setter: 'set-image' as never }],
        staticFields: [],
        staticMethods: [],
        staticAccessors: [],
        name: null,
        length: null
      }
    ]
  ]) as never
  const setter = functionBodyOf(
    'set-image',
    {
      receiver: texture,
      parameters: [{ value: image, passing: 'by-value', ownership: 'owned' }],
      result: { kind: 'void' },
      restFrom: null
    } as never,
    []
  )
  const store = bodyOf([
    {
      kind: 'constant',
      lineage,
      literal: 'string',
      text: 'image',
      result: { id: 'image-key' as never, representation: { kind: 'string' } }
    },
    {
      kind: 'set',
      lineage,
      receiver: operand('texture', texture),
      key: operand('image-key', { kind: 'string' }),
      value: operand('images', images),
      result: null
    } as never
  ])
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const demand = () =>
    reflectionExposureOf([store, setter], classes, { layoutOf: () => record('accessor-texture-shape', []) } as never, {
      representations: [texture],
      conversions,
      shakeComplete: true
    }).classes.get(declaration)?.level
  assert.equal(demand(), 'full', 'a compatible frame alone is not a conversion proof')
  conversions.nodeFor(images, image)
  assert.notEqual(demand(), 'full')
})

test('an unknown class operation closes the full base and derived protocol family', () => {
  const base = 'ClassBase' as never
  const derived = 'ClassDerived' as never
  const baseShape = record('class-base-shape', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const derivedShape = record('class-derived-shape', [{ key: 'y', value: { kind: 'scalar', domain: 'number' } }])
  const baseRef: Representation = {
    kind: 'class-ref',
    declaration: base,
    shapeId: 'class-base-shape',
    ownership: 'owned',
    ancestors: []
  }
  const derivedRef: Representation = {
    kind: 'class-ref',
    declaration: derived,
    shapeId: 'class-derived-shape',
    ownership: 'owned',
    ancestors: [base]
  }
  const layoutOf = (declaration: never, instance: Representation, key: string, value: Representation) =>
    ({
      declaration,
      base: null,
      nativeBase: null,
      construct: null,
      instance,
      constructor: null,
      fields: [
        {
          declaration: `${String(declaration)}.${key}` as never,
          key,
          initializer: null,
          representation: value,
          syntheticSubclassMemberOverlay: false
        }
      ],
      fieldOwnership: [],
      methods: [],
      accessors: [],
      staticFields: [],
      staticMethods: [],
      staticAccessors: [],
      name: null,
      length: null
    }) as never
  const derivedLayout = layoutOf(derived, derivedRef, 'y', { kind: 'scalar', domain: 'number' }) as unknown as Record<string, unknown>
  derivedLayout.base = base
  const classes = new Map([
    [base, layoutOf(base, baseRef, 'x', { kind: 'scalar', domain: 'number' })],
    [derived, derivedLayout]
  ]) as never
  const dynamicKey = operand('dynamic-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('base', baseRef),
    key: dynamicKey,
    result: { id: 'dynamic-class-read', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const exposure = reflectionExposureOf(
    [bodyOf([read])],
    classes,
    { layoutOf: (shapeId: string) => (shapeId === 'class-base-shape' ? baseShape : derivedShape) } as never,
    {
      representations: [baseRef, derivedRef],
      shakeComplete: true
    }
  )
  assert.equal(exposure.classes.get(base)?.level, 'full')
  assert.equal(exposure.classes.get(derived)?.level, 'full')
})

/** Shared by the `provenKeyTexts` pair below: a base/subclass family with one field each, so the field's own class family agrees. */
const provenFamilyLayoutOf = (declaration: never, instance: Representation, key: string, value: Representation) =>
  ({
    declaration,
    base: null,
    nativeBase: null,
    construct: null,
    instance,
    constructor: null,
    fields: [
      {
        declaration: `${String(declaration)}.${key}` as never,
        key,
        initializer: null,
        representation: value,
        syntheticSubclassMemberOverlay: false
      }
    ],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  }) as never

test('a computed key with a proven finite name set publishes only the proven fields, not the whole class family graph', () => {
  const base = 'ProvenBase' as never
  const derived = 'ProvenDerived' as never
  const baseChild = record('proven-base-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const derivedChild = record('proven-derived-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const baseShape = record('proven-base-shape', [{ key: 'x', value: baseChild }])
  const derivedShape = record('proven-derived-shape', [{ key: 'y', value: derivedChild }])
  const baseRef: Representation = { kind: 'class-ref', declaration: base, shapeId: 'proven-base-shape', ownership: 'owned', ancestors: [] }
  const derivedRef: Representation = {
    kind: 'class-ref',
    declaration: derived,
    shapeId: 'proven-derived-shape',
    ownership: 'owned',
    ancestors: [base]
  }
  const derivedLayout = provenFamilyLayoutOf(derived, derivedRef, 'y', derivedChild) as unknown as Record<string, unknown>
  derivedLayout.base = base
  const classes = new Map([
    [base, provenFamilyLayoutOf(base, baseRef, 'x', baseChild)],
    [derived, derivedLayout]
  ]) as never
  const dynamicKey = operand('dynamic-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
  // `this[ key ] = newValue` under a computed key three's `Material.setValues`
  // shape produces -- where the census closed `key` to `{ 'y' }`. `y` is
  // declared only on the SUBCLASS, exactly like `MeshPhongMaterial.shininess`
  // read off a `this` typed `Material`.
  const proven = {
    kind: 'get',
    lineage,
    receiver: operand('base', baseRef),
    key: dynamicKey,
    result: { id: 'proven-read' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } },
    provenKeyTexts: ['y']
  } as never
  const exposure = reflectionExposureOf(
    [bodyOf([proven])],
    classes,
    { layoutOf: (shapeId: string) => (shapeId === 'proven-base-shape' ? baseShape : derivedShape) } as never,
    { representations: [baseRef, derivedRef, baseChild, derivedChild], shakeComplete: true }
  )
  // The receiver's whole class family still needs a member-dispatch entry --
  // the key names ONE OF a proven set, not a single fixed field --
  // `promoteNamedField` fans a `class-ref` receiver out across bases and
  // subclasses for exactly this reason.
  assert.equal(exposure.classes.get(base)?.level, 'full')
  assert.equal(exposure.classes.get(derived)?.level, 'full')
  // But only the PROVEN field's own value is exposed. `x` is never in the
  // proven set, so its record stays keys-only -- the whole point of per-field
  // demand instead of `promoteFull`'s whole-reachable-graph promotion.
  assert.equal(exposure.records.get('proven-derived-child' as never)?.level, 'full')
  assert.equal(exposure.records.get('proven-base-child' as never)?.level, 'keys-only')
})

test('the same computed key with no proven set falls back to the whole reachable carrier graph', () => {
  const base = 'UnprovenBase' as never
  const derived = 'UnprovenDerived' as never
  const baseChild = record('unproven-base-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const derivedChild = record('unproven-derived-child', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const baseShape = record('unproven-base-shape', [{ key: 'x', value: baseChild }])
  const derivedShape = record('unproven-derived-shape', [{ key: 'y', value: derivedChild }])
  const baseRef: Representation = {
    kind: 'class-ref',
    declaration: base,
    shapeId: 'unproven-base-shape',
    ownership: 'owned',
    ancestors: []
  }
  const derivedRef: Representation = {
    kind: 'class-ref',
    declaration: derived,
    shapeId: 'unproven-derived-shape',
    ownership: 'owned',
    ancestors: [base]
  }
  const derivedLayout = provenFamilyLayoutOf(derived, derivedRef, 'y', derivedChild) as unknown as Record<string, unknown>
  derivedLayout.base = base
  const classes = new Map([
    [base, provenFamilyLayoutOf(base, baseRef, 'x', baseChild)],
    [derived, derivedLayout]
  ]) as never
  const dynamicKey = operand('dynamic-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
  // Identical shape to the test above, but with no `provenKeyTexts` at all --
  // an unresolved computed key the census could not (or was never asked to)
  // narrow.
  const unproven = {
    kind: 'get',
    lineage,
    receiver: operand('base', baseRef),
    key: dynamicKey,
    result: { id: 'unproven-read' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const exposure = reflectionExposureOf(
    [bodyOf([unproven])],
    classes,
    { layoutOf: (shapeId: string) => (shapeId === 'unproven-base-shape' ? baseShape : derivedShape) } as never,
    { representations: [baseRef, derivedRef, baseChild, derivedChild], shakeComplete: true }
  )
  assert.equal(exposure.classes.get(base)?.level, 'full')
  assert.equal(exposure.classes.get(derived)?.level, 'full')
  // With no proven key set, an unresolved computed key still promotes the
  // WHOLE reachable carrier graph -- `x`'s record included -- which is
  // exactly the behaviour `provenKeyTexts` narrows away from in the test
  // above.
  assert.equal(exposure.records.get('unproven-derived-child' as never)?.level, 'full')
  assert.equal(exposure.records.get('unproven-base-child' as never)?.level, 'full')
})

test('inherited reflection support does not expose siblings, but a later base escape does', () => {
  const references = ['Root', 'Left', 'LeftLeaf', 'Right'].map((name): Extract<Representation, { kind: 'class-ref' }> => ({
    kind: 'class-ref',
    declaration: name as never,
    shapeId: `${name}-shape`,
    ownership: 'shared-refcount',
    ancestors: (name === 'Root' ? [] : name === 'LeftLeaf' ? ['Left', 'Root'] : ['Root']) as never
  }))
  const [root, left, leaf, right] = references
  assert.ok(root && left && leaf && right)
  const inheritedChild = record('inherited-child', [{ key: 'value', value: { kind: 'string' } }])
  const siblingChild = record('sibling-child', [{ key: 'value', value: { kind: 'string' } }])
  const shapes = new Map(
    references.map((instance) => [
      instance.shapeId,
      record(instance.shapeId, [
        { key: 'payload', value: instance === root ? inheritedChild : instance === right ? siblingChild : { kind: 'string' } }
      ])
    ])
  )
  const classes = new Map(
    references.map((instance) => [
      instance.declaration,
      {
        declaration: instance.declaration,
        base: instance === root ? null : instance === leaf ? left.declaration : root.declaration,
        nativeBase: null,
        construct: null,
        instance,
        constructor: null,
        fields: [],
        fieldOwnership: [],
        methods: [],
        accessors: [],
        staticFields: [],
        staticMethods: [],
        staticAccessors: [],
        name: null,
        length: null
      }
    ])
  )
  const read = (receiver: Representation): IrOperation =>
    ({
      kind: 'get',
      lineage,
      receiver: operand(`receiver-${representationKey(receiver)}`, receiver),
      key: operand('dynamic-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
      result: { id: `read-${representationKey(receiver)}`, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
    }) as never
  const expose = (operations: readonly IrOperation[]) =>
    reflectionExposureOf([bodyOf(operations)], classes, { layoutOf: (shapeId: string) => shapes.get(shapeId) } as never, {
      representations: [...references, inheritedChild, siblingChild],
      shakeComplete: true
    })
  const onlyLeft = expose([read(left)])
  for (const instance of [root, left, leaf]) assert.equal(onlyLeft.classes.get(instance.declaration)?.level, 'full')
  assert.equal(onlyLeft.classes.get(right.declaration)?.level, 'keys-only')
  assert.equal(onlyLeft.records.get('inherited-child' as never)?.level, 'full')
  assert.equal(onlyLeft.records.get('sibling-child' as never)?.level, 'keys-only')
  for (const operations of [
    [read(left), read(root)],
    [read(root), read(left)]
  ]) {
    const escapedBase = expose(operations)
    assert.equal(escapedBase.classes.get(right.declaration)?.level, 'full')
    assert.equal(escapedBase.records.get('sibling-child' as never)?.level, 'full')
  }
  // An inherited field holding a base-typed object really does expose every
  // descendant of that payload. Support demand cannot restrict field values.
  shapes.set(root.shapeId, record(root.shapeId, [{ key: 'parent', value: root }]))
  assert.equal(expose([read(left)]).classes.get(right.declaration)?.level, 'full')
})

test('dynamic conversion exposes nested record carriers and unknown calls expose arguments', () => {
  const inner = record('inner', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const outer = record('outer', [{ key: 'inner', value: inner }])
  const converted = {
    kind: 'convert',
    lineage,
    source: operand('outer', outer),
    result: { id: 'dynamic', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('outer', outer)],
    result: null
  } as never
  const exposure = reflectionExposureOf([bodyOf([converted, call])], new Map(), null, {
    representations: [outer, inner],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('outer' as never)?.level, 'full')
  assert.equal(exposure.records.get('inner' as never)?.level, 'full')
})

test('missing shake facts retain full protocol for every sealed candidate', () => {
  const value = record('missing-shake', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const exposure = reflectionExposureOf([], new Map(), null, { representations: [value], shakeComplete: false })
  assert.equal(exposure.complete, false)
  assert.equal(exposure.records.get('missing-shake' as never)?.level, 'full')
})

test('an external callable ABI retains its record result even without a lowered body', () => {
  const result = record('external-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { parameters: [], result, receiver: null, restFrom: null }
  }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('external-callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('external-callable', callable)],
    result: null
  } as never
  for (const value of [callable, { kind: 'optional', payload: callable, absence: 'undefined' } as const]) {
    const exposure = reflectionExposureOf([bodyOf([call])], new Map(), null, { representations: [result, value], shakeComplete: true })
    assert.equal(exposure.records.get('external-result' as never)?.level, 'full')
  }
})

test('an unmaterialized callable ABI in the sealed plan does not retain its result', () => {
  const result = record('dead-callable-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { parameters: [], result, receiver: null, restFrom: null }
  }
  const exposure = reflectionExposureOf([], new Map(), null, { representations: [result, callable], shakeComplete: true })
  assert.equal(exposure.records.get('dead-callable-result' as never)?.level, 'keys-only')
})

test('an unknown call result retains reflection without an inspectable callee ABI', () => {
  const result = record('call-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [],
    result: { id: 'result', representation: result }
  } as never
  const exposure = reflectionExposureOf([bodyOf([call])], new Map(), null, { representations: [result], shakeComplete: true })
  assert.equal(exposure.records.get('call-result' as never)?.level, 'full')
})

test('a direct call with a matching generated ABI keeps returned records keys-only', () => {
  const result = record('closed-return', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|closed-return' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'call-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('returned', result)), bodyOf([call])],
    new Map(),
    null,
    {
      representations: [callable, result],
      shakeComplete: true
    }
  )
  assert.equal(exposure.records.get('closed-return' as never)?.level, 'keys-only')
})

test('a closed direct return admits nested compiler-owned record fields', () => {
  const inner = record('closed-nested-inner', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const result = record('closed-nested-outer', [{ key: 'inner', value: inner }])
  const functionId = 'fn|closed-nested' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'nested-call-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('nested-return', result)), bodyOf([call])],
    new Map(),
    null,
    { representations: [callable, result, inner], shakeComplete: true }
  )
  assert.equal(exposure.records.get('closed-nested-outer' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('closed-nested-inner' as never)?.level, 'keys-only')
})

test('a native returned record and its indexed child do not expose their value protocols', () => {
  const inner = recordWithIndex('indexed-nested-inner', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const result = record('indexed-nested-outer', [{ key: 'inner', value: inner }])
  const functionId = 'fn|indexed-nested' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'indexed-call-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('indexed-return', result)), bodyOf([call])],
    new Map(),
    null,
    { representations: [callable, result, inner], shakeComplete: true }
  )
  assert.equal(exposure.records.get('indexed-nested-outer' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('indexed-nested-inner' as never)?.level, 'keys-only')
})

test('an unproven container field does not publish its child without a dynamic operation', () => {
  const inner = record('container-child', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const array: Representation = {
    kind: 'array-object',
    element: inner,
    ownership: 'owned',
    extension: [{ key: 'sym(container-marker)', value: { kind: 'scalar', domain: 'number' }, required: true }]
  }
  // Ordinary native arrays now have a proven protocol. A symbol extension
  // keeps this fixture about an unproven surface without exposing its items.
  assert.equal(hasNativePropertyLayout(array, null, new Map()), false)
  const outer = record('container-parent', [{ key: 'items', value: array }])
  const exposure = reflectionExposureOf([], new Map(), null, {
    representations: [outer, array, inner],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('container-parent' as never)?.level, 'keys-only')
  assert.equal(exposure.byRepresentation.get(representationKey(array))?.level, 'full')
  assert.equal(exposure.records.get('container-child' as never)?.level, 'keys-only')
})

test('a dynamic operation on an unproven container closes its nested child', () => {
  const inner = record('dynamic-container-child', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const array: Representation = { kind: 'array-object', element: inner, ownership: 'owned', extension: null }
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('dynamic-array', array),
    key: operand('dynamic-container-key', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    result: { id: 'dynamic-container-read', representation: inner }
  } as never
  const exposure = reflectionExposureOf([bodyOf([read])], new Map(), null, {
    representations: [array, inner],
    shakeComplete: true
  })
  assert.equal(exposure.byRepresentation.get(representationKey(array))?.level, 'full')
  assert.equal(exposure.records.get('dynamic-container-child' as never)?.level, 'full')
})

test('a representation-preserving conversion does not create an escape', () => {
  const value = record('identity-conversion', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const convert = {
    kind: 'convert',
    lineage,
    source: operand('identity-source', value),
    result: { id: 'identity-result', representation: value }
  } as never
  const exposure = reflectionExposureOf([bodyOf([convert])], new Map(), null, {
    representations: [value],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('identity-conversion' as never)?.level, 'keys-only')
})

test('a typed construct with a matching construct ABI keeps its result keys-only', () => {
  const result = record('construct-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|construct-result' as never
  const callAbi = { parameters: [], result: result as Representation, receiver: null, restFrom: null }
  const constructAbi = { parameters: [], result: result as Representation, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi: callAbi }
  const construct = {
    kind: 'construct',
    lineage,
    callee: operand('construct-callee', callable),
    newTarget: operand('construct-new-target', callable),
    target: { kind: 'exact', target: { kind: 'function', functionId, constructable: true }, evidence: ['test'] },
    arguments: [],
    result: { id: 'construct-result-value', representation: result }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, callAbi, [], null, constructAbi), bodyOf([construct])],
    new Map(),
    null,
    { representations: [callable, result], shakeComplete: true }
  )
  assert.equal(exposure.records.get('construct-result' as never)?.level, 'keys-only')
})

test('a written class constructor uses its class-body ABI, not body.construct', () => {
  const result = record('written-class-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const declaration = 'WrittenClass' as never
  const functionId = 'fn|written-class-constructor' as never
  const instanceShape = record('written-class-shape', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const instance: Representation = { kind: 'class-ref', declaration, shapeId: 'written-class-shape', ownership: 'owned', ancestors: [] }
  const bodyAbi = { parameters: [], result: { kind: 'void' }, receiver: instance, restFrom: null }
  const constructAbi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'constructor-family', members: [declaration], abi: constructAbi }
  const construct = {
    kind: 'construct',
    lineage,
    callee: operand('written-class-callee', callable),
    newTarget: operand('written-class-new-target', callable),
    target: { kind: 'exact', target: { kind: 'function', functionId, constructable: false }, evidence: ['test'] },
    arguments: [],
    result: { id: 'written-class-result-value', representation: result }
  } as never
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    construct: constructAbi,
    instance,
    constructor: functionId,
    fields: [],
    fieldOwnership: [],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, bodyAbi as never, [], null), bodyOf([construct])],
    new Map([[declaration, layout]]),
    { layoutOf: () => instanceShape } as never,
    { representations: [callable, instance, result], shakeComplete: true }
  )
  assert.equal(exposure.classes.get(declaration)?.level, 'keys-only')
  assert.equal(exposure.records.get('written-class-result' as never)?.level, 'keys-only')
})

test('an unknown construct remains a dynamic boundary', () => {
  const result = record('unknown-construct-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|unknown-construct' as never
  const callable: Representation = {
    kind: 'function',
    functionId,
    abi: { parameters: [], result, receiver: null, restFrom: null }
  }
  const construct = {
    kind: 'construct',
    lineage,
    callee: operand('unknown-construct-callee', callable),
    newTarget: operand('unknown-new-target', callable),
    target: { kind: 'open', evidence: ['test'] },
    arguments: [],
    result: { id: 'unknown-construct-result-value', representation: result }
  } as never
  const exposure = reflectionExposureOf([bodyOf([construct])], new Map(), null, {
    representations: [callable, result],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('unknown-construct-result' as never)?.level, 'full')
})

const hostConstructor = (protocol: string, construct: Extract<Representation, { kind: 'native-handle' }>['construct'] = null) =>
  ({ kind: 'native-handle', protocol, version: 1, native: null, bases: [], call: null, construct }) as Representation

const hostConstruct = (
  callee: Representation,
  result: Representation,
  args: readonly ReturnType<typeof operand>[],
  overrides: Record<string, unknown> = {}
): IrOperation =>
  ({
    kind: 'construct',
    lineage,
    callee: operand('host-constructor', callee),
    newTarget: operand('host-constructor', callee),
    target: { kind: 'open', evidence: ['test'] },
    arguments: args,
    result: { id: 'host-construct-result', representation: result },
    ...overrides
  }) as never

test('a fresh host collection built through its selected frame publishes none of the records it will hold', () => {
  const bag = record('host-construct-bag', [{ key: 'version', value: { kind: 'scalar', domain: 'number' } }])
  const collection: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: { kind: 'string' },
    value: bag,
    ownership: 'shared-refcount'
  }
  const callee = hostConstructor('MapConstructor')
  const hostFrame = { parameters: [], restFrom: null, receiver: null, result: collection }
  const demand = (operation: IrOperation) =>
    reflectionExposureOf([bodyOf([operation])], new Map(), null, {
      representations: [callee, collection, bag],
      shakeComplete: true
    }).records.get('host-construct-bag' as never)?.level
  assert.equal(demand(hostConstruct(callee, collection, [], { hostFrame })), 'keys-only')
  assert.equal(demand(hostConstruct(callee, collection, [])), 'full', 'a site with no selected frame is an unknown construction')
  assert.equal(
    demand(hostConstruct(callee, collection, [], { hostFrame, newTarget: operand('other-new-target', callee) })),
    'full',
    'a construction whose new-target is not its callee'
  )
  assert.equal(
    demand(hostConstruct(callee, collection, [], { hostFrame: { ...hostFrame, result: { ...collection, family: 'weak-map' } } })),
    'full',
    'a frame minting another carrier than the one this site holds'
  )
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const boxedFrame = { ...hostFrame, result: dynamic }
  const boxed = reflectionExposureOf(
    [bodyOf([hostConstruct(callee, dynamic, [operand('boxed-bag', bag)], { hostFrame: boxedFrame })])],
    new Map(),
    null,
    {
      representations: [callee, bag],
      shakeComplete: true
    }
  )
  assert.equal(boxed.records.get('host-construct-bag' as never)?.level, 'full', 'a dynamic result (`new Proxy`) stays open')
})

test('a host construction argument closes only when the census carries it natively into its formal', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const element = record('host-construct-element', [{ key: 'id', value: number }])
  const elements: Representation = { kind: 'array-object', element, ownership: 'shared-refcount', extension: null }
  const set: Representation = { kind: 'keyed-collection', family: 'set', key: element, value: null, ownership: 'shared-refcount' }
  const callee = hostConstructor('SetConstructor')
  const frameFor = (formal: Representation) => ({
    parameters: [{ value: formal, ownership: 'owned' as const, passing: 'by-value' as const }],
    restFrom: null,
    receiver: null,
    result: set
  })
  const demand = (formal: Representation) =>
    reflectionExposureOf(
      [bodyOf([hostConstruct(callee, set, [operand('elements', elements)], { hostFrame: frameFor(formal) })])],
      new Map(),
      null,
      { representations: [callee, set, elements, element], shakeComplete: true }
    ).records.get('host-construct-element' as never)?.level
  assert.equal(demand(elements), 'keys-only', 'the pre-existing array reaches its formal in its own native carrier')
  assert.equal(
    demand({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    'full',
    'an argument whose formal would box it is an open boundary'
  )

  // A handle that states its own joined convention is asked for that one:
  // `ErrorConstructor`'s `(message?: string)` receives a string through the
  // census's native optional injection, and only through a census node.
  const error = record('host-construct-error', [{ key: 'message', value: { kind: 'string' } }])
  const message: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
  const errorCallee = hostConstructor('ErrorConstructor', {
    parameters: [{ value: message, ownership: 'owned', passing: 'by-value' }],
    restFrom: null,
    receiver: null,
    result: error
  })
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const errorDemand = () =>
    reflectionExposureOf([bodyOf([hostConstruct(errorCallee, error, [operand('message', { kind: 'string' })])])], new Map(), null, {
      representations: [errorCallee, error],
      conversions,
      shakeComplete: true
    }).records.get('host-construct-error' as never)?.level
  assert.equal(errorDemand(), 'full', 'a compatible shape alone is not a transfer proof')
  conversions.nodeFor({ kind: 'string' }, message)
  assert.equal(errorDemand(), 'keys-only')
})

test('a store reaching a declared slot through a payload-preserving native conversion does not publish the stored value', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const texture = record('uniform-texture', [{ key: 'image', value: number }])
  const matrix = record('uniform-matrix', [{ key: 'elements', value: number }])
  const sum: Representation = {
    kind: 'tagged-union',
    arms: [texture, matrix].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const uniform = record('uniform-slot', [{ key: 'value', value: sum }])
  const key: IrOperation = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'value',
    result: { id: 'uniform-key' as never, representation: { kind: 'string' } }
  }
  const set: IrOperation = {
    kind: 'set',
    lineage,
    strict: true,
    receiver: operand('uniform', uniform),
    key: operand('uniform-key', { kind: 'string' }),
    value: operand('texture', texture),
    result: null
  }
  const define = (writable: boolean): IrOperation => ({
    kind: 'define-own-property',
    lineage,
    receiver: operand('uniform', uniform),
    key: operand('uniform-key', { kind: 'string' }),
    value: operand('texture', texture),
    attributes: { writable, enumerable: true, configurable: true },
    result: null
  })
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const demand = (operation: IrOperation) => {
    const exposure = reflectionExposureOf([bodyOf([key, operation])], new Map(), null, {
      representations: [uniform, sum, texture, matrix],
      conversions,
      shakeComplete: true
    })
    return [exposure.records.get('uniform-texture' as never)?.level, exposure.records.get('uniform-slot' as never)?.level]
  }
  assert.deepEqual(demand(set), ['full', 'full'], 'a compatible shape alone is not a conversion proof')
  // The read direction's node never certifies a write.
  conversions.nodeFor(sum, texture)
  assert.deepEqual(demand(set), ['full', 'full'])
  const node = conversions.nodeFor(texture, sum)
  assert.equal('materializer' in node.capability ? node.capability.materializer.id : null, 'gea::native-sum::inject-alternative')
  assert.deepEqual(demand(set), ['keys-only', 'keys-only'])
  assert.deepEqual(demand(define(true)), ['keys-only', 'keys-only'])
  assert.deepEqual(demand(define(false)), ['full', 'full'], 'a non-default descriptor never takes the ordinary member store')
})

test('an exact-carrier definition of a declared slot closes only with the default descriptor', () => {
  const payload = record('define-exact-payload', [{ key: 'id', value: { kind: 'scalar', domain: 'number' } }])
  const holder = record('define-exact-holder', [{ key: 'payload', value: payload }])
  const key: IrOperation = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'payload',
    result: { id: 'define-exact-key' as never, representation: { kind: 'string' } }
  }
  const define = (attributes: { writable: boolean; enumerable: boolean; configurable: boolean }): IrOperation => ({
    kind: 'define-own-property',
    lineage,
    receiver: operand('define-exact-holder', holder),
    key: operand('define-exact-key', { kind: 'string' }),
    value: operand('define-exact-value', payload),
    attributes,
    result: null
  })
  const demand = (operation: IrOperation) => {
    const exposure = reflectionExposureOf([bodyOf([key, operation])], new Map(), null, {
      representations: [holder, payload],
      shakeComplete: true
    })
    return [exposure.records.get('define-exact-payload' as never)?.level, exposure.records.get('define-exact-holder' as never)?.level]
  }
  assert.deepEqual(demand(define({ writable: true, enumerable: true, configurable: true })), ['keys-only', 'keys-only'])
  for (const attributes of [
    { writable: false, enumerable: true, configurable: true },
    { writable: true, enumerable: false, configurable: true },
    { writable: true, enumerable: true, configurable: false }
  ])
    assert.deepEqual(demand(define(attributes)), ['full', 'full'], `a ${JSON.stringify(attributes)} definition is no native slot write`)
})

test('a nested compiler-owned native record reference follows its sealed layout', () => {
  const inner = record('native-layout-inner', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const reference: Representation = {
    kind: 'native-record-ref',
    shapeId: 'native-layout-inner',
    ownership: 'shared-refcount',
    native: null
  }
  const result = record('native-layout-outer', [{ key: 'inner', value: reference }])
  const functionId = 'fn|native-layout' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'native-layout-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const deriver = { layoutOf: () => inner } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('native-layout-return', result)), bodyOf([call])],
    new Map(),
    deriver,
    { representations: [callable, result, reference], shakeComplete: true }
  )
  assert.equal(exposure.records.get('native-layout-outer' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('native-layout-inner' as never)?.level, 'keys-only')
})

test('a closed cyclic record has fixed slots until an operation exposes its fields', () => {
  const reference: Representation = {
    kind: 'native-record-ref',
    shapeId: 'cyclic-layout',
    ownership: 'shared-refcount',
    native: null
  }
  const layout = record('cyclic-layout', [{ key: 'next', value: reference }])
  const result = record('cyclic-outer', [{ key: 'node', value: reference }])
  const functionId = 'fn|cyclic-layout' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'cyclic-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const deriver = { layoutOf: () => layout } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('cyclic-return', result)), bodyOf([call])],
    new Map(),
    deriver,
    { representations: [callable, result, reference], shakeComplete: true }
  )
  assert.equal(exposure.records.get('cyclic-outer' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('cyclic-layout' as never)?.level, 'keys-only')
  const escape = {
    kind: 'convert',
    lineage,
    source: operand('escaping-cycle', result),
    result: { id: 'boxed-cycle', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as never
  const escaped = reflectionExposureOf([bodyOf([escape])], new Map(), deriver, {
    representations: [result, reference],
    shakeComplete: true
  })
  assert.equal(escaped.records.get('cyclic-outer' as never)?.level, 'full')
  assert.equal(escaped.records.get('cyclic-layout' as never)?.level, 'full')
})

test('a host-owned native record reference remains a full protocol boundary', () => {
  const hostReference: Representation = {
    kind: 'native-record-ref',
    shapeId: 'host-layout-inner',
    ownership: 'shared-refcount',
    native: 'HostLayout'
  }
  const result = record('host-layout-outer', [{ key: 'inner', value: hostReference }])
  const functionId = 'fn|host-layout' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'host-layout-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('host-layout-return', result)), bodyOf([call])],
    new Map(),
    null,
    { representations: [callable, result, hostReference], shakeComplete: true }
  )
  assert.equal(exposure.records.get('host-layout-outer' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('host-layout-inner' as never)?.level, 'full')
})

test('discarding a callable does not expose its result even without a matching implementation', () => {
  const result = record('uncalled-native-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|uncalled-native' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const discard = {
    kind: 'compute',
    form: 'unary',
    operator: 'void',
    operands: [operand('uncalled-value', callable)],
    result: { id: 'discarded-function' as never, representation: { kind: 'undefined' } },
    lineage
  } as IrOperation
  const body = functionBodyOf(functionId, abi, [], operand('native-return', result))
  const options = { representations: [callable, result], shakeComplete: true }
  const exposure = reflectionExposureOf([body, bodyOf([discard])], new Map(), null, options)
  assert.equal(exposure.records.get('uncalled-native-result' as never)?.level, 'keys-only')
  const external = reflectionExposureOf([bodyOf([discard])], new Map(), null, options)
  assert.equal(external.records.get('uncalled-native-result' as never)?.level, 'keys-only')
  const incompatibleAbi = { ...abi, result: { kind: 'string' } as Representation }
  const mismatch = reflectionExposureOf([functionBodyOf(functionId, incompatibleAbi, []), bodyOf([discard])], new Map(), null, options)
  assert.equal(mismatch.records.get('uncalled-native-result' as never)?.level, 'keys-only')
})

test('unused erased callable values do not publish results through their shared signature', () => {
  const result = record('erased-callable-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|erased-callable' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const representation: Representation = { kind: 'function-value-dispatch', abi }
  const allocate = {
    kind: 'allocate-callable',
    functionId,
    captures: [],
    lineage,
    result: { id: 'erased-allocation' as never, representation }
  } as IrOperation
  const read = {
    kind: 'binding-read',
    declaration: 'erased-binding' as never,
    lineage,
    result: { id: 'erased-read' as never, representation },
    closedCallable: { kind: 'exact', functionId }
  } as IrOperation
  const body = functionBodyOf(functionId, abi, [], operand('erased-return', result))
  const options = { representations: [representation, result], shakeComplete: true }
  const exposure = reflectionExposureOf([body, bodyOf([allocate, read])], new Map(), null, options)
  assert.equal(exposure.records.get('erased-callable-result' as never)?.level, 'keys-only')
  const unproven = {
    kind: 'binding-read',
    declaration: 'external-binding' as never,
    lineage,
    result: { id: 'unknown-erased-read' as never, representation }
  } as IrOperation
  const unknown = reflectionExposureOf([body, bodyOf([allocate, read, unproven])], new Map(), null, options)
  assert.equal(unknown.records.get('erased-callable-result' as never)?.level, 'keys-only')
  const missingBody = reflectionExposureOf([bodyOf([allocate, read])], new Map(), null, options)
  assert.equal(missingBody.records.get('erased-callable-result' as never)?.level, 'keys-only')
  const publish = { kind: 'return', lineage, value: operand('unknown-erased-read', representation) } as IrOperation
  const escaped = reflectionExposureOf([body, bodyOf([allocate, read, unproven, publish])], new Map(), null, options)
  assert.equal(escaped.records.get('erased-callable-result' as never)?.level, 'full')
})

test('optional and union callable signatures do not publish results until an actual escape', () => {
  const result = record('optional-callable-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|optional-closed' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const optional: Representation = { kind: 'optional', payload: callable, absence: 'undefined' }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('optional-callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'optional-call-result' as never, representation: result },
    target: { kind: 'unresolved' },
    closedCallee: { kind: 'exact', functionId }
  } as IrOperation
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const wrapped = {
    kind: 'convert',
    lineage,
    conversionUse: conversions.nodeFor(callable, optional).id,
    source: operand('optional-callee', callable),
    result: { id: 'wrapped-callable' as never, representation: optional }
  } as IrOperation
  const bodies = [functionBodyOf(functionId, abi, []), bodyOf([wrapped, call])]
  const exposure = reflectionExposureOf(bodies, new Map(), null, {
    representations: [callable, optional, result],
    conversions,
    shakeComplete: true
  })
  assert.equal(exposure.records.get('optional-callable-result' as never)?.level, 'keys-only')

  const unknown: Representation = { kind: 'function-value-dispatch', abi }
  const union: Representation = {
    kind: 'tagged-union',
    arms: [callable, unknown].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const materialized = {
    kind: 'compute',
    form: 'unary',
    operator: 'void',
    operands: [operand('mixed-callables', union)],
    result: { id: 'discarded-mixed' as never, representation: { kind: 'undefined' } },
    lineage
  } as IrOperation
  const retained = reflectionExposureOf([...bodies, bodyOf([materialized])], new Map(), null, {
    representations: [callable, union, result],
    conversions,
    shakeComplete: true
  })
  assert.equal(retained.records.get('optional-callable-result' as never)?.level, 'keys-only')
  const publish = { kind: 'return', lineage, value: operand('mixed-callables', union) } as IrOperation
  const escaped = reflectionExposureOf([...bodies, bodyOf([materialized, publish])], new Map(), null, {
    representations: [callable, union, result],
    conversions,
    shakeComplete: true
  })
  assert.equal(escaped.records.get('optional-callable-result' as never)?.level, 'full')
})

test('a direct target with a mismatched ABI remains a dynamic boundary', () => {
  const result = record('mismatched-direct', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|mismatched-direct' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'call-result', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [
      functionBodyOf(functionId, abi, []),
      bodyOf([
        call,
        {
          kind: 'compute',
          lineage,
          form: 'unary',
          operator: 'typeof',
          operands: [operand('call-result', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })],
          result: { id: 'observed-call-result' as never, representation: { kind: 'string' } }
        } as IrOperation
      ])
    ],
    new Map(),
    null,
    {
      representations: [callable, result],
      shakeComplete: true
    }
  )
  assert.equal(exposure.records.get('mismatched-direct' as never)?.level, 'full')
})

test('a spread-marked direct call remains a dynamic boundary', () => {
  const result = record('spread-direct', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|spread-direct' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('callee', callable),
    receiver: null,
    arguments: [],
    argumentsAreSpread: true,
    result: { id: 'spread-result', representation: result },
    target: { kind: 'direct', functionId },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf([functionBodyOf(functionId, abi, []), bodyOf([call])], new Map(), null, {
    representations: [callable, result],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('spread-direct' as never)?.level, 'full')
})

test('an unpublished direct callable passed through an unknown call retains its ABI records', () => {
  const result = record('unknown-callable', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|unknown-callable' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('unknown-callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('callable', callable)],
    result: null
  } as never
  const exposure = reflectionExposureOf([functionBodyOf(functionId, abi, []), bodyOf([call])], new Map(), null, {
    representations: [callable, result],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('unknown-callable' as never)?.level, 'full')
})

test('a closed capturing call consumes its body ABI without needing physical direct dispatch', () => {
  const result = record('capturing-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|closed-capturing' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('capturing-callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'capturing-result', representation: result },
    target: { kind: 'unresolved' },
    closedCallee: { kind: 'exact', functionId }
  } as never
  const exposure = reflectionExposureOf(
    [functionBodyOf(functionId, abi, [], operand('capturing-return', result)), bodyOf([call])],
    new Map(),
    null,
    { representations: [callable, result], shakeComplete: true }
  )
  assert.equal(exposure.records.get('capturing-result' as never)?.level, 'keys-only')
})

test('one matching call cannot certify a second mismatched call to the same function', () => {
  const result = record('mixed-call-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|mixed-calls' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('mixed-callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'matching-result', representation: result },
    closedCallee: { kind: 'exact', functionId }
  } as const
  const mismatch = {
    ...call,
    result: { id: 'mismatched-result', representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  }
  const exposure = reflectionExposureOf(
    [
      functionBodyOf(functionId, abi, []),
      bodyOf([
        call as never,
        mismatch as never,
        {
          kind: 'compute',
          lineage,
          form: 'unary',
          operator: 'typeof',
          operands: [operand('mismatched-result', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })],
          result: { id: 'observed-call-result' as never, representation: { kind: 'string' } }
        } as IrOperation
      ])
    ],
    new Map(),
    null,
    { representations: [callable, result], shakeComplete: true }
  )
  assert.equal(exposure.records.get('mixed-call-result' as never)?.level, 'full')
  assert.ok(exposure.records.get('mixed-call-result' as never)?.reasons.has('unknown-call-boundary'))
})

test('physical dispatch identity neither grants nor prevents exact native frame transport', () => {
  const result = record('physical-only-result', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|physical-only' as never
  const abi = { parameters: [], result, receiver: null, restFrom: null }
  const callable: Representation = { kind: 'function', functionId, abi }
  const call = {
    kind: 'call',
    lineage,
    callee: operand('physical-only-callee', callable),
    receiver: null,
    arguments: [],
    result: { id: 'physical-only-result' as never, representation: result },
    target: { kind: 'direct', functionId }
  } as Extract<IrOperation, { kind: 'call' }>
  const exposure = reflectionExposureOf([functionBodyOf(functionId, abi, []), bodyOf([call])], new Map(), null, {
    representations: [callable, result],
    shakeComplete: true
  })
  assert.equal(exposure.records.get('physical-only-result' as never)?.level, 'keys-only')
  const spread = reflectionExposureOf(
    [functionBodyOf(functionId, abi, []), bodyOf([{ ...call, argumentsAreSpread: true } as never])],
    new Map(),
    null,
    {
      representations: [callable, result],
      shakeComplete: true
    }
  )
  assert.equal(spread.records.get('physical-only-result' as never)?.level, 'full')
})

const nativeAdapterExposure = (
  mode: 'closed' | 'unknown-source' | 'unknown-write' | 'mismatched-adapter' | 'external-binding',
  boundary: 'native' | 'dynamic-call' | 'inexact-frame' = 'native'
) => {
  const item = record('adapter-item', [{ key: 'code', value: { kind: 'scalar', domain: 'number' } }])
  const functionId = 'fn|native-adapter-source' as never
  const from = {
    receiver: null,
    parameters: [{ value: item, ownership: 'owned' as const, passing: 'by-value' as const }],
    restFrom: null,
    result: { kind: 'void' as const }
  }
  const to = { ...from, result: { kind: 'dynamic' as const, reason: 'declared-any-never-narrowed' as const } }
  const source: Representation = { kind: 'function-value-dispatch', abi: from }
  const target: Representation = { kind: 'function-value-dispatch', abi: to }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, target)
  assert.equal(node.capability.kind, 'atom')
  const capability = node.capability as Extract<typeof node.capability, { kind: 'atom' }>
  assert.equal(capability.materializer.nativeFieldProtocol, 'unused')
  assert.deepEqual(capability.materializer.callableAdapter, { from, to })
  const declaration = 'adapter-binding' as never
  const convert = {
    kind: 'convert',
    lineage,
    conversionUse: node.id,
    source: operand('adapter-source', source),
    result: { id: 'adapter-value', representation: target }
  } as never
  const allocation = {
    kind: 'allocate-callable',
    lineage,
    functionId,
    captures: [],
    result: { id: 'adapter-source', representation: source }
  } as never
  const write = { kind: 'binding-write', lineage, declaration, value: operand('adapter-value', target) } as never
  const unknownWrite = { kind: 'binding-write', lineage, declaration, value: operand('host-callback', target) } as never
  const read = { kind: 'binding-read', lineage, declaration, result: { id: 'adapter-read', representation: target } } as never
  const call = {
    kind: 'call',
    lineage,
    callee:
      boundary === 'dynamic-call'
        ? operand('dynamic-callee', { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
        : operand('adapter-read', target),
    receiver: boundary === 'inexact-frame' ? operand('unexpected-receiver', item) : null,
    arguments: [operand('item', item)],
    result: null
  } as never
  const caller = bodyOf([
    ...(mode === 'unknown-source' ? [] : [allocation]),
    convert,
    write,
    ...(mode === 'unknown-write' ? [unknownWrite] : []),
    read,
    call
  ])
  const counterfeit = {
    ...node,
    capability: { ...capability, materializer: { ...capability.materializer, callableAdapter: { from: to, to } } }
  }
  return reflectionExposureOf([functionBodyOf(functionId, from, []), caller], new Map(), null, {
    representations: [source, target, item],
    shakeComplete: true,
    placements: new Map([
      [
        declaration,
        {
          representation: target,
          storage: mode === 'external-binding' ? { kind: 'external', linkageName: 'callback' } : { kind: 'local', owner: caller.owner }
        } as never
      ]
    ]),
    conversions: mode === 'mismatched-adapter' ? { nodeById: () => counterfeit } : conversions
  }).records.get('adapter-item' as never)?.level
}

test('a census-proven native adapter and local callable alias keep their argument record native', () => {
  assert.equal(nativeAdapterExposure('closed'), 'keys-only')
})

// fa1212e40 separates dispatch provenance from reflection transport. These
// variants revoke identity/adapter-origin facts but retain a certified native
// field protocol and an exact held ABI. Pair each with actual open boundaries;
// otherwise an old closure assertion merely tests an authority no longer used.
for (const mode of ['unknown-source', 'unknown-write', 'mismatched-adapter', 'external-binding'] as const) {
  test(`native adapter ${mode} uses its exact frame while dynamic and inexact calls retain reflection`, () => {
    assert.equal(nativeAdapterExposure(mode), 'keys-only')
    assert.equal(nativeAdapterExposure(mode, 'dynamic-call'), 'full')
    assert.equal(nativeAdapterExposure(mode, 'inexact-frame'), 'full')
  })
}

test('an adapter boxing a typed result never receives a no-field-transport contract', () => {
  const value = record('boxed-adapter-result', [{ key: 'code', value: { kind: 'scalar', domain: 'number' } }])
  const from = { receiver: null, parameters: [], restFrom: null, result: value }
  const to = { ...from, result: { kind: 'dynamic' as const, reason: 'declared-any-never-narrowed' as const } }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor({ kind: 'function-value-dispatch', abi: from }, { kind: 'function-value-dispatch', abi: to })
  assert.equal(node.capability.kind, 'atom')
  const capability = node.capability as Extract<typeof node.capability, { kind: 'atom' }>
  assert.equal(capability.materializer.callableAdapter, undefined)
  assert.equal(capability.materializer.nativeFieldProtocol, undefined)
})

test('native fixed definitions do not publish their intrinsic return ABI, but other uses still do', () => {
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const target = record('defined-native-target', [{ key: 'id', value: number }])
  const descriptor = record('defined-native-descriptor', [{ key: 'value', value: number }])
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: target }
  }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const key = {
    kind: 'constant',
    lineage,
    text: 'defineProperty',
    literal: 'string',
    result: { id: 'define-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const get = {
    kind: 'get',
    lineage,
    receiver: operand('Object', {
      kind: 'native-handle',
      protocol: 'ObjectConstructor',
      version: 1,
      native: null,
      bases: [],
      call: null,
      construct: null
    }),
    key: operand('define-key', { kind: 'string' }),
    result: { id: 'define-function' as never, representation: callable }
  } as IrOperation
  const call = {
    kind: 'call',
    lineage,
    callee: operand('define-function', callable),
    receiver: null,
    arguments: [operand('target', target), operand('id-key', { kind: 'string' }), operand('descriptor', descriptor)],
    result: { id: 'defined' as never, representation: target },
    fixedDataDefinition: {
      nativeFieldProtocol: 'unused',
      target: representationKey(target),
      descriptor: representationKey(descriptor),
      field: { key: 'id', value: number, required: true },
      held: number,
      value: { key: 'value', value: number, required: true },
      conversion: conversions.nodeFor(number, number).id,
      attributes: []
    }
  } as Extract<IrOperation, { kind: 'call' }>
  const options = { representations: [target, descriptor, callable], shakeComplete: true, conversions }
  const demand = (operations: readonly IrOperation[]) =>
    reflectionExposureOf([bodyOf(operations)], new Map(), null, options).records.get('defined-native-target' as never)?.level
  assert.equal(demand([key, get, call]), 'keys-only')
  const publish = {
    kind: 'call',
    lineage,
    callee: operand('external', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('define-function', callable)],
    result: null
  } as IrOperation
  assert.equal(demand([key, get, call, publish]), 'full')
  const other = { ...get, result: { id: 'other-definition' as never, representation: callable } } as IrOperation
  assert.equal(demand([key, get, call, other]), 'keys-only')
  const publishOther = { ...publish, arguments: [operand('other-definition', callable)] } as IrOperation
  assert.equal(demand([key, get, call, other, publishOther]), 'full')
  assert.equal(
    demand([key, get, { ...call, fixedDataDefinition: { ...call.fixedDataDefinition!, nativeFieldProtocol: 'required' } }]),
    'full'
  )
})

test('native array allocation, copying, length and indexed transport do not publish element fields', () => {
  const point = record('native-array-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const array: Representation = { kind: 'array-object', element: point, ownership: 'shared-refcount', extension: null }
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const allocate = {
    kind: 'allocate-array-object',
    lineage,
    elements: [
      { kind: 'element', value: operand('point', point) },
      { kind: 'hole' },
      { kind: 'spread', value: operand('source', array), from: 1 }
    ],
    result: { id: 'array' as never, representation: array }
  } as IrOperation
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('array', array),
    key: operand('index', number),
    result: { id: 'point-read' as never, representation: point }
  } as IrOperation
  const write = {
    kind: 'set',
    lineage,
    receiver: operand('array', array),
    key: operand('index', number),
    value: operand('point', point),
    strict: true,
    result: null
  } as IrOperation
  const lengthKey = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'length',
    result: { id: 'length-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const length = {
    kind: 'get',
    lineage,
    receiver: operand('array', array),
    key: operand('length-key', { kind: 'string' }),
    result: { id: 'length' as never, representation: number }
  } as IrOperation
  const indexKey = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: '0',
    result: { id: 'index' as never, representation: { kind: 'string' } }
  } as IrOperation
  const options = { representations: [array, point], shakeComplete: true }
  for (const operations of [
    [allocate],
    [read],
    [write],
    [lengthKey, length],
    [indexKey, read],
    [allocate, read, write, lengthKey, length]
  ]) {
    const exposure = reflectionExposureOf([bodyOf(operations)], new Map(), null, options)
    assert.equal(exposure.records.get('native-array-point' as never)?.level, 'keys-only')
  }
  const unknown = {
    kind: 'call',
    lineage,
    callee: operand('opaque', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('array', array)],
    result: null
  } as IrOperation
  const escaped = reflectionExposureOf([bodyOf([allocate, read, unknown])], new Map(), null, options)
  assert.equal(escaped.records.get('native-array-point' as never)?.level, 'full')
  assert.equal(
    reflectionExposureOf([bodyOf([allocate, read])], new Map(), null, { ...options, shakeComplete: false }).records.get(
      'native-array-point' as never
    )?.level,
    'full'
  )
})

test('native key queries share their no-publication proof and reject traps, key coercion and ordinary calls', () => {
  const point = record('native-key-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const closed = (value: Representation): boolean => hasClosedFixedLayout(value, null, new Map())
  const presence: IrOperation = {
    kind: 'has-property',
    lineage,
    receiver: operand('point', point),
    key: operand('key', { kind: 'string' }),
    result: { id: 'present' as never, representation: { kind: 'scalar', domain: 'boolean' } }
  }
  assert.equal(nativeKeyQueryOf(presence, closed), true)
  assert.equal(nativeKeyQueryOf({ ...presence, key: operand('coerced-key', point) }, closed), false)
  const proxy: Representation = { kind: 'proxy-object', target: point, handler: point }
  assert.equal(nativeKeyQueryOf({ ...presence, receiver: operand('proxy', proxy) }, closed), false)
  const call: IrOperation = {
    kind: 'call',
    lineage,
    callee: operand('keys', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('point', point)],
    result: null,
    intrinsicOwnKeys: true
  }
  assert.equal(nativeKeyQueryOf(call, closed), true)
  const { intrinsicOwnKeys: _intrinsic, ...ordinary } = call
  assert.equal(nativeKeyQueryOf(ordinary, closed), false)
  assert.equal(nativeKeyQueryOf({ ...call, argumentsAreSpread: true }, closed), false)
  assert.equal(nativeKeyQueryOf({ ...call, arguments: [operand('proxy', proxy)] }, closed), false)
  // `Object.hasOwn(o, key)` is the one member of this family with a second
  // argument -- the queried key -- and `HasOwnProperty`'s own `ToPropertyKey`
  // coercion of it can run arbitrary code independently of `o`'s layout, the
  // same hazard `presence`'s `coerced-key` case above guards for `in`.
  const hasOwnCall: IrOperation = { ...call, arguments: [operand('point', point), operand('key', { kind: 'string' })] }
  assert.equal(nativeKeyQueryOf(hasOwnCall, closed), true)
  assert.equal(nativeKeyQueryOf({ ...hasOwnCall, arguments: [operand('point', point), operand('coerced-key', point)] }, closed), false)
})

test('native index key enumeration retains no value protocol while unknown consumers still expose its payloads', () => {
  const payload = record('indexed-key-payload', [{ key: 'value', value: { kind: 'scalar', domain: 'number' } }])
  const indexed: Representation = {
    kind: 'record-with-index',
    shapeId: 'indexed-key-owner',
    fields: [{ key: 'named', value: payload, required: true }],
    indexes: [{ key: 'symbol', value: payload }],
    ownership: 'shared-refcount'
  }
  const layout = (value: Representation): boolean => hasNativePropertyLayout(value, null, new Map())
  assert.equal(hasClosedFixedLayout(indexed, null, new Map()), false)
  assert.equal(layout(indexed), true)
  const call: Extract<IrOperation, { kind: 'call' }> = {
    kind: 'call',
    lineage,
    callee: operand('keys', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('indexed', indexed)],
    result: null,
    intrinsicOwnKeys: true
  }
  assert.equal(nativeKeyQueryOf(call, layout), true)
  const options = { representations: [indexed, payload], shakeComplete: true }
  const exposure = reflectionExposureOf([bodyOf([call])], new Map(), null, options)
  assert.equal(exposure.records.get('indexed-key-owner' as never)?.level, 'keys-only')
  assert.equal(exposure.records.get('indexed-key-payload' as never)?.level, 'keys-only')
  const { intrinsicOwnKeys: _proof, ...unknown } = call
  const escaped = reflectionExposureOf([bodyOf([unknown])], new Map(), null, options)
  assert.equal(escaped.records.get('indexed-key-owner' as never)?.level, 'full')
  assert.equal(escaped.records.get('indexed-key-payload' as never)?.level, 'full')
  const proxy: Representation = { kind: 'proxy-object', target: indexed, handler: payload }
  assert.equal(nativeKeyQueryOf({ ...call, arguments: [operand('proxy', proxy)] }, layout), false)
  const presence: IrOperation = {
    kind: 'has-property',
    lineage,
    receiver: operand('indexed', indexed),
    key: operand('coerced', payload),
    result: { id: 'present' as never, representation: { kind: 'scalar', domain: 'boolean' } }
  }
  assert.equal(nativeKeyQueryOf(presence, layout), false)
})

test('checked array reads preserve native payloads without admitting optional writes or adapted payloads', () => {
  const point = record('checked-array-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const array: Representation = { kind: 'array-object', element: point, ownership: 'shared-refcount', extension: null }
  const checked: Representation = { kind: 'optional', payload: point, absence: 'undefined' }
  const read: IrOperation = {
    kind: 'get',
    lineage,
    receiver: operand('array', array),
    key: operand('index', { kind: 'scalar', domain: 'number' }),
    result: { id: 'checked-point' as never, representation: checked }
  }
  assert.equal(nativeArrayTransportOf(read, null), true)
  assert.equal(
    reflectionExposureOf([bodyOf([read])], new Map(), null, {
      representations: [array, point, checked],
      shakeComplete: true
    }).records.get('checked-array-point' as never)?.level,
    'keys-only'
  )
  const write: IrOperation = {
    kind: 'set',
    lineage,
    receiver: read.receiver,
    key: read.key,
    value: operand('replacement', checked),
    strict: true,
    result: null
  }
  const rejected: IrOperation[] = [
    write,
    { ...read, result: { ...read.result, representation: { ...checked, absence: 'null' } } },
    { ...read, result: { ...read.result, representation: { ...checked, payload: { kind: 'string' } } } },
    { ...read, key: operand('unknown-property', { kind: 'string' }) }
  ]
  for (const operation of rejected) assert.equal(nativeArrayTransportOf(operation, null), false)
})

test('array boxing, adapting copies and unknown keys retain element exposure', () => {
  const point = record('opaque-array-point', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const array: Representation = { kind: 'array-object', element: point, ownership: 'shared-refcount', extension: null }
  const dynamicArray: Representation = { ...array, element: dynamic }
  const literal = (target: Representation): IrOperation => ({
    kind: 'allocate-array-object',
    lineage,
    elements: [{ kind: 'element', value: operand('point', point) }],
    result: { id: 'array' as never, representation: target }
  })
  const spread: IrOperation = {
    kind: 'allocate-array-object',
    lineage,
    elements: [{ kind: 'spread', value: operand('source', array), from: 0, element: dynamic }],
    result: { id: 'array' as never, representation: dynamicArray }
  }
  const read: IrOperation = {
    kind: 'get',
    lineage,
    receiver: operand('array', array),
    key: operand('index', { kind: 'string' }),
    result: { id: 'read' as never, representation: point }
  }
  const options = { representations: [array, point], shakeComplete: true }
  for (const operation of [literal(dynamic), literal(dynamicArray), spread, read]) {
    assert.equal(
      reflectionExposureOf([bodyOf([operation])], new Map(), null, options).records.get('opaque-array-point' as never)?.level,
      'full'
    )
  }
  for (const text of ['00', '-0', '1.5', '4294967295', 'push', 'extra']) {
    const key = {
      kind: 'constant',
      lineage,
      literal: 'string',
      text,
      result: { id: 'index' as never, representation: { kind: 'string' } }
    } as IrOperation
    assert.equal(
      reflectionExposureOf(
        [bodyOf([key, { ...read, result: { ...read.result, representation: dynamic } }])],
        new Map(),
        null,
        options
      ).records.get('opaque-array-point' as never)?.level,
      'keys-only',
      text
    )
  }
  // Unlike named sidecar properties, a canonical index exposes the array's
  // actual element when its result crosses a dynamic boundary.
  const index = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: '0',
    result: { id: 'index' as never, representation: { kind: 'string' } }
  } as IrOperation
  const dynamicRead = { ...read, result: { ...read.result, representation: dynamic } }
  assert.equal(
    reflectionExposureOf([bodyOf([index, dynamicRead])], new Map(), null, options).records.get('opaque-array-point' as never)?.level,
    'full'
  )
})

test('physical field carriers supersede earlier unrepresented declarations without admitting unresolved storage', () => {
  const declaration = 'ParameterProperty' as never
  const number: Representation = { kind: 'scalar', domain: 'number' }
  const shape = record('parameter-property-shape', [{ key: 'value', value: number }])
  const point: Representation = { kind: 'class-ref', declaration, shapeId: 'parameter-property-shape', ownership: 'owned', ancestors: [] }
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    instance: point,
    fields: [{ key: 'value', declaration: 'parameter-property-value', representation: null }],
    methods: [],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    fieldOwnership: []
  }
  const exposure = (storage?: Representation) =>
    reflectionExposureOf(
      [],
      new Map([
        [
          declaration,
          {
            ...layout,
            ...(storage ? { nativeStorage: { fields: [{ key: 'value', value: storage }] } } : {})
          } as never
        ]
      ]),
      { layoutOf: () => shape } as never,
      { representations: [point], shakeComplete: true }
    ).classes.get(declaration)?.level
  assert.equal(exposure(), 'full')
  assert.equal(exposure(number), 'keys-only')
  assert.equal(exposure({ kind: 'unresolved', reason: 'missing physical carrier' } as never), 'full')
})

test('a named dynamic read retains only that field and its outgoing child', () => {
  const selected = record('selected-child', [{ key: 'n', value: { kind: 'scalar', domain: 'number' } }])
  const privateChild = record('private-sibling-child', [{ key: 'n', value: { kind: 'scalar', domain: 'number' } }])
  const holder = record('named-holder', [
    { key: 'selected', value: selected },
    { key: 'private', value: privateChild }
  ])
  const key = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'selected',
    result: { id: 'named-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('holder', holder),
    key: operand('named-key', { kind: 'string' }),
    result: { id: 'dynamic-read' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as IrOperation
  const exposure = reflectionExposureOf([bodyOf([key, read])], new Map(), null, { representations: [holder], shakeComplete: true })
  assert.deepEqual(
    [...exposure.records.get('named-holder' as never)!.fieldOperations!].map(([key, uses]) => [key, [...uses]]),
    [['selected', ['read']]]
  )
  assert.equal(exposure.records.get('selected-child' as never)?.fieldOperations, undefined)
  assert.equal(exposure.records.get('selected-child' as never)?.level, 'full')
  assert.equal(exposure.records.get('private-sibling-child' as never)?.level, 'keys-only')
})

test('named deletion needs no field payload while named writes retain only the write operation', () => {
  const child = record('deleted-child', [{ key: 'n', value: { kind: 'scalar', domain: 'number' } }])
  const holder = record('deleted-holder', [{ key: 'selected', value: child }])
  const key = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'selected',
    result: { id: 'delete-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const remove = {
    kind: 'delete',
    lineage,
    strict: true,
    receiver: operand('holder', holder),
    key: operand('delete-key', { kind: 'string' }),
    result: { id: 'deleted' as never, representation: { kind: 'scalar', domain: 'boolean' } }
  } as IrOperation
  const options = { representations: [holder], shakeComplete: true }
  const exposure = reflectionExposureOf([bodyOf([key, remove])], new Map(), null, options)
  assert.deepEqual([...exposure.records.get('deleted-holder' as never)!.fieldOperations!.get('selected')!], [])
  assert.equal(exposure.records.get('deleted-child' as never)?.level, 'keys-only')
  const write = {
    kind: 'set',
    lineage,
    strict: true,
    receiver: operand('holder', holder),
    key: operand('delete-key', { kind: 'string' }),
    value: operand('unknown-written', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    result: null
  } as IrOperation
  const written = reflectionExposureOf([bodyOf([key, write])], new Map(), null, options)
  assert.deepEqual([...written.records.get('deleted-holder' as never)!.fieldOperations!.get('selected')!], ['write'])
})

test('whole-object publication overrides field masks regardless of operation order', () => {
  const holder = record('published-masked-holder', [{ key: 'x', value: { kind: 'scalar', domain: 'number' } }])
  const key = {
    kind: 'constant',
    lineage,
    literal: 'string',
    text: 'x',
    result: { id: 'masked-key' as never, representation: { kind: 'string' } }
  } as IrOperation
  const read = {
    kind: 'get',
    lineage,
    receiver: operand('holder', holder),
    key: operand('masked-key', { kind: 'string' }),
    result: { id: 'dynamic-read' as never, representation: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  } as IrOperation
  const call = {
    kind: 'call',
    lineage,
    callee: operand('external', { kind: 'dynamic', reason: 'declared-any-never-narrowed' }),
    receiver: null,
    arguments: [operand('holder', holder)],
    result: null
  } as IrOperation
  for (const operations of [
    [key, read, call],
    [call, key, read]
  ]) {
    const exposure = reflectionExposureOf([bodyOf(operations)], new Map(), null, { representations: [holder], shakeComplete: true })
    assert.equal(exposure.records.get('published-masked-holder' as never)?.level, 'full')
    assert.equal(exposure.records.get('published-masked-holder' as never)?.fieldOperations, undefined)
  }
})
