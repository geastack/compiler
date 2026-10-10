import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import { nativeUnboundMethodContractOf } from '../conversion/native-method.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { declarationId, functionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { GetOperation } from './model.js'
import { methodConversionInputsOf, methodValueRecipesMatch } from './publish-conversion-recipes.js'

const declaration = declarationId('method-publication', 0)
const callable = functionId(declarationId('method-publication', 1))
const receiver: Representation = {
  kind: 'class-ref',
  declaration,
  shapeId: 'method-instance',
  ownership: 'shared-refcount',
  ancestors: []
}
const string: Representation = { kind: 'string' }
const publicAbi: CallableAbi = {
  receiver: null,
  parameters: [{ value: string, ownership: 'owned', passing: 'const-ref' }],
  result: string,
  restFrom: null
}
const methodAbi: CallableAbi = { ...publicAbi, receiver }
const target: Representation = { kind: 'function-value-dispatch', abi: publicAbi }
const source: Representation = { kind: 'function-value-dispatch', abi: methodAbi }
const layout = {
  declaration,
  base: null,
  nativeBase: null,
  instance: receiver,
  fields: [],
  accessors: [],
  methods: [{ key: 'probe', callable, representation: source }],
  methodOverrides: [{ key: 'probe', value: source, required: false }]
} as unknown as ClassLayout
const classes = new Map([[declaration, layout]])
const abis = new Map([[callable, methodAbi]])
const get = (representation: Representation = receiver): GetOperation =>
  ({ kind: 'get', receiver: { representation }, result: { representation: target } }) as unknown as GetOperation

test('method publication cites prototype and own storage separately using the projected body ABI', () => {
  const inputs = methodConversionInputsOf(get(), 'probe', classes, abis)
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0]?.origin, 'prototype')
  assert.equal(inputs[0]?.callable, callable)
  assert.equal(inputs[1]?.origin, 'own')
  assert.equal(inputs[1]?.callable, null)
  assert.equal(representationKey(inputs[0]!.source), representationKey(source))
  assert.equal(nativeUnboundMethodContractOf(inputs[0]!.source, target)?.identity, 'preserved')
})

test('method publication handles nullable class arms and finite computed method keys', () => {
  const operation = {
    ...get({ kind: 'optional', payload: receiver, absence: 'undefined' }),
    provenKeyTexts: ['probe', 'absent']
  }
  const inputs = methodConversionInputsOf(operation, null, classes, abis)
  assert.equal(inputs.length, 2)
  assert.ok(inputs.every((input) => input.key === 'probe'))
})

test('method publication reads the physical body convention rather than the declared method view', () => {
  const differentAbi = { ...methodAbi, result: { kind: 'scalar', domain: 'number' } as Representation }
  const inputs = methodConversionInputsOf(get(), 'probe', classes, new Map([[callable, differentAbi]]))
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0]?.origin, 'prototype')
  assert.equal(inputs[1]?.origin, 'own')
  assert.equal(representationKey(inputs[0]!.source), representationKey({ kind: 'function-value-dispatch', abi: differentAbi }))
})

test('a bodyless abstract method publishes every reachable concrete allocation method', () => {
  const child = declarationId('method-publication', 2)
  const childCallable = functionId(declarationId('method-publication', 3))
  const childReceiver: Representation = { ...receiver, declaration: child, shapeId: 'method-child', ancestors: [declaration] }
  const childAbi: CallableAbi = { ...methodAbi, receiver: childReceiver }
  const abstractLayout = {
    ...layout,
    allocationAbsent: true,
    methods: [{ key: 'probe', callable: null, representation: source }],
    methodOverrides: []
  } as unknown as ClassLayout
  const childLayout = {
    ...layout,
    declaration: child,
    base: declaration,
    instance: childReceiver,
    methods: [{ key: 'probe', callable: childCallable, representation: { kind: 'function-value-dispatch', abi: childAbi } }],
    methodOverrides: []
  } as unknown as ClassLayout
  const inputs = methodConversionInputsOf(
    { ...get(), provenKeyTexts: ['probe'] },
    null,
    new Map([
      [declaration, abstractLayout],
      [child, childLayout]
    ]),
    new Map([[childCallable, childAbi]])
  )
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.callable, childCallable)
  assert.equal(inputs[0]?.origin, 'prototype')
  assert.equal(representationKey(inputs[0]!.source), representationKey({ kind: 'function-value-dispatch', abi: childAbi }))
})

test('typed-this callable fields cite physical class storage rather than the declared field carrier', () => {
  const fieldLayout = {
    ...layout,
    fields: [{ key: 'probe', representation: target }],
    methods: [],
    methodOverrides: [],
    nativeStorage: { fields: [{ key: 'probe', value: source, required: true }] }
  } as unknown as ClassLayout
  const deriver = {
    layoutOf: () => {
      throw new Error('physical class storage should supply the carrier')
    }
  } as unknown as RepresentationDeriver
  const inputs = methodConversionInputsOf(get(), 'probe', new Map([[declaration, fieldLayout]]), abis, deriver)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.origin, 'own')
  assert.equal(inputs[0]?.callable, null)
  assert.equal(representationKey(inputs[0]!.source), representationKey(source))
})

test('typed-this own callable fields are published for expanded and named record arms', () => {
  const record: Representation = {
    kind: 'record',
    shapeId: 'method-field-record',
    fields: [{ key: 'probe', value: source, required: true }],
    accessors: [],
    ownership: 'shared-refcount'
  }
  const named: Representation = { kind: 'native-record-ref', shapeId: record.shapeId, native: null, ownership: 'shared-refcount' }
  const deriver = { layoutOf: () => record } as unknown as RepresentationDeriver
  for (const carrier of [record, named]) {
    const operation = { ...get({ kind: 'optional', payload: carrier, absence: 'undefined' }), provenKeyTexts: ['probe', 'absent'] }
    const inputs = methodConversionInputsOf(operation, null, classes, abis, deriver)
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0]?.key, 'probe')
    assert.equal(inputs[0]?.origin, 'own')
    assert.equal(inputs[0]?.callable, null)
  }
})

test('method proof verification rejects a changed origin or unpublished node', () => {
  const inputs = methodConversionInputsOf(get(), 'probe', classes, abis)
  const node: ConversionNode = { id: 'method-proof', source, target, capability: { kind: 'identity' } }
  const census = {
    nodeById: (id: string) => (id === node.id ? node : null),
    nativeMethodFor: () => node,
    nativeBufferMethodFor: () => null
  } as Pick<ConversionCensus, 'nodeById' | 'nativeMethodFor' | 'nativeBufferMethodFor'>
  const recipes = inputs.map((input) => ({ ...input, conversion: node.id }))
  assert.equal(methodValueRecipesMatch(inputs, recipes, census), true)
  assert.equal(methodValueRecipesMatch(inputs, [{ ...recipes[0]!, origin: 'own' }, recipes[1]!], census), false)
  assert.equal(methodValueRecipesMatch(inputs, recipes, { ...census, nodeById: () => ({ ...node }) }), false)
  assert.equal(
    methodValueRecipesMatch(
      inputs,
      recipes.map((recipe) => ({ ...recipe, conversion: 'missing' })),
      census
    ),
    false
  )
})
