import assert from 'node:assert/strict'
import test from 'node:test'
import { closedClassFieldCallablesOf, nativeCallableFlowOf } from './callable-class-flow.js'
import { reflectionExposureOf } from './reflection-demand.js'
import { nativeClassAccessorEntryOf } from './native-class-accessor.js'
import { publishOmittedArgumentConversions } from './call-entry.js'
import type { IrBody, IrNonTerminatorOperation, IrOperand } from './model.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { ClassLayout } from '../projection/classes.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeMergeTransportOf } from './native-merge-transport.js'

const lineage = 'callable-entry-test' as never
const operand = (value: string, representation: Representation): IrOperand => ({ value: value as never, representation })
const result = (id: string, representation: Representation) => ({ id: id as never, representation })
const abi: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'void' } }
const callable: Representation = { kind: 'function-value-dispatch', abi }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const record = (shapeId: string, key: string, value: Representation): Representation => ({
  kind: 'record',
  shapeId,
  ownership: 'owned',
  accessors: [],
  fields: [{ key, value, required: true }]
})
const body = (id: string, operations: readonly IrNonTerminatorOperation[], frame: CallableAbi | null = abi): IrBody => {
  const entry = `${id}-entry` as IrBody['entry']
  return {
    owner: id as IrBody['owner'],
    sourceOwner: id as IrBody['sourceOwner'],
    abi: frame,
    construct: null,
    entry,
    blocks: new Map([[entry, { id: entry, operations, terminator: { kind: 'return', lineage: null, value: null } }]]),
    blockOrder: [entry],
    values: new Map(),
    tryRegions: []
  }
}
const allocate = (id: string, representation = callable): IrNonTerminatorOperation => ({
  kind: 'allocate-callable',
  lineage,
  functionId: id as never,
  captures: [],
  result: result(`${id}-value`, representation)
})
const unknownCall = (...args: IrOperand[]): Extract<IrNonTerminatorOperation, { kind: 'call' }> => ({
  kind: 'call',
  lineage,
  callee: operand('external', dynamic),
  receiver: null,
  arguments: args,
  result: null
})

test('an observed receiver-ignoring adapter preserves callable flow only with its cited conversion and held frame', () => {
  const receiver = record('adapter-receiver', 'marker', { kind: 'scalar', domain: 'number' })
  const payload = record('adapter-payload', 'run', callable)
  const sourceAbi: CallableAbi = { ...abi, parameters: [{ value: payload, ownership: 'owned', passing: 'by-value' }] }
  const source: Representation = { kind: 'function-value-dispatch', abi: sourceAbi }
  const held: Representation = { kind: 'function-value-dispatch', abi: { ...sourceAbi, receiver } }
  const holder = record('adapted-method-holder', 'run', held)
  for (const trusted of [true, false])
    for (const validReceiver of [true, false]) {
      const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
      const conversion = conversions.nodeFor(source, held)
      const root = body(
        'root',
        [
          allocate('worker', source),
          allocate('callback'),
          {
            kind: 'allocate-record',
            lineage,
            fields: [{ key: 'run', value: operand('callback-value', callable) }],
            result: result('payload', payload)
          },
          {
            kind: 'convert',
            lineage,
            source: operand('worker-value', source),
            conversionUse: conversion.id,
            result: result('adapted', held)
          },
          { kind: 'allocate-record', lineage, fields: [{ key: 'run', value: operand('adapted', held) }], result: result('holder', holder) },
          { kind: 'allocate-record', lineage, fields: [], result: result('receiver', receiver) },
          { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
          {
            kind: 'get',
            lineage,
            receiver: operand('holder', holder),
            key: operand('key', { kind: 'string' }),
            result: result('read-worker', held)
          },
          {
            kind: 'call',
            lineage,
            callee: operand('read-worker', held),
            receiver: validReceiver ? operand('receiver', receiver) : null,
            arguments: [operand('payload', payload)],
            result: null
          }
        ],
        null
      )
      const worker = body(
        'worker',
        [
          { kind: 'parameter', lineage, ordinal: 0, result: result('incoming-payload', payload) },
          { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('worker-key', { kind: 'string' }) },
          {
            kind: 'get',
            lineage,
            receiver: operand('incoming-payload', payload),
            key: operand('worker-key', { kind: 'string' }),
            result: result('read-callback', callable)
          }
        ],
        sourceAbi
      )
      const flow = nativeCallableFlowOf([root, worker, body('callback', [])], new Map(), new Map(), {
        nodeById: (id) => (trusted ? conversions.nodeById(id) : null)
      })
      assert.equal(flow.callables.has('read-callback' as never), trusted && validReceiver)
      if (trusted && validReceiver) {
        assert.deepEqual(flow.callables.get('read-worker' as never), { kind: 'exact', functionId: 'worker' })
        assert.equal(flow.enteredBodies.has('worker' as never), true)
      }
    }
})

test('native dictionary reads retain stored callable origins and actual publication revokes them', () => {
  const dictionary: Representation = { kind: 'dictionary', key: 'string', value: callable, ownership: 'shared-refcount' }
  for (const escape of [false, true]) {
    const root = body(
      'root',
      [
        allocate('worker'),
        { kind: 'allocate-record', lineage, fields: [], result: result('table', dictionary) },
        { kind: 'constant', lineage, literal: 'string', text: 'entry', result: result('key', { kind: 'string' }) },
        {
          kind: 'set',
          lineage,
          strict: true,
          receiver: operand('table', dictionary),
          key: operand('key', { kind: 'string' }),
          value: operand('worker-value', callable),
          result: result('stored', dictionary)
        },
        {
          kind: 'get',
          lineage,
          receiver: operand('stored', dictionary),
          key: operand('key', { kind: 'string' }),
          result: result('read-worker', callable)
        },
        ...(escape ? [unknownCall(operand('table', dictionary))] : [])
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('worker', [])], new Map(), new Map())
    assert.equal(flow.callables.has('read-worker' as never), !escape)
    assert.equal(flow.enteredBodies.has('worker' as never), escape)
  }
})

test('native iteration preserves allocation origins and publication still revokes them through every alias', () => {
  for (const escape of [null, 'array', 'cursor', 'element'] as const) {
    const child = record('iterated-child', 'run', callable)
    const array: Representation = { kind: 'array-object', element: child, ownership: 'shared-refcount', extension: null }
    const cursor: Representation = {
      kind: 'iterator',
      source: 'sequence',
      element: child,
      resume: { kind: 'undefined' },
      completion: { kind: 'undefined' }
    }
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('child', child)
        },
        {
          kind: 'allocate-array-object',
          lineage,
          elements: [{ kind: 'element', value: operand('child', child) }],
          result: result('array', array)
        },
        {
          kind: 'get-iterator',
          lineage,
          protocol: 'iterator',
          method: null,
          receiver: operand('array', array),
          result: result('cursor', cursor)
        },
        { kind: 'iterator-next', lineage, iterator: operand('cursor', cursor), value: null, result: result('element', child) },
        {
          kind: 'iterator-done',
          lineage,
          iterator: operand('cursor', cursor),
          result: result('done', { kind: 'scalar', domain: 'boolean' })
        },
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('element', child),
          key: operand('key', { kind: 'string' }),
          result: result('worker-read', callable)
        },
        ...(escape === null ? [] : [unknownCall(operand(escape, escape === 'array' ? array : escape === 'cursor' ? cursor : child))])
      ],
      null
    )
    for (const bodies of [
      [root, body('worker', [])],
      [body('worker', []), root]
    ]) {
      const flow = nativeCallableFlowOf(bodies, new Map(), new Map())
      assert.deepEqual(
        flow.callables.get('worker-read' as never),
        escape === null ? { kind: 'exact', functionId: 'worker' } : undefined,
        String(escape)
      )
    }
  }
})

const fixture = (extra: readonly IrNonTerminatorOperation[] = [], allocateDormant = true) => {
  const receiver = record('worker-holder', 'run', callable)
  const dormantAbi: CallableAbi = { ...abi, parameters: [{ value: receiver, passing: 'by-value', ownership: 'owned' }] }
  const dormantType: Representation = { kind: 'function-value-dispatch', abi: dormantAbi }
  const holder = record('dormant-holder', 'saved', dormantType)
  const read: IrNonTerminatorOperation = {
    kind: 'get',
    lineage,
    receiver: operand('receiver', receiver),
    key: operand('run-key', { kind: 'string' }),
    result: result('read-worker', callable)
  }
  const root = body(
    'root',
    [
      allocate('worker'),
      {
        kind: 'allocate-record',
        lineage,
        fields: [{ key: 'run', value: operand('worker-value', callable) }],
        result: result('receiver', receiver)
      },
      ...(allocateDormant ? [allocate('dormant', dormantType)] : []),
      {
        kind: 'allocate-record',
        lineage,
        fields: [{ key: 'saved', value: operand('dormant-value', dormantType) }],
        result: result('holder', holder)
      },
      { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('run-key', { kind: 'string' }) },
      read,
      ...extra
    ],
    null
  )
  return {
    bodies: [
      root,
      body('worker', []),
      body(
        'dormant',
        [
          { kind: 'parameter', lineage, ordinal: 0, result: result('incoming-receiver', receiver) },
          unknownCall(operand('incoming-receiver', receiver))
        ],
        dormantAbi
      )
    ],
    receiver,
    dormantType,
    holder
  }
}
const identities = (value: ReturnType<typeof fixture>) => closedClassFieldCallablesOf(value.bodies, new Map(), new Map())
const assertExternalEntry = (value: ReturnType<typeof fixture>) => {
  const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map())
  assert.equal(flow.enteredBodies.has('dormant' as never), true)
  // Its external argument is not an alias of this unpublished allocation.
  assert.equal(flow.callables.has('read-worker' as never), true)
  return flow
}

test('storing an uncalled function does not execute its body or invent an external parameter', () => {
  assert.deepEqual(identities(fixture()).get('read-worker' as never), { kind: 'exact', functionId: 'worker' })
})

test('a sealed native data definition transports stored callable origins and its returned receiver', () => {
  for (const trusted of [true, false])
    for (const publish of [false, true]) {
      const { receiver } = fixture()
      const descriptor = record('native-definition-descriptor', 'value', callable)
      const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
      const definition: Extract<IrNonTerminatorOperation, { kind: 'call' }> = {
        ...unknownCall(operand('receiver', receiver), operand('run-key', { kind: 'string' }), operand('descriptor', descriptor)),
        result: result('defined-receiver', receiver),
        fixedDataDefinition: {
          nativeFieldProtocol: trusted ? 'unused' : 'required',
          target: representationKey(receiver),
          descriptor: representationKey(descriptor),
          field: { key: 'run', value: callable, required: true },
          held: callable,
          value: { key: 'value', value: callable, required: true },
          conversion: conversions.nodeFor(callable, callable).id,
          attributes: []
        }
      }
      const value = fixture([
        allocate('replacement'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'value', value: operand('replacement-value', callable) }],
          result: result('descriptor', descriptor)
        },
        definition,
        {
          kind: 'get',
          lineage,
          receiver: operand('defined-receiver', receiver),
          key: operand('run-key', { kind: 'string' }),
          result: result('defined-worker', callable)
        },
        ...(publish ? [unknownCall(operand('defined-receiver', receiver))] : [])
      ])
      value.bodies.push(body('replacement', []))
      const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map(), conversions)
      const identity = flow.callables.get('defined-worker' as never)
      assert.equal(identity !== undefined, trusted && !publish)
      if (trusted && !publish) {
        assert.equal(identity?.kind, 'closed-family')
        if (identity?.kind === 'closed-family') assert.deepEqual(new Set(identity.functionIds), new Set(['worker', 'replacement']))
      }
    }
})

test('publishing the containing record opens its stored function with unknown inputs', () => {
  const { holder } = fixture()
  assertExternalEntry(fixture([unknownCall(operand('holder', holder))]))
})

test('calling a previously dormant body applies its effects to the actual argument', () => {
  const { receiver, dormantType } = fixture()
  assert.equal(
    identities(
      fixture([
        {
          kind: 'call',
          lineage,
          callee: operand('dormant-value', dormantType),
          receiver: null,
          arguments: [operand('receiver', receiver)],
          result: null
        }
      ])
    ).has('read-worker' as never),
    false
  )
})

test('a body with no explicit callable allocation remains an external entry candidate', () => {
  assertExternalEntry(fixture([], false))
})

test('an allocated function also published as an accessor retains its implicit entry', () => {
  const value = fixture()
  const accessor: Representation = {
    kind: 'record',
    shapeId: 'implicit-accessor',
    fields: [],
    ownership: 'owned',
    accessors: [{ key: 'value', getter: 'dormant' as never, setter: null, value: { kind: 'undefined' } }]
  }
  value.bodies.push(body('accessor-root', [unknownCall(operand('accessor', accessor))], null))
  assertExternalEntry(value)
})

test('an allocated ordinary constructor retains its implicit construction entry', () => {
  const value = fixture()
  value.bodies[2] = { ...value.bodies[2]!, construct: abi }
  assertExternalEntry(value)
})

test('ambiguous physical variants cannot inherit a closed body-entry proof', () => {
  const value = fixture()
  value.bodies.push({ ...value.bodies[2]!, owner: 'dormant-other-variant' as never })
  assert.equal(assertExternalEntry(value).enteredBodies.has('dormant-other-variant' as never), true)
})

test('body order cannot change the result when an unknown call opens another stored function', () => {
  const { holder } = fixture()
  const value = fixture([unknownCall(operand('holder', holder))])
  value.bodies.reverse()
  assertExternalEntry(value)
})

test('reflection consumes the same body-entry result and recomputes it after publication', () => {
  const value = fixture()
  const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map())
  assert.equal(flow.enteredBodies.has('root' as never), true)
  assert.equal(flow.enteredBodies.has('dormant' as never), false)
  const demand = (input: typeof value, shakeComplete = true) =>
    reflectionExposureOf(input.bodies, new Map(), null, {
      representations: [input.receiver, input.holder, input.dormantType],
      shakeComplete
    }).records.get('worker-holder' as never)?.level
  assert.equal(demand(value), 'keys-only')
  assert.equal(demand(value, false), 'full', 'an incomplete program cannot prune reflection effects')
  const published = fixture([unknownCall(operand('holder', value.holder))])
  assert.equal(nativeCallableFlowOf(published.bodies, new Map(), new Map()).enteredBodies.has('dormant' as never), true)
  assert.equal(demand(published), 'full', 'a later escape must invalidate the previously closed execution set')
})

test('a call citation inside an unentered body does not become an unconditional external entry', () => {
  const { dormantType, receiver } = fixture()
  for (const published of [false, true]) {
    const value = fixture([allocate('outer', dormantType), ...(published ? [unknownCall(operand('outer-value', dormantType))] : [])])
    const frame = dormantType.kind === 'function-value-dispatch' ? dormantType.abi : abi
    value.bodies.push(
      body(
        'outer',
        [
          { kind: 'parameter', lineage, ordinal: 0, result: result('outer-input', receiver) },
          {
            kind: 'binding-read',
            lineage,
            declaration: 'captured-dormant' as never,
            result: result('captured-dormant-value', dormantType)
          },
          {
            kind: 'call',
            lineage,
            callee: operand('captured-dormant-value', dormantType),
            receiver: null,
            arguments: [operand('outer-input', receiver)],
            result: null,
            closedCallee: { kind: 'exact', functionId: 'dormant' as never }
          }
        ],
        frame
      )
    )
    const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map())
    assert.equal(flow.enteredBodies.has('dormant' as never), published)
    assert.equal(flow.callables.has('read-worker' as never), true)
  }
})

test('an implicit getter can publish a newly allocated callable through its return value', () => {
  const value = fixture([], false)
  const accessor: Representation = {
    kind: 'record',
    shapeId: 'callback-accessor',
    fields: [],
    ownership: 'owned',
    accessors: [{ key: 'callback', getter: 'getter' as never, setter: null, value: value.dormantType }]
  }
  const root = value.bodies[0]!
  value.bodies[0] = {
    ...root,
    blocks: new Map(
      [...root.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          operations: [
            ...block.operations.filter((operation) => operation.kind !== 'allocate-record' || operation.result.id !== 'holder'),
            { kind: 'allocate-record', lineage, fields: [], result: result('accessor', accessor) },
            { kind: 'constant', lineage, literal: 'string', text: 'callback', result: result('callback-key', { kind: 'string' }) },
            {
              kind: 'get',
              lineage,
              receiver: operand('accessor', accessor),
              key: operand('callback-key', { kind: 'string' }),
              result: result('returned-callback', value.dormantType)
            },
            {
              kind: 'call',
              lineage,
              callee: operand('returned-callback', value.dormantType),
              receiver: null,
              arguments: [operand('receiver', value.receiver)],
              result: null
            }
          ] as readonly IrNonTerminatorOperation[]
        }
      ])
    )
  }
  const getter = body('getter', [allocate('dormant', value.dormantType)], { ...abi, result: value.dormantType })
  value.bodies.push({
    ...getter,
    blocks: new Map(
      [...getter.blocks].map(([id, block]) => [
        id,
        {
          ...block,
          terminator: { kind: 'return', lineage: null, value: operand('dormant-value', value.dormantType) }
        }
      ])
    )
  })
  const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map())
  assert.equal(flow.enteredBodies.has('dormant' as never), true)
  assert.equal(flow.callables.has('read-worker' as never), false)
})

const methodFixture = () => {
  const value = fixture([], false)
  const instance: Representation = {
    kind: 'class-ref',
    declaration: 'MethodOwner' as never,
    shapeId: 'method-owner',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const methodAbi: CallableAbi = { ...value.bodies[2]!.abi!, receiver: instance }
  const methodValue: Representation = { kind: 'function', functionId: 'dormant' as never, abi: methodAbi }
  value.bodies[2] = { ...value.bodies[2]!, abi: methodAbi }
  const layout: ClassLayout = {
    declaration: 'MethodOwner' as never,
    base: null,
    nativeBase: null,
    constructor: null,
    construct: null,
    instance,
    fields: [],
    nativeStorage: { fields: [], omittedOverlays: [] },
    fieldOwnership: [],
    methods: [{ key: 'configure', callable: 'dormant' as never }],
    accessors: [],
    staticFields: [],
    staticMethods: [],
    staticAccessors: [],
    name: null,
    length: null
  }
  const classes = new Map([[layout.declaration, layout]])
  const root = (extra: readonly IrNonTerminatorOperation[]) => {
    const original = value.bodies[0]!
    value.bodies[0] = body(
      'root',
      [
        ...original.blocks.get(original.entry)!.operations,
        { kind: 'allocate-record', lineage, fields: [], result: result('instance', instance) },
        ...extra
      ],
      null
    )
    return nativeCallableFlowOf(value.bodies, new Map(), classes)
  }
  return { value, instance, methodValue, classes, root }
}

test('native union selection retains only compatible input allocations without inventing an escape', () => {
  const { classes, instance } = methodFixture()
  const layout = classes.values().next().value!
  classes.set(layout.declaration, {
    ...layout,
    nativeStorage: { fields: [{ key: 'run', value: callable, required: true }], omittedOverlays: [] }
  })
  const array: Representation = {
    kind: 'array-object',
    element: { kind: 'scalar', domain: 'number' },
    ownership: 'shared-refcount',
    extension: null
  }
  const union: Representation = {
    kind: 'tagged-union',
    arms: [instance, array].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `union-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const escape of [false, true]) {
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('instance', instance)
        },
        { kind: 'allocate-array-object', lineage, elements: [], result: result('array', array) },
        {
          kind: 'convert',
          lineage,
          source: operand('instance', instance),
          conversionUse: conversions.nodeFor(instance, union).id,
          result: result('object-arm', union)
        },
        {
          kind: 'convert',
          lineage,
          source: operand('array', array),
          conversionUse: conversions.nodeFor(array, union).id,
          result: result('array-arm', union)
        },
        {
          kind: 'phi',
          lineage,
          incoming: [operand('object-arm', union), operand('array-arm', union)].map((value, index) => ({
            block: `arm-${index}` as never,
            value
          })),
          result: result('union', union)
        },
        {
          kind: 'convert',
          lineage,
          source: operand('union', union),
          conversionUse: conversions.nodeFor(union, instance).id,
          result: result('selected', instance)
        },
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('selected', instance),
          key: operand('key', { kind: 'string' }),
          result: result('selected-worker', callable)
        },
        ...(escape ? [unknownCall(operand('selected', instance))] : [])
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('worker', [])], new Map(), classes, conversions)
    assert.equal(flow.callables.has('selected-worker' as never), !escape)
  }
})

test('default merges preserve nested native payloads only with valid citations and no publication', () => {
  const { classes, instance } = methodFixture()
  const layout = classes.values().next().value!
  classes.set(layout.declaration, {
    ...layout,
    nativeStorage: { fields: [{ key: 'run', value: callable, required: true }], omittedOverlays: [] }
  })
  const array: Representation = { kind: 'array-object', element: instance, ownership: 'shared-refcount', extension: null }
  const sum = (...values: Representation[]): Representation => ({
    kind: 'tagged-union',
    arms: values.map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `merge-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  })
  const present = sum(instance, array)
  const source = sum({ kind: 'undefined' }, { kind: 'null' }, present)
  const target: Representation = { kind: 'optional', payload: present, absence: 'null' }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const nativeTransport = nativeMergeTransportOf(source, target, [1, 2], false, conversions)
  assert.ok(nativeTransport)
  for (const mode of ['native', 'missing', 'wrong-arms', 'allocating', 'discarded-present', 'escape'] as const) {
    const transport = mode === 'discarded-present' ? nativeMergeTransportOf(source, target, [1], false, conversions)! : nativeTransport
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('instance', instance)
        },
        { kind: 'allocate-array-object', lineage, elements: [], result: result('array', array) },
        {
          kind: 'convert',
          lineage,
          source: operand('instance', instance),
          conversionUse: conversions.nodeFor(instance, source).id,
          result: result('object-arm', source)
        },
        {
          kind: 'convert',
          lineage,
          source: operand('array', array),
          conversionUse: conversions.nodeFor(array, source).id,
          result: result('array-arm', source)
        },
        {
          kind: 'phi',
          lineage,
          incoming: ['object-arm', 'array-arm'].map((id, index) => ({ block: `arm-${index}` as never, value: operand(id, source) })),
          result: result('source', source)
        },
        {
          kind: 'merge-live-arm-rebuild',
          lineage,
          source: operand('source', source),
          result: result('merged', target),
          liveArms: mode === 'wrong-arms' ? [0, 2] : mode === 'discarded-present' ? [1] : [1, 2],
          sourceAbsenceLive: false,
          ...(mode === 'missing' ? {} : { nativeTransport: transport })
        },
        {
          kind: 'convert',
          lineage,
          source: operand('merged', target),
          conversionUse: conversions.nodeFor(target, instance).id,
          result: result('selected', instance)
        },
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('selected', instance),
          key: operand('key', { kind: 'string' }),
          result: result('selected-worker', callable)
        },
        ...(mode === 'escape' ? [unknownCall(operand('selected', instance))] : [])
      ],
      null
    )
    const cited = {
      nodeById: (id: Parameters<typeof conversions.nodeById>[0]) => {
        const node = conversions.nodeById(id)
        if (
          mode !== 'allocating' ||
          id !== nativeTransport.arms[1]?.conversion ||
          (node?.capability.kind !== 'static' && node?.capability.kind !== 'atom')
        )
          return node
        return { ...node, capability: { ...node.capability, materializer: { ...node.capability.materializer, allocates: true } } }
      }
    }
    const bodies = [root, body('worker', [])]
    const flow = nativeCallableFlowOf(bodies, new Map(), classes, cited)
    assert.equal(flow.callables.has('selected-worker' as never), mode === 'native', mode)
    const exposure = reflectionExposureOf(bodies, classes, { layoutOf: (id: string) => record(id, 'run', callable) } as never, {
      representations: [source, target, instance, array],
      shakeComplete: true,
      conversions: cited
    })
    const demand = exposure.classes.get(layout.declaration)
    // A native allocation can avoid reflection while failing the stronger
    // alias-preservation proof above. The two questions must stay distinct.
    const nativeProtocol = mode === 'native' || mode === 'allocating' || mode === 'discarded-present'
    assert.equal(demand?.level, nativeProtocol ? 'keys-only' : 'full', `${mode}: ${[...(demand?.reasons ?? [])].join(', ')}`)
  }
})

test('retaining a native class method layout does not execute its body', () => {
  const { root } = methodFixture()
  const flow = root([])
  assert.equal(flow.enteredBodies.has('dormant' as never), false)
  assert.equal(flow.callables.has('read-worker' as never), true)
})

test('publishing a native instance opens its prototype methods with unknown inputs', () => {
  const { root, instance } = methodFixture()
  const flow = root([unknownCall(operand('instance', instance))])
  assert.equal(flow.enteredBodies.has('dormant' as never), true)
  assert.equal(flow.callables.has('read-worker' as never), true)
})

test('a retained method value enters when called or published, not when merely read', () => {
  for (const use of ['read', 'call', 'escape'] as const) {
    const { root, value, instance, methodValue } = methodFixture()
    const flow = root([
      { kind: 'constant', lineage, literal: 'string', text: 'configure', result: result('method-key', { kind: 'string' }) },
      {
        kind: 'get',
        lineage,
        receiver: operand('instance', instance),
        key: operand('method-key', { kind: 'string' }),
        result: result('method-value', methodValue),
        closedCallable: { kind: 'exact', functionId: 'dormant' as never }
      },
      ...(use === 'call'
        ? ([
            {
              kind: 'call',
              lineage,
              callee: operand('method-value', methodValue),
              receiver: operand('instance', instance),
              arguments: [operand('receiver', value.receiver)],
              result: null
            }
          ] satisfies readonly IrNonTerminatorOperation[])
        : use === 'escape'
          ? [unknownCall(operand('method-value', methodValue))]
          : [])
    ])
    assert.equal(flow.enteredBodies.has('dormant' as never), use !== 'read', use)
    assert.equal(flow.callables.has('read-worker' as never), use !== 'call', use)
  }
})

test('publishing a derived instance also exposes a base prototype method', () => {
  const { root, classes, instance } = methodFixture()
  const base = classes.values().next().value!
  const derived: Representation = {
    ...instance,
    declaration: 'DerivedMethodOwner' as never,
    shapeId: 'derived-method-owner',
    ancestors: [base.declaration]
  } as Extract<Representation, { kind: 'class-ref' }>
  classes.set('DerivedMethodOwner' as never, {
    ...base,
    declaration: 'DerivedMethodOwner' as never,
    base: base.declaration,
    instance: derived,
    methods: []
  })
  const flow = root([unknownCall(operand('derived-instance', derived))])
  assert.equal(flow.enteredBodies.has('dormant' as never), true)
  assert.equal(flow.callables.has('read-worker' as never), true)
})

test('a sealed native instance test does not publish the tested instance or open its methods', () => {
  for (const native of [false, true]) {
    const { root, instance } = methodFixture()
    const operation: IrNonTerminatorOperation = {
      kind: 'compute',
      lineage,
      form: 'instanceof',
      operator: 'instanceof',
      operands: [operand('instance', instance)],
      result: result('is-instance', { kind: 'scalar', domain: 'boolean' }),
      ...(native ? { classInstanceTest: { test: { kind: 'present' as const }, nativeFieldProtocol: 'unused' as const } } : {})
    }
    const flow = root([operation])
    assert.equal(flow.enteredBodies.has('dormant' as never), !native)
    assert.equal(flow.callables.has('read-worker' as never), true)
  }
})

test('native presence guards preserve method privacy while numeric coercion can publish the object', () => {
  for (const form of ['require-object-coercible', 'require-iterable-present', 'require-tagged-union-arm', 'unary'] as const) {
    const { root, instance } = methodFixture()
    const flow = root([
      {
        kind: 'compute',
        lineage,
        form,
        operator: '+',
        operands: [operand('instance', instance)],
        result: result('observed', { kind: 'scalar', domain: 'number' })
      }
    ])
    assert.equal(flow.enteredBodies.has('dormant' as never), form === 'unary', form)
    assert.equal(flow.callables.has('read-worker' as never), true, form)
  }
})

test('a native presence guard transports a callable that is subsequently published', () => {
  const { dormantType } = fixture()
  const value = fixture([
    {
      kind: 'compute',
      lineage,
      form: 'require-object-coercible',
      operator: 'require-object-coercible',
      operands: [operand('dormant-value', dormantType)],
      result: result('guarded-callable', dormantType)
    },
    unknownCall(operand('guarded-callable', dormantType))
  ])
  const flow = nativeCallableFlowOf(value.bodies, new Map(), new Map())
  assert.equal(flow.enteredBodies.has('dormant' as never), true)
  assert.equal(flow.callables.has('read-worker' as never), true)
})

test('publishing one allocation does not poison another allocation with the same record layout', () => {
  const receiver = record('same-layout', 'run', callable)
  for (const escaped of ['first', 'second']) {
    const root = body(
      'root',
      [
        allocate('first-worker'),
        allocate('second-worker'),
        ...['first', 'second'].map((id): IrNonTerminatorOperation => ({
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand(`${id}-worker-value`, callable) }],
          result: result(id, receiver)
        })),
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('run-key', { kind: 'string' }) },
        ...['first', 'second'].map((id): IrNonTerminatorOperation => ({
          kind: 'get',
          lineage,
          receiver: operand(id, receiver),
          key: operand('run-key', { kind: 'string' }),
          result: result(`${id}-read`, callable)
        })),
        unknownCall(operand(escaped, receiver))
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('first-worker', []), body('second-worker', [])], new Map(), new Map())
    const privateId = escaped === 'first' ? 'second' : 'first'
    assert.equal(flow.callables.has(`${escaped}-read` as never), false)
    assert.deepEqual(flow.callables.get(`${privateId}-read` as never), { kind: 'exact', functionId: `${privateId}-worker` })
  }
})

test('allocation isolation covers native class slots, arrays and dictionary entries', () => {
  for (const kind of ['class', 'array', 'dictionary'] as const) {
    const { classes, instance } = methodFixture()
    const layout = classes.values().next().value!
    classes.set(layout.declaration, {
      ...layout,
      fields: [
        {
          key: 'run',
          declaration: 'run-field' as never,
          representation: callable,
          initializer: null,
          syntheticSubclassMemberOverlay: false
        }
      ],
      nativeStorage: { fields: [{ key: 'run', value: callable, required: true }], omittedOverlays: [] },
      methods: []
    })
    const receiver: Representation =
      kind === 'class'
        ? instance
        : kind === 'dictionary'
          ? { kind: 'dictionary', key: 'string', value: callable, ownership: 'shared-refcount' }
          : {
              kind: 'array-object',
              element: callable,
              ownership: 'shared-refcount',
              extension: null
            }
    const key = kind === 'class' ? 'run' : '0'
    const root = body(
      'root',
      [
        allocate('first-worker'),
        allocate('second-worker'),
        ...['first', 'second'].map((id): IrNonTerminatorOperation =>
          kind !== 'array'
            ? {
                kind: 'allocate-record',
                lineage,
                fields: [{ key, value: operand(`${id}-worker-value`, callable) }],
                result: result(id, receiver)
              }
            : {
                kind: 'allocate-array-object',
                lineage,
                elements: [{ kind: 'element', value: operand(`${id}-worker-value`, callable) }],
                result: result(id, receiver)
              }
        ),
        { kind: 'constant', lineage, literal: 'string', text: key, result: result('run-key', { kind: 'string' }) },
        ...['first', 'second'].map((id): IrNonTerminatorOperation => ({
          kind: 'get',
          lineage,
          receiver: operand(id, receiver),
          key: operand('run-key', { kind: 'string' }),
          result: result(`${id}-read`, callable)
        })),
        unknownCall(operand('first', receiver))
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('first-worker', []), body('second-worker', [])], new Map(), classes)
    assert.equal(flow.callables.has('first-read' as never), false, kind)
    assert.deepEqual(flow.callables.get('second-read' as never), { kind: 'exact', functionId: 'second-worker' }, kind)
  }
})

test('an actual alias or nested publication still exposes the original allocation', () => {
  for (const route of ['alias', 'nested', 'return'] as const) {
    const receiver = record('alias-target', 'run', callable)
    const holder = record('alias-holder', 'target', receiver)
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('receiver', receiver)
        },
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('receiver', receiver),
          key: operand('key', { kind: 'string' }),
          result: result('read', callable)
        },
        ...(route === 'alias'
          ? ([
              {
                kind: 'convert',
                lineage,
                source: operand('receiver', receiver),
                result: result('alias', receiver),
                conversionUse: 'identity' as never
              },
              unknownCall(operand('alias', receiver))
            ] satisfies readonly IrNonTerminatorOperation[])
          : route === 'nested'
            ? ([
                {
                  kind: 'allocate-record',
                  lineage,
                  fields: [{ key: 'target', value: operand('receiver', receiver) }],
                  result: result('holder', holder)
                },
                unknownCall(operand('holder', holder))
              ] satisfies readonly IrNonTerminatorOperation[])
            : ([
                { ...unknownCall(operand('receiver', receiver)), result: result('external-return', receiver) },
                {
                  kind: 'get',
                  lineage,
                  receiver: operand('external-return', receiver),
                  key: operand('key', { kind: 'string' }),
                  result: result('returned-read', callable)
                }
              ] satisfies readonly IrNonTerminatorOperation[]))
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('worker', [])], new Map(), new Map())
    assert.equal(flow.callables.has('read' as never), false, route)
    if (route === 'return') assert.equal(flow.callables.has('returned-read' as never), false)
  }
})

test('a shallow array copy has distinct slots but shares object payloads', () => {
  for (const nested of [false, true]) {
    const child = record('copied-child', 'run', callable)
    const element = nested ? child : callable
    const array: Representation = { kind: 'array-object', element, ownership: 'shared-refcount', extension: null }
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('child', child)
        },
        {
          kind: 'allocate-array-object',
          lineage,
          elements: [{ kind: 'element', value: operand(nested ? 'child' : 'worker-value', element) }],
          result: result('original', array)
        },
        {
          kind: 'allocate-array-object',
          lineage,
          elements: [{ kind: 'spread', value: operand('original', array), from: 0 }],
          result: result('copy', array)
        },
        { kind: 'constant', lineage, literal: 'string', text: '0', result: result('index', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('original', array),
          key: operand('index', { kind: 'string' }),
          result: result('element', element)
        },
        ...(nested
          ? ([
              { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('run-key', { kind: 'string' }) },
              {
                kind: 'get',
                lineage,
                receiver: operand('element', child),
                key: operand('run-key', { kind: 'string' }),
                result: result('nested-read', callable)
              }
            ] satisfies readonly IrNonTerminatorOperation[])
          : []),
        unknownCall(operand('copy', array))
      ],
      null
    )
    const flow = nativeCallableFlowOf([root, body('worker', [])], new Map(), new Map())
    assert.equal(flow.callables.has((nested ? 'nested-read' : 'element') as never), !nested)
  }
})

const constructionFixture = (options: { construct?: boolean; publish?: boolean; unknownBase?: boolean; implicit?: boolean } = {}) => {
  const baseInstance: Representation = {
    kind: 'class-ref',
    declaration: 'Base' as never,
    shapeId: 'base-instance',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const derivedInstance: Representation = {
    kind: 'class-ref',
    declaration: 'Derived' as never,
    shapeId: 'derived-instance',
    ownership: 'shared-refcount',
    ancestors: ['Base' as never]
  }
  const frame = (receiver: Representation): CallableAbi => ({
    ...abi,
    receiver,
    parameters: [{ value: callable, passing: 'by-value', ownership: 'owned' }]
  })
  const layout = (name: string, instance: Representation): ClassLayout => ({
    ...[...methodFixture().classes.values()][0]!,
    declaration: name as never,
    instance,
    constructor: `${name}-constructor` as never,
    construct: { ...frame(instance), receiver: null, result: instance },
    base: name === 'Derived' ? ('Base' as never) : null,
    fields:
      name === 'Base'
        ? [
            {
              declaration: 'run-field' as never,
              key: 'run',
              initializer: null,
              representation: callable,
              syntheticSubclassMemberOverlay: false
            }
          ]
        : [],
    nativeStorage: { fields: [{ key: 'run', value: callable, required: true }], omittedOverlays: [] },
    methods: []
  })
  const base = layout('Base', baseInstance)
  const derived = { ...layout('Derived', derivedInstance), ...(options.implicit ? { constructor: null } : {}) }
  const classes = new Map([
    [base.declaration, base],
    [derived.declaration, derived]
  ])
  const constructorValue: Representation = { kind: 'constructor-family', members: [derived.declaration], abi: derived.construct! }
  const baseValue: Representation = { kind: 'constructor-family', members: [base.declaration], abi: base.construct! }
  const root = body(
    'construction-root',
    [
      { kind: 'allocate-constructor', lineage, declaration: base.declaration, captures: [], result: result('base-value', baseValue) },
      {
        kind: 'allocate-constructor',
        lineage,
        declaration: derived.declaration,
        captures: [],
        result: result('derived-value', constructorValue)
      },
      allocate('constructor-worker'),
      ...(options.construct === false
        ? []
        : ([
            {
              kind: 'construct',
              lineage,
              callee: operand('derived-value', constructorValue),
              newTarget: operand('derived-value', constructorValue),
              arguments: [operand('constructor-worker-value', callable)],
              result: result('constructed', derivedInstance),
              target: {
                kind: 'exact',
                evidence: [],
                target: options.implicit
                  ? { kind: 'implicit-source-constructor', classDeclaration: derived.declaration }
                  : { kind: 'function', functionId: derived.constructor!, constructable: true }
              }
            },
            { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('constructed-key', { kind: 'string' }) },
            {
              kind: 'get',
              lineage,
              receiver: operand('constructed', derivedInstance),
              key: operand('constructed-key', { kind: 'string' }),
              result: result('constructed-read', callable)
            }
          ] satisfies IrNonTerminatorOperation[])),
      ...(options.publish ? [unknownCall(operand('derived-value', constructorValue))] : [])
    ],
    null
  )
  const baseBody = body(
    'Base-constructor',
    [
      { kind: 'receiver', lineage, result: result('base-this', baseInstance) },
      { kind: 'parameter', lineage, ordinal: 0, result: result('base-argument', callable) },
      { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('base-key', { kind: 'string' }) },
      {
        kind: 'set',
        lineage,
        receiver: operand('base-this', baseInstance),
        strict: true,
        key: operand('base-key', { kind: 'string' }),
        value: operand('base-argument', callable),
        result: null
      },
      ...(options.unknownBase ? [unknownCall(operand('base-this', baseInstance))] : [])
    ],
    frame(baseInstance)
  )
  const derivedBody = body(
    'Derived-constructor',
    [
      { kind: 'parameter', lineage, ordinal: 0, result: result('derived-argument', callable) },
      { kind: 'super-initialize', lineage, arguments: [operand('derived-argument', callable)] }
    ],
    frame(derivedInstance)
  )
  return { classes, bodies: [root, baseBody, ...(options.implicit ? [] : [derivedBody]), body('constructor-worker', [])] }
}

test('native constructor choices enter each selected class frame without publishing their instances', () => {
  for (const mode of ['closed', 'erased', 'missing-conversion', 'publishes', 'conflicting-target', 'different-new-target'] as const) {
    const fixture = constructionFixture({ construct: false, unknownBase: mode === 'publishes' })
    const root = fixture.bodies[0]!
    const constructors = root.blocks.get(root.entry)!.operations.filter((operation) => operation.kind === 'allocate-constructor')
    const sum = (values: readonly Representation[]): Representation => ({
      kind: 'tagged-union',
      arms: values.map((value, index) => ({
        tag: String(index),
        value,
        semanticType: `type|choice-${index}` as never,
        runtimeDiscriminator: { kind: 'carrier' }
      }))
    })
    const output = sum([...fixture.classes.values()].map((layout) => layout.instance!))
    const callee = sum(
      constructors.map((operation) => {
        const representation = operation.result.representation
        return mode === 'erased' && representation.kind === 'constructor-family'
          ? { kind: 'constructor-value-dispatch', abi: representation.abi }
          : representation
      })
    )
    const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
    const choiceInputs = constructors.map((operation, index) => ({
      kind: 'convert' as const,
      lineage,
      source: operand(operation.result.id, operation.result.representation),
      conversionUse: conversions.nodeFor(operation.result.representation, callee).id,
      result: result(`choice-${index}`, callee)
    }))
    const construction: Extract<IrNonTerminatorOperation, { kind: 'construct' }> = {
      kind: 'construct',
      lineage,
      callee: operand('choice', callee),
      newTarget: operand(mode === 'different-new-target' ? 'another-constructor' : 'choice', callee),
      target:
        mode === 'conflicting-target'
          ? { kind: 'exact', target: { kind: 'function', functionId: 'another-constructor' as never, constructable: true }, evidence: [] }
          : { kind: 'open', evidence: ['no-static-target-proof'] },
      arguments: [operand('constructor-worker-value', callable)],
      result: result('choice-instance', output)
    }
    if (mode !== 'missing-conversion') publishOmittedArgumentConversions(construction, conversions)
    fixture.bodies[0] = body(
      'construction-root',
      [
        ...root.blocks.get(root.entry)!.operations,
        ...choiceInputs,
        {
          kind: 'phi',
          lineage,
          incoming: choiceInputs.map((operation) => ({ block: root.entry, value: operand(operation.result.id, callee) })),
          result: result('choice', callee)
        },
        construction,
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('choice-key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('choice-instance', output),
          key: operand('choice-key', { kind: 'string' }),
          result: result('choice-worker', callable)
        }
      ],
      null
    )
    const flow = nativeCallableFlowOf(fixture.bodies, new Map(), fixture.classes, conversions)
    assert.equal(flow.callables.has('choice-worker' as never), mode === 'closed', mode)
    const exposure = reflectionExposureOf(
      fixture.bodies,
      fixture.classes,
      { layoutOf: (id: string) => record(id, 'run', callable) } as never,
      {
        representations: [callee, output],
        shakeComplete: true,
        conversions
      }
    )
    assert.equal(exposure.classes.get('Derived' as never)?.level, mode === 'closed' ? 'keys-only' : 'full', mode)
  }
})

test('native super forwards the actual allocation and arguments without publishing this', () => {
  for (const implicit of [false, true])
    for (const unknownBase of [false, true]) {
      const fixture = constructionFixture({ implicit, unknownBase })
      for (const bodies of [fixture.bodies, [...fixture.bodies].reverse()]) {
        const flow = nativeCallableFlowOf(bodies, new Map(), fixture.classes)
        assert.equal(flow.enteredBodies.has('Base-constructor' as never), true)
        assert.deepEqual(
          flow.callables.get('constructed-read' as never),
          unknownBase ? undefined : { kind: 'exact', functionId: 'constructor-worker' },
          JSON.stringify({ implicit, unknownBase })
        )
      }
    }
})

test('retaining a constructor does not execute it; actual publication opens its base chain', () => {
  for (const publish of [false, true])
    for (const implicit of [false, true]) {
      const fixture = constructionFixture({ construct: false, publish, implicit, unknownBase: true })
      const flow = nativeCallableFlowOf(fixture.bodies, new Map(), fixture.classes)
      assert.equal(flow.enteredBodies.has('Base-constructor' as never), publish)
      if (!implicit) assert.equal(flow.enteredBodies.has('Derived-constructor' as never), publish)
    }
})

test('instance initializers enter on construction or publication, never on class retention alone', () => {
  for (const construct of [false, true])
    for (const publish of [false, true]) {
      const fixture = constructionFixture({ construct, publish })
      const derived = fixture.classes.get('Derived' as never)!
      const initializer = body(
        'derived-initializer',
        [
          { kind: 'receiver', lineage, result: result('initializer-this', derived.instance!) },
          unknownCall(operand('initializer-this', derived.instance!))
        ],
        { ...abi, receiver: derived.instance! }
      )
      fixture.classes.set(derived.declaration, {
        ...derived,
        fields: [
          {
            declaration: 'initializer-field' as never,
            key: 'extra',
            initializer: 'derived-initializer' as never,
            representation: { kind: 'void' },
            syntheticSubclassMemberOverlay: false
          }
        ]
      })
      const flow = nativeCallableFlowOf([...fixture.bodies, initializer], new Map(), fixture.classes)
      assert.equal(flow.enteredBodies.has(initializer.owner), construct || publish)
      if (construct) assert.equal(flow.callables.has('constructed-read' as never), false)
    }
})

test('an unproven super frame keeps its base body observable with unknown inputs', () => {
  const fixture = constructionFixture()
  const base = fixture.classes.get('Base' as never)!
  fixture.classes.set(base.declaration, {
    ...base,
    construct: { ...base.construct!, parameters: [{ value: { kind: 'string' }, passing: 'by-value', ownership: 'owned' }] }
  })
  const flow = nativeCallableFlowOf(fixture.bodies, new Map(), fixture.classes)
  assert.equal(flow.enteredBodies.has('Base-constructor' as never), true)
  assert.equal(flow.callables.has('constructed-read' as never), false)
})

test('an external instance can expose its constructor through the prototype', () => {
  const fixture = constructionFixture({ construct: false })
  const root = fixture.bodies[0]!
  const instance = fixture.classes.get('Derived' as never)!.instance!
  fixture.bodies[0] = body(
    'construction-root',
    [...root.blocks.get(root.entry)!.operations, { ...unknownCall(), result: result('external-instance', instance) }],
    null
  )
  const flow = nativeCallableFlowOf(fixture.bodies, new Map(), fixture.classes)
  assert.equal(flow.enteredBodies.has('Base-constructor' as never), true)
  assert.equal(flow.enteredBodies.has('Derived-constructor' as never), true)
})

test('native class accessors enter through actual reads and writes and preserve callable payloads', () => {
  for (const access of ['none', 'get', 'set', 'escape'] as const)
    for (const publishes of [false, true]) {
      const fixture = constructionFixture()
      const base = fixture.classes.get('Base' as never)!
      const instance = fixture.classes.get('Derived' as never)!.instance!
      fixture.classes.set(base.declaration, {
        ...base,
        accessors: [{ key: 'worker', getter: 'worker-getter' as never, setter: 'worker-setter' as never }]
      })
      let getter = body(
        'worker-getter',
        [
          { kind: 'receiver', lineage, result: result('getter-this', base.instance!) },
          { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('getter-key', { kind: 'string' }) },
          {
            kind: 'get',
            lineage,
            receiver: operand('getter-this', base.instance!),
            key: operand('getter-key', { kind: 'string' }),
            result: result('getter-run', callable)
          },
          ...(publishes ? [unknownCall(operand('getter-this', base.instance!))] : [])
        ],
        { ...abi, receiver: base.instance!, result: callable }
      )
      getter = {
        ...getter,
        blocks: new Map(
          [...getter.blocks].map(([id, block]) => [
            id,
            {
              ...block,
              terminator: {
                kind: 'return',
                lineage: null,
                value: operand('getter-run', callable)
              }
            }
          ])
        )
      }
      const setter = body(
        'worker-setter',
        [
          { kind: 'receiver', lineage, result: result('setter-this', base.instance!) },
          { kind: 'parameter', lineage, ordinal: 0, result: result('setter-argument', callable) },
          { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('setter-key', { kind: 'string' }) },
          {
            kind: 'set',
            lineage,
            strict: true,
            receiver: operand('setter-this', base.instance!),
            key: operand('setter-key', { kind: 'string' }),
            value: operand('setter-argument', callable),
            result: null
          },
          ...(publishes ? [unknownCall(operand('setter-this', base.instance!))] : [])
        ],
        { ...abi, receiver: base.instance!, parameters: [{ value: callable, ownership: 'owned', passing: 'by-value' }] }
      )
      const root = fixture.bodies[0]!
      fixture.bodies[0] = body(
        'construction-root',
        [
          ...root.blocks.get(root.entry)!.operations,
          { kind: 'constant', lineage, literal: 'string', text: 'worker', result: result('accessor-key', { kind: 'string' }) },
          ...(access === 'get'
            ? [
                {
                  kind: 'get',
                  lineage,
                  receiver: operand('constructed', instance),
                  key: operand('accessor-key', { kind: 'string' }),
                  result: result('accessor-read', callable)
                } satisfies IrNonTerminatorOperation
              ]
            : []),
          ...(access === 'set'
            ? [
                {
                  kind: 'set',
                  lineage,
                  strict: true,
                  receiver: operand('constructed', instance),
                  key: operand('accessor-key', { kind: 'string' }),
                  value: operand('constructor-worker-value', callable),
                  result: result('setter-receiver', instance)
                } satisfies IrNonTerminatorOperation
              ]
            : []),
          ...(access === 'escape' ? [unknownCall(operand('constructed', instance))] : [])
        ],
        null
      )
      for (const bodies of [[...fixture.bodies, getter, setter], [setter, getter, ...fixture.bodies].reverse()]) {
        const flow = nativeCallableFlowOf(bodies, new Map(), fixture.classes)
        assert.equal(
          flow.enteredBodies.has(getter.owner),
          access === 'get' || access === 'escape' || (access === 'set' && publishes),
          `${access}/${publishes}:getter`
        )
        assert.equal(
          flow.enteredBodies.has(setter.owner),
          access === 'set' || access === 'escape' || (access === 'get' && publishes),
          `${access}/${publishes}:setter`
        )
        const exposed = access === 'escape' || (access !== 'none' && publishes)
        assert.equal(flow.callables.has('constructed-read' as never), !exposed, `${access}/${publishes}:field`)
        if (access === 'get') assert.equal(flow.callables.has('accessor-read' as never), !exposed)
      }
    }
})

test('an accessor proof cannot borrow another override, host layout or payload convention', () => {
  const fixture = constructionFixture()
  const base = fixture.classes.get('Base' as never)!
  const derived = fixture.classes.get('Derived' as never)!
  const getter = body('accessor-proof-getter', [], { ...abi, receiver: base.instance!, result: callable })
  fixture.classes.set(base.declaration, { ...base, accessors: [{ key: 'worker', getter: getter.sourceOwner as never, setter: null }] })
  const get: IrNonTerminatorOperation = {
    kind: 'get',
    lineage,
    receiver: operand('base-instance', base.instance!),
    key: operand('accessor-key', { kind: 'string' }),
    result: result('proof-read', callable)
  }
  const entry = (operation = get, key: string | null = 'worker') =>
    nativeClassAccessorEntryOf(operation, key, fixture.classes, (id) => (id === getter.sourceOwner ? getter : null))
  assert.ok(entry())
  assert.equal(entry(get, null), null)
  assert.equal(entry({ ...get, result: result('erased-result', dynamic) }), null)
  fixture.classes.set(derived.declaration, { ...derived, accessors: [{ key: 'worker', getter: 'override-getter' as never, setter: null }] })
  assert.equal(entry(), null)
  fixture.classes.set(derived.declaration, derived)
  fixture.classes.set(base.declaration, {
    ...fixture.classes.get(base.declaration)!,
    nativeBase: {
      protocol: 'host-base',
      instance: { kind: 'native-record-ref', shapeId: 'host-base', native: 'HostBase', ownership: 'shared-refcount' }
    }
  })
  assert.equal(entry(), null)
})

test('cyclic aliases carry late callable origins and propagate publication backwards', () => {
  const receiver = record('cyclic-alias', 'run', callable)
  for (const publish of [false, true]) {
    const aliases: IrNonTerminatorOperation[] = Array.from({ length: 128 }, (_, index) => ({
      kind: 'phi',
      lineage,
      incoming: (index === 0 ? ['instance', 'alias-127'] : [`alias-${index - 1}`]).map((id) => ({
        block: 'root-entry' as never,
        value: operand(id, receiver)
      })),
      result: result(`alias-${index}`, receiver)
    }))
    const root = body(
      'root',
      [
        allocate('worker'),
        {
          kind: 'allocate-record',
          lineage,
          fields: [{ key: 'run', value: operand('worker-value', callable) }],
          result: result('instance', receiver)
        },
        ...aliases.reverse(),
        { kind: 'constant', lineage, literal: 'string', text: 'run', result: result('key', { kind: 'string' }) },
        {
          kind: 'get',
          lineage,
          receiver: operand('alias-64', receiver),
          key: operand('key', { kind: 'string' }),
          result: result('read', callable)
        },
        ...(publish ? [unknownCall(operand('alias-127', receiver))] : [])
      ],
      null
    )
    const worker = body('worker', [])
    for (const bodies of [
      [root, worker],
      [worker, root]
    ]) {
      const flow = nativeCallableFlowOf(bodies, new Map(), new Map())
      assert.equal(flow.callables.has('read' as never), !publish)
      if (!publish) assert.deepEqual(flow.callables.get('read' as never), { kind: 'exact', functionId: 'worker' })
    }
  }
})
