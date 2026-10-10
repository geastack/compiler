import assert from 'node:assert/strict'
import test from 'node:test'
import { declarationId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'
import { arrayPrototypeMethods, stringPrototypeMethods } from '../representation/prototype-domains.js'
import { arrayMethods } from '../targets/cpp/prototype/emit-prototype-array.js'
import { stringMethods } from '../targets/cpp/prototype/emit-prototype-string.js'
import type { CallOperation, IrOperation } from './model.js'
import { nativePrototypeCallClaimsOf, nativePrototypeMethodOf } from './native-prototype-calls.js'
import { operationConversionInputsOf, operationConversionsOf } from './operation-conversions.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'

const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const entry: Representation = {
  kind: 'class-ref',
  declaration: declarationId('native-prototype', 0),
  shapeId: 'entry',
  ancestors: [],
  ownership: 'shared-refcount'
}
const collection: Representation = { kind: 'keyed-collection', family: 'map', key: string, value: entry, ownership: 'shared-refcount' }
const deriver = {
  layoutOf: (shapeId: string): Representation => ({ kind: 'record', shapeId, ownership: 'shared-refcount', fields: [], accessors: [] })
} as unknown as RepresentationDeriver

const callOf = (receiver: Representation, member: string, result: Representation, arguments_: readonly Representation[]) => {
  const ambientResult: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: dynamic,
    value: dynamic,
    ownership: 'shared-refcount'
  }
  const callee: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: arguments_.map(() => ({ value: dynamic, passing: 'by-value', ownership: 'owned' })),
      restFrom: null,
      result: ambientResult
    }
  }
  const operation = {
    kind: 'call',
    lineage: 'native-prototype-call',
    callee: { value: 'callee', representation: callee },
    receiver: null,
    arguments: arguments_.map((representation, index) => ({ value: `argument-${index}`, representation })),
    result: { id: 'result', representation: result }
  } as unknown as CallOperation
  const read = {
    kind: 'get',
    lineage: 'read',
    receiver: { value: 'receiver', representation: receiver },
    key: { value: 'key', representation: string },
    result: { id: 'callee', representation: callee }
  } as unknown as IrOperation
  const key = {
    kind: 'constant',
    lineage: 'key',
    literal: 'string',
    text: member,
    result: { id: 'key', representation: string }
  } as unknown as IrOperation
  const definitionOf = (value: unknown): IrOperation | null => (value === 'callee' ? read : value === 'key' ? key : null)
  return { operation, definitionOf }
}

test('native collection calls enter their storage slots without the ambient any frame', () => {
  const { operation, definitionOf } = callOf(collection, 'set', collection, [string, entry])
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, definitionOf)
  assert.deepEqual(inputs, [])
  const get = callOf(collection, 'get', entry, [string])
  const reads = operationConversionInputsOf(get.operation, null, deriver, new Map(), false, undefined, get.definitionOf)
  assert.deepEqual(reads, [{ role: 'prototype-result', source: { kind: 'optional', payload: entry, absence: 'undefined' }, target: entry }])
})

test('native storage that is genuinely declared any retains its exact argument boundary', () => {
  const receiver: Representation = { ...collection, value: dynamic }
  const { operation, definitionOf } = callOf(receiver, 'set', receiver, [string, entry])
  const inputs = operationConversionInputsOf(operation, null, deriver, new Map(), false, undefined, definitionOf)
  assert.deepEqual(inputs, [{ role: 'prototype-argument', source: entry, target: dynamic }])
})

test('prototype call identity requires the exact Get and constant key', () => {
  const { operation, definitionOf } = callOf(collection, 'set', collection, [string, entry])
  assert.equal(
    nativePrototypeCallClaimsOf(operation, () => null, new Map()),
    null
  )
  assert.equal(
    nativePrototypeCallClaimsOf(operation, (value) => (value === 'key' ? null : definitionOf(value)), new Map()),
    null
  )
  assert.equal(nativePrototypeMethodOf(collection, 'add'), null)
  const array: Representation = {
    kind: 'array-object',
    element: string,
    ownership: 'shared-refcount',
    extension: [{ key: 'map', value: dynamic, required: true }]
  }
  assert.equal(nativePrototypeMethodOf(array, 'map'), null)
})

test('a native subclass view is cited only where no own member overrides the prototype', () => {
  const receiver: Representation = { ...entry, nativeBase: collection }
  const layout = {
    declaration: entry.kind === 'class-ref' ? entry.declaration : null,
    base: null,
    nativeBase: { instance: collection },
    instance: receiver,
    fields: [],
    methods: [],
    accessors: []
  } as unknown as ClassLayout
  const classes = new Map([[layout.declaration, layout]])
  const { operation, definitionOf } = callOf(receiver, 'get', entry, [string])
  const inputs = operationConversionInputsOf(operation, null, deriver, classes, false, undefined, definitionOf)
  assert.ok(inputs.some((input) => input.role === 'native-base-view' && input.source === receiver && input.target === collection))
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const recipes = operationConversionsOf(inputs, census)
  const view = recipes.find((recipe) => recipe.role === 'native-base-view')!
  assert.equal(census.nodeById(view.conversion), census.nativeBaseViewFor(receiver, collection))
  classes.set(layout.declaration, { ...layout, fields: [{ key: 'get' }] as never })
  assert.equal(nativePrototypeCallClaimsOf(operation, definitionOf, classes), null)
})

test('supported prototype domains and native renderers remain complete in both directions', () => {
  assert.deepEqual([...arrayPrototypeMethods].sort(), [...arrayMethods.keys()].sort())
  assert.deepEqual([...stringPrototypeMethods].sort(), [...stringMethods.keys()].sort())
  const { operation, definitionOf } = callOf({ kind: 'optional', payload: collection, absence: 'undefined' }, 'get', entry, [string])
  assert.equal(
    representationKey(nativePrototypeCallClaimsOf(operation, definitionOf, new Map())![0]!.carrier),
    representationKey(collection)
  )
})
