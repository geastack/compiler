import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { declarationId, functionId, type StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { virtualDispatchKey } from '../projection/dispatch.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { allOperationsOf, type GetOperation } from './model.js'
import { compatibilityFieldReadSourcesOf, propertyReadConversionInputsOf } from './property-read-conversions.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const empty: Representation = { kind: 'record', shapeId: 'empty', ownership: 'shared-refcount', fields: [], accessors: [] }
const deriver = { layoutOf: () => empty } as unknown as RepresentationDeriver
const get = (receiver: Representation, result: Representation): GetOperation => ({
  kind: 'get',
  lineage: 'property-read' as never,
  receiver: { value: 'receiver' as never, representation: receiver },
  key: { value: 'key' as never, representation: string },
  result: { id: 'result' as never, representation: result }
})

test('synthetic finite-key reads cite their fixed native fields without boxing the result', () => {
  const receiver: Representation = {
    kind: 'record',
    shapeId: 'fixed',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'count', value: number, required: true },
      { key: 'label', value: string, required: true }
    ]
  }
  const operation = get(receiver, sum(number, string))
  const inputs = propertyReadConversionInputsOf(operation, null, deriver, new Map())
  assert.deepEqual(
    inputs.map((input) => input.source),
    [number, string]
  )
  assert.ok(inputs.every((input) => input.target === operation.result.representation))
  const sealed = { ...operation, typedComputedRead: {} as NonNullable<GetOperation['typedComputedRead']> }
  assert.deepEqual(compatibilityFieldReadSourcesOf(sealed, deriver), [])
  assert.deepEqual(propertyReadConversionInputsOf(sealed, null, deriver, new Map()), [])
})

test('getter reads use the settled virtual result rather than an implementation body result', () => {
  const declaration = declarationId('property-read-test', 0)
  const getter = functionId(declarationId('property-read-test', 1))
  const receiver: Representation = { kind: 'class-ref', declaration, shapeId: 'instance', ownership: 'shared-refcount', ancestors: [] }
  const abi: CallableAbi = { receiver, parameters: [], result: string, restFrom: null }
  const layout = {
    declaration,
    base: null,
    nativeBase: null,
    instance: receiver,
    fields: [],
    methods: [],
    methodOverrides: [],
    accessors: [{ key: 'label', getter, setter: null }]
  } as unknown as ClassLayout
  const classes = new Map([[declaration, layout]])
  const operation = get(receiver, optional)
  assert.deepEqual(
    propertyReadConversionInputsOf(operation, 'label', deriver, classes, new Map([[getter, abi]])).map((input) => input.source),
    [string]
  )
  const joined = sum(string, number)
  const virtual = new Map([[virtualDispatchKey(declaration, 'label', 'get'), { ...abi, result: joined }]])
  const inputs = propertyReadConversionInputsOf(operation, 'label', deriver, classes, new Map([[getter, abi]]), virtual)
  assert.deepEqual(
    inputs.map((input) => input.source),
    [joined]
  )
  // Abstract getters have no implementation ABI, but dispatch still owns
  // their physical result frame.
  assert.deepEqual(
    propertyReadConversionInputsOf(operation, 'label', deriver, classes, new Map(), virtual).map((input) => input.source),
    [joined]
  )
})

test('native sidecar lookups cite only their dynamic property result, keeping typed slots native', () => {
  const fields = [{ key: 'label', value: string, required: true }]
  const receiver: Representation = { ...empty, fields } as Representation
  assert.deepEqual(propertyReadConversionInputsOf(get(receiver, optional), 'label', deriver, new Map()), [])
  const inputs = propertyReadConversionInputsOf(get(receiver, optional), 'extra', deriver, new Map())
  assert.deepEqual(
    inputs.map((input) => input.source),
    [dynamic]
  )
  const valueRecord: Representation = { ...empty, ownership: 'owned' }
  assert.deepEqual(propertyReadConversionInputsOf(get(valueRecord, optional), 'extra', deriver, new Map()), [])
  const map: Representation = { kind: 'keyed-collection', family: 'map', key: string, value: number, ownership: 'shared-refcount' }
  assert.deepEqual(propertyReadConversionInputsOf(get(map, optional), 'get', deriver, new Map()), [])
  const date: Representation = { kind: 'native-record-ref', shapeId: 'date', native: 'gea::runtime::Date', ownership: 'shared-refcount' }
  assert.deepEqual(propertyReadConversionInputsOf(get(date, optional), 'getTime', deriver, new Map()), [])
})

test('numeric native elements cite their physical scalar rather than a sidecar box', () => {
  const receiver: Representation = { kind: 'typed-array', element: 'uint8', buffer: 'array-buffer', ownership: 'shared-refcount' }
  const operation = {
    ...get(receiver, { kind: 'optional', payload: number, absence: 'undefined' }),
    key: { value: 'key' as never, representation: number }
  } as GetOperation
  assert.deepEqual(
    propertyReadConversionInputsOf(operation, null, deriver, new Map()).map((input) => input.source),
    [number]
  )
  assert.deepEqual(
    propertyReadConversionInputsOf(get(receiver, operation.result.representation), '0', deriver, new Map()).map((input) => input.source),
    [number]
  )
})

test('an exact native numeric index never invents a declared-any expando reader', () => {
  const slot: Representation = { kind: 'native-record-ref', shapeId: 'slot', native: null, ownership: 'shared-refcount' }
  const indexed: Representation = {
    kind: 'record-with-index',
    shapeId: 'registry',
    ownership: 'shared-refcount',
    fields: [{ key: 'length', value: number, required: true }],
    indexes: [{ key: 'number', value: slot }]
  }
  const owner: Representation = { kind: 'native-record-ref', shapeId: 'registry', native: null, ownership: 'shared-refcount' }
  const indexedDeriver = { layoutOf: () => indexed } as unknown as RepresentationDeriver
  assert.deepEqual(propertyReadConversionInputsOf(get(owner, slot), '0', indexedDeriver, new Map()), [])
  // A general string may select a fixed field or an actual expando. It has
  // no number-index proof merely because a typed sidecar exists alongside it.
  assert.equal(
    propertyReadConversionInputsOf(get(owner, slot), null, indexedDeriver, new Map()).some((input) => input.source.kind === 'dynamic'),
    true
  )
})

test('typed indexed records retain their native recursive entry storage through compilation', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/record-trace-leaf-index-cycle.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true)
  assert.notEqual(result.source, null, JSON.stringify({ refusals: result.refusals, emission: result.emissionRefusals }))
  const reads = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter((operation): operation is GetOperation => {
      if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'native-record-ref') return false
      const layout = result.representations.deriver.layoutOf(operation.receiver.representation.shapeId as StructuralTypeId)
      return layout.kind === 'record-with-index' && operation.result.representation.kind === 'native-record-ref'
    })
  assert.equal(reads.length, 2)
  for (const read of reads) {
    assert.equal(
      (read.conversionRecipes ?? []).some((recipe) => recipe.source.kind === 'dynamic'),
      false
    )
    assert.equal(read.result.representation.kind, 'native-record-ref')
  }
  assert.doesNotMatch(result.source!, /gea_traceLeaf/, 'a recursive entry pointing back at its registry is a tracing edge')
})

test('computed native unions and narrowed dynamic receivers cite the actual property table carrier', () => {
  const receiver = sum(empty, dynamic)
  assert.deepEqual(
    propertyReadConversionInputsOf(get(receiver, optional), null, deriver, new Map()).map((input) => input.source),
    [dynamic]
  )
  const shadowed: Representation = { kind: 'dynamic', reason: 'shadowed-callable-builtin' }
  const inputs = propertyReadConversionInputsOf(get(shadowed, string), 'label', deriver, new Map())
  assert.equal(inputs.length, 1)
  assert.equal(representationKey(inputs[0]!.source), representationKey(dynamic))
  const dictionaries = sum(
    { kind: 'dictionary', key: 'string', value: string, ownership: 'shared-refcount' },
    { kind: 'dictionary', key: 'string', value: number, ownership: 'shared-refcount' }
  )
  assert.deepEqual(propertyReadConversionInputsOf(get(dictionaries, optional), null, deriver, new Map()), [])
})

test('native base fields remain typed when the source class has no declared member', () => {
  const declaration = declarationId('native-base-read-test', 0)
  const native: Representation = {
    kind: 'native-record-ref',
    shapeId: 'native-error',
    native: 'gea::runtime::Error',
    ownership: 'shared-refcount'
  }
  const receiver: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'instance',
    ownership: 'shared-refcount',
    ancestors: [],
    nativeBase: native
  }
  const layout = {
    declaration,
    base: null,
    nativeBase: { protocol: 'ErrorConstructor', instance: native },
    instance: receiver,
    fields: [],
    methods: [],
    methodOverrides: [],
    accessors: []
  } as unknown as ClassLayout
  const nativeDeriver = {
    layoutOf: () => ({ ...empty, fields: [{ key: 'message', value: string, required: true }] })
  } as unknown as RepresentationDeriver
  const operation = get(sum(receiver, native), optional)
  assert.deepEqual(
    propertyReadConversionInputsOf(operation, 'message', nativeDeriver, new Map([[declaration, layout]])).map((input) => input.source),
    [string]
  )
})
