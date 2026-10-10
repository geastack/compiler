import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { compile } from '../compiler.js'
import { resolve } from 'node:path'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { GetOperation, IrOperation } from './model.js'
import {
  nativeConstructorGetInputsOf,
  nativeConstructorMethodBodiesOf,
  nativeConstructorPropertyClassesOf
} from './native-constructor-reads.js'

const declaration = 'native-constructor' as DeclarationId
const method = 'static-method' as FunctionId
const getter = 'static-getter' as FunctionId
const instance: Representation = { kind: 'class-ref', declaration, shapeId: 'instance', ownership: 'shared-refcount', ancestors: [] }
const construct: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: instance }
const family: Representation = { kind: 'constructor-family', members: [declaration], abi: construct }
const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const methodAbi: CallableAbi = { receiver: family, parameters: [], restFrom: null, result: instance }
const getterAbi: CallableAbi = { receiver: null, parameters: [], restFrom: null, result: { kind: 'string' } }
const classes = new Map<DeclarationId, ClassLayout>([
  [
    declaration,
    {
      declaration,
      base: null,
      nativeBase: null,
      instance,
      construct,
      fields: [],
      accessors: [],
      methods: [],
      staticFields: [
        {
          declaration: 'static-field' as DeclarationId,
          key: 'count',
          initializer: null,
          representation: number,
          syntheticSubclassMemberOverlay: false
        }
      ],
      staticMethods: [{ key: 'make', callable: method }],
      staticAccessors: [{ key: 'label', getter, setter: null }],
      name: 'Native',
      length: 0
    } as unknown as ClassLayout
  ]
])
const abis = new Map<FunctionId, CallableAbi>([
  [method, methodAbi],
  [getter, getterAbi]
])
const read = (receiver: Representation, result: Representation): GetOperation => ({
  kind: 'get',
  lineage: 'constructor-read' as never,
  receiver: { value: 'constructor' as never, representation: receiver },
  key: { value: 'key' as never, representation: { kind: 'string' } },
  result: { id: 'read' as never, representation: result }
})
const pairs = (operation: GetOperation, key: string | null) =>
  nativeConstructorGetInputsOf(operation, key, classes, abis).map((input) => [
    input.role,
    representationKey(input.source),
    representationKey(input.target)
  ])

test('computed constructor reads publish each actual static storage, getter result and method frame', () => {
  const inputs = pairs(read(family, dynamic), null)
  assert.ok(inputs.some(([role, source]) => role === 'field-read' && source === representationKey(number)))
  assert.ok(inputs.some(([role, source]) => role === 'field-read' && source === 'string'))
  assert.ok(
    inputs.some(
      ([role, source]) => role === 'method-frame' && source === representationKey({ kind: 'function-value-dispatch', abi: methodAbi })
    )
  )
  assert.deepEqual(pairs({ ...read(family, dynamic), provenKeyTexts: ['count'] }, null), [
    ['field-read', representationKey(number), representationKey(dynamic)]
  ])
})

test('construct ABI properties and prototypes project directly into their typed result', () => {
  const carried: Representation = { kind: 'constructor-value-dispatch', abi: { ...construct, result: dynamic } }
  const optionalString: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
  assert.deepEqual(pairs(read(carried, optionalString), 'label'), [['field-read', 'string', representationKey(optionalString)]])
  assert.deepEqual(pairs(read(carried, optionalString), 'missing'), [['field-read', 'undefined', representationKey(optionalString)]])
  const prototype: Representation = { kind: 'record', shapeId: 'prototype-view', ownership: 'shared-refcount', fields: [], accessors: [] }
  assert.deepEqual(pairs(read(carried, prototype), 'prototype'), [
    ['field-read', representationKey(instance), representationKey(prototype)]
  ])
  assert.equal(nativeConstructorPropertyClassesOf(carried, classes, 'label', optionalString)?.length, 1)
})

test('a static method publishes source identity only while its constructor has no replacement or external observer', () => {
  const abi = { ...methodAbi, receiver: null }
  const operation = read(family, { kind: 'function-value-dispatch', abi })
  const key = {
    kind: 'constant',
    lineage: null,
    literal: 'string',
    text: 'make',
    result: { id: 'key', representation: { kind: 'string' } }
  } as unknown as IrOperation
  assert.deepEqual(nativeConstructorMethodBodiesOf(operation, 'make', classes, [key, operation]), [method])
  const replacement = { kind: 'set', receiver: operation.receiver, key: operation.key, value: operation.receiver } as unknown as IrOperation
  assert.equal(nativeConstructorMethodBodiesOf(operation, 'make', classes, [key, replacement, operation]), null)
  const external = { kind: 'call', arguments: [operation.receiver] } as unknown as IrOperation
  assert.equal(nativeConstructorMethodBodiesOf(operation, 'make', classes, [key, external, operation]), null)
  const carried: Representation = { kind: 'constructor-value-dispatch', abi: construct }
  assert.equal(nativeConstructorMethodBodiesOf(read(carried, operation.result.representation), 'make', classes, [key]), null)
})

test('a finite computed static read requires every key to name a stable method body', () => {
  const operation = { ...read(family, dynamic), provenKeyTexts: ['make'] }
  assert.deepEqual(nativeConstructorMethodBodiesOf(operation, null, classes, []), [method])
  assert.equal(nativeConstructorMethodBodiesOf({ ...operation, provenKeyTexts: ['make', 'count'] }, null, classes, []), null)
  assert.equal(nativeConstructorMethodBodiesOf({ ...operation, provenKeyTexts: [] }, null, classes, []), null)
})

test('computed String keys preserve the selected static body receiver contract', () => {
  for (const file of ['class-static-computed-key.runtime.js', 'cpn-numeric-computed-keys.runtime.js']) {
    const entry = resolve('test/runtime', file)
    const result = compile({ rootFileNames: [entry], projectFileName: resolve('test/runtime/tsconfig.json'), closedScriptScope: true })
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.notEqual(result.certificate, null, `${file}: ${JSON.stringify(result.refusals)}`)
    assert.notEqual(result.source, null, `${file}: ${JSON.stringify(result.emissionRefusals)}`)
  }
})
