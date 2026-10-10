import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { structuralConversionKey } from '../conversion/structural-plan.js'
import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import {
  hostObjectRouteKey,
  hostObjectWalkPlanMatches,
  hostObjectWalkPlanOf,
  nativeArrayDescriptorSnapshotRequired,
  hostTemplateConversionInputsOf
} from './host-template-conversions.js'
import type { CallOperation, IrOperation } from './model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
const array = (element: Representation): Representation => ({
  kind: 'array-object',
  element,
  ownership: 'shared-refcount',
  extension: null
})
const record = (value: Representation): Representation => ({
  kind: 'record',
  shapeId: 'source',
  ownership: 'shared-refcount',
  fields: [{ key: 'x', value, required: true }],
  accessors: []
})
const operand = (representation: Representation, name = 'argument') => ({ value: name as IrValueId, representation })
const frame: Representation = { kind: 'function-value-dispatch', abi: { receiver: null, parameters: [], restFrom: null, result: dynamic } }
const call = (arguments_: readonly Representation[], result: Representation): CallOperation =>
  ({
    kind: 'call',
    lineage: 'call' as never,
    callee: operand(frame, 'method'),
    arguments: arguments_.map((value, position) => operand(value, `argument-${position}`)),
    result: { id: 'result' as IrValueId, representation: result }
  }) as unknown as CallOperation
const definitionFor = (protocol: string, member: string, receiver?: Representation): ((value: IrValueId) => IrOperation | null) => {
  const read = {
    kind: 'get',
    lineage: 'get',
    key: operand(string, 'key'),
    receiver: operand(
      receiver ?? { kind: 'native-handle', protocol, version: 1, native: null, bases: [], call: null, construct: null },
      'receiver'
    ),
    result: { id: 'method', representation: frame },
    ...(receiver === undefined ? { hostMethod: { protocol, member } } : {})
  } as unknown as IrOperation
  const key = {
    kind: 'constant',
    lineage: 'key',
    literal: 'string',
    text: member,
    result: { id: 'key', representation: string }
  } as unknown as IrOperation
  return (value) => (value === 'method' ? read : value === 'key' ? key : null)
}
const deriver = { isTupleShape: () => false } as unknown as RepresentationDeriver
const classes = new Map()

test('Object.assign cites the native target field rather than its ambient any argument', () => {
  const target = record(optional)
  const source = record(string)
  const operation = call([target, source], target)
  const inputs = hostTemplateConversionInputsOf(operation, definitionFor('ObjectConstructor', 'assign'), deriver, classes)
  assert.deepEqual(
    inputs.map((input) => structuralConversionKey(input.source, input.target)),
    [structuralConversionKey(string, optional)]
  )
})

test('a uniquely authenticated host alias retains its native leaves and optional walk plan', () => {
  const declaration = 'held-object-assign' as DeclarationId
  const aliases = new Map([[declaration, { protocol: 'ObjectConstructor', member: 'assign' }]])
  const definitionOf = (value: IrValueId): IrOperation | null =>
    value === 'method'
      ? ({ kind: 'binding-read', declaration, result: { id: 'method', representation: frame } } as unknown as IrOperation)
      : null
  const target = record(optional)
  const operation = call([target, record(string)], target)
  assert.deepEqual(
    hostTemplateConversionInputsOf(operation, definitionOf, deriver, classes, undefined, aliases),
    hostTemplateConversionInputsOf(operation, definitionFor('ObjectConstructor', 'assign'), deriver, classes)
  )
  assert.deepEqual(hostTemplateConversionInputsOf(operation, definitionOf, deriver, classes), [])
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const plan = hostObjectWalkPlanOf(operation, definitionOf, deriver, classes, census, aliases)
  assert.ok(plan)
  assert.equal(hostObjectWalkPlanMatches(operation, plan, definitionOf, deriver, classes, census, aliases), true)
  assert.equal(hostObjectWalkPlanMatches(operation, plan, definitionOf, deriver, classes, census), false)
  assert.deepEqual(
    hostTemplateConversionInputsOf(
      operation,
      definitionOf,
      deriver,
      classes,
      undefined,
      new Map([['other-cell' as DeclarationId, aliases.get(declaration)!]])
    ),
    [],
    'a different binding cannot inherit the authenticated alias'
  )
})

test('native Array callbacks and absent results cite only their actual internal carriers', () => {
  const callback: Representation = {
    ...frame,
    abi: { ...frame.abi, parameters: [{ value: dynamic, ownership: 'owned', passing: 'by-value' }] }
  }
  const mapped = call([callback], array(string))
  const inputs = hostTemplateConversionInputsOf(mapped, definitionFor('', 'map', array(string)), deriver, classes)
  assert.deepEqual(
    inputs.map((input) => structuralConversionKey(input.source, input.target)),
    [structuralConversionKey(string, dynamic)]
  )
  const popped = call([], dynamic)
  const pop = hostTemplateConversionInputsOf(popped, definitionFor('', 'pop', array(string)), deriver, classes)
  assert.equal(pop.length, 1)
  assert.equal(representationKey(pop[0]!.source), representationKey(optional))
  assert.equal(pop[0]!.target, dynamic)
})

test('ownKeys retains both native PropertyKey lanes in the published result element', () => {
  const element: Representation = {
    kind: 'tagged-union',
    arms: [
      { tag: 'string', semanticType: 'string' as never, runtimeDiscriminator: { kind: 'carrier' }, value: string },
      { tag: 'symbol', semanticType: 'symbol' as never, runtimeDiscriminator: { kind: 'carrier' }, value: { kind: 'symbol' } }
    ]
  }
  const inputs = hostTemplateConversionInputsOf(
    call([record(number)], array(element)),
    definitionFor('Reflect', 'ownKeys'),
    deriver,
    classes
  )
  assert.deepEqual(
    inputs.map((input) => input.source.kind),
    ['string', 'symbol']
  )
  assert.ok(inputs.every((input) => input.target === element))
  const nativeReceiver: Representation = {
    kind: 'native-record-ref',
    shapeId: 'reflect-namespace',
    ownership: 'owned',
    native: 'gea::ReflectNamespace'
  }
  const nativeInputs = hostTemplateConversionInputsOf(
    call([record(number)], array(element)),
    definitionFor('', 'ownKeys', nativeReceiver),
    deriver,
    classes
  )
  assert.deepEqual(nativeInputs, inputs, 'a declaration-authenticated native namespace needs no synthetic Get.hostMethod marker')
  const unrelated = { ...nativeReceiver, native: 'other-native-namespace' }
  assert.deepEqual(
    hostTemplateConversionInputsOf(call([record(number)], array(element)), definitionFor('', 'ownKeys', unrelated), deriver, classes),
    [],
    'the member name alone cannot claim another namespace'
  )
})

test('an Array descriptor cites only the selected index, length, or sidecar value route', () => {
  const descriptor: Representation = {
    kind: 'record',
    shapeId: 'descriptor',
    ownership: 'owned',
    fields: [{ key: 'value', value: string, required: true }],
    accessors: []
  }
  const operation = call([array(string), string], descriptor)
  const host = definitionFor('ObjectConstructor', 'getOwnPropertyDescriptor')
  const withKey =
    (text: string) =>
    (value: IrValueId): IrOperation | null =>
      value === 'argument-1'
        ? { kind: 'constant', lineage: 'argument-key' as never, literal: 'string', text, result: { id: value, representation: string } }
        : host(value)
  assert.deepEqual(hostTemplateConversionInputsOf(operation, withKey('0'), deriver, classes), [])
  assert.deepEqual(
    hostTemplateConversionInputsOf(operation, withKey('length'), deriver, classes).map((input) => input.source),
    [number]
  )
  assert.deepEqual(
    hostTemplateConversionInputsOf(operation, withKey('raw'), deriver, classes).map((input) => input.source),
    [{ kind: 'dynamic', reason: 'opt-in-fallback' }]
  )
})

test('only an actual live array receiver requires the original descriptor snapshot protocol', () => {
  const receiver = array(string)
  const operation = call([receiver, string], record(string))
  const live = new Set([operation.arguments[0]!.value])
  const descriptor = definitionFor('ObjectConstructor', 'getOwnPropertyDescriptor')
  assert.equal(nativeArrayDescriptorSnapshotRequired(operation, descriptor, live), true)
  assert.equal(nativeArrayDescriptorSnapshotRequired(operation, descriptor, new Set()), false)
  assert.equal(nativeArrayDescriptorSnapshotRequired(operation, definitionFor('ObjectConstructor', 'values'), live), false)
  assert.equal(nativeArrayDescriptorSnapshotRequired(operation, definitionFor('OtherConstructor', 'getOwnPropertyDescriptor'), live), false)
  const ordinaryObject = call([record(string), string], record(string))
  assert.equal(nativeArrayDescriptorSnapshotRequired(ordinaryObject, descriptor, live), false)
  const erased = call([dynamic, string], record(string))
  assert.equal(
    nativeArrayDescriptorSnapshotRequired(erased, descriptor, live),
    false,
    'a dynamic receiver already uses original dynamic descriptors'
  )
})

test('an optional Object walk seals its exact canonical callback nodes independently of static fields', () => {
  const source = record(optional)
  const operation = call([source], array(dynamic))
  const definitionOf = definitionFor('ObjectConstructor', 'values')
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const inputs = hostTemplateConversionInputsOf(operation, definitionOf, deriver, classes)
  assert.deepEqual(
    inputs.map((input) => structuralConversionKey(input.source, input.target)),
    [structuralConversionKey(optional, dynamic)]
  )
  const plan = hostObjectWalkPlanOf(operation, definitionOf, deriver, classes, census)
  assert.ok(plan)
  assert.equal(
    plan.routes.get(hostObjectRouteKey(source, 'values'))?.get(structuralConversionKey(dynamic, dynamic)),
    census.nodeFor(dynamic, dynamic)
  )
  assert.equal(hostObjectWalkPlanMatches(operation, plan, definitionOf, deriver, classes, census), true)
  assert.equal(hostObjectWalkPlanMatches(operation, { ...plan, routes: new Map() }, definitionOf, deriver, classes, census), false)
})

test('a rejected creation-order callback leaves the admissible static Object copy intact', () => {
  const source = record(number)
  const operation = call([source], array(number))
  const definitionOf = definitionFor('ObjectConstructor', 'values')
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const rejected: ConversionNode = {
    id: structuralConversionKey(dynamic, number),
    source: dynamic,
    target: number,
    capability: { kind: 'never', reason: 'the optional runtime-key path is unsupported' }
  }
  const conversions = {
    ...census,
    nodeFor: (source: Representation, target: Representation) =>
      structuralConversionKey(source, target) === rejected.id ? rejected : census.nodeFor(source, target),
    nodeById: (id: string) => (id === rejected.id ? rejected : census.nodeById(id))
  }
  const plan = hostObjectWalkPlanOf(operation, definitionOf, deriver, classes, conversions)
  assert.equal(plan?.routes.size, 0)
  assert.deepEqual(hostTemplateConversionInputsOf(operation, definitionOf, deriver, classes), [])
})

test('a future Object walk cannot borrow a prior guard hidden in a dependency', () => {
  const source = record(number)
  const operation = call([source], array(number))
  const definitionOf = definitionFor('ObjectConstructor', 'values')
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const guard: ConversionNode = {
    id: 'prior',
    source: number,
    target: string,
    capability: { kind: 'static', materializer: { id: 'prior', domain: 'prior', allocates: false, requiresSourceGuard: true } }
  }
  const outer: ConversionNode = {
    id: structuralConversionKey(dynamic, number),
    source: dynamic,
    target: number,
    capability: { kind: 'static', materializer: { id: 'future', domain: 'future', allocates: false, dependencies: [guard] } }
  }
  const conversions = {
    ...census,
    nodeFor: (source: Representation, target: Representation) =>
      structuralConversionKey(source, target) === outer.id ? outer : census.nodeFor(source, target),
    nodeById: (id: string) => (id === outer.id ? outer : id === guard.id ? guard : census.nodeById(id))
  }
  assert.equal(hostObjectWalkPlanOf(operation, definitionOf, deriver, classes, conversions)?.routes.size, 0)
})

test('a pass-through host row cites a dynamic argument into its peeled native scalar or string slot', () => {
  const operation = call([dynamic], array(number))
  const own: CallOperation = {
    ...operation,
    callee: operand(
      { ...frame, abi: { ...frame.abi, parameters: [{ value: optional, ownership: 'owned', passing: 'const-ref' }] } },
      'method'
    )
  }
  const definitions = definitionFor('TextEncoder', 'encode')
  const inputs = hostTemplateConversionInputsOf(own, definitions, deriver, classes, {
    members: new Map([['TextEncoder.encode', { kind: 'method', arity: 'pass-through', emit: '{receiver}.encode({args})' }]])
  })
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]!.source, dynamic)
  assert.equal(inputs[0]!.target, string)
  assert.deepEqual(hostTemplateConversionInputsOf(own, definitions, deriver, classes, { members: new Map() }), [])
})
