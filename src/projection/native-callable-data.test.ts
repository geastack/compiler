import assert from 'node:assert/strict'
import test from 'node:test'
import type { FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { CallableOwnDataSlotSchema, CallableOwnDataValue, CallableOwnDataWriter } from '../semantics/callable-own-data-slots.js'
import {
  nativeCallableDataCarrierHasStorageIdentity,
  nativeCallableDataStorageOf,
  nativeCallableDataValueRepresentationOf
} from '../representation/native-callable-data-storage.js'

const owner = 'owner' as FunctionId
const method = 'method' as FunctionId
const type = 'source' as StructuralTypeId
const physical: CallableAbi = {
  receiver: { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
  parameters: [{ value: { kind: 'string' }, ownership: 'owned', passing: 'by-value' }],
  result: { kind: 'string' },
  restFrom: null
}
const value = (callable: FunctionId | null = method): CallableOwnDataValue => ({
  operand: { type, source: { kind: 'constant', literal: 'undefined', text: 'undefined' } } as unknown as CallableOwnDataValue['operand'],
  producer: null,
  result: null,
  type,
  callable,
  shape: type
})
const writer = (source = value(), kind: 'set' | 'reflect-set' | 'define-own-property' = 'set'): CallableOwnDataWriter => ({
  mutation: { kind } as CallableOwnDataWriter['mutation'],
  value: source
})
const schema = (writers: readonly CallableOwnDataWriter[] = [writer()]): CallableOwnDataSlotSchema => ({
  functionId: owner,
  key: 'call',
  allocations: [{} as CallableOwnDataSlotSchema['allocations'][number]],
  writers,
  reads: [],
  dynamicObservations: [],
  blockers: []
})
const deriver = (
  representation: Representation = { kind: 'string' }
): Pick<RepresentationDeriver, 'deriveStored' | 'nativeCallableConventions'> => ({
  deriveStored: () => representation,
  nativeCallableConventions: (functionId) => (functionId === method ? { call: physical, construct: null } : null)
})

test('a native own data source uses the actual Function physical ABI rather than its asserted field type', () => {
  const actual = nativeCallableDataValueRepresentationOf(value(), deriver())
  assert.deepEqual(actual, { kind: 'function-value-dispatch', abi: physical })
  assert.deepEqual(nativeCallableDataStorageOf(schema(), deriver())?.storage, actual)
  assert.equal(nativeCallableDataValueRepresentationOf({ ...value(), type: null }, deriver()), null)
  assert.equal(nativeCallableDataValueRepresentationOf(value('unknown' as FunctionId), deriver()), null)
})

test('storage requires all actual writers to have an identical native carrier', () => {
  assert.ok(nativeCallableDataStorageOf(schema([writer(), writer(value(), 'reflect-set')]), deriver()))
  assert.equal(nativeCallableDataStorageOf(schema([writer(), writer(value(null))]), deriver()), null)
  assert.equal(nativeCallableDataStorageOf(schema([writer(value(), 'define-own-property')]), deriver()), null)
  assert.equal(nativeCallableDataStorageOf({ ...schema(), writers: [] }, deriver()), null)
  assert.equal(nativeCallableDataStorageOf({ ...schema(), allocations: [] }, deriver()), null)
})

test('differing noncallable writers publish a key-local held union without admitting opaque or dynamic sources', () => {
  const absent = 'null-source' as StructuralTypeId
  const present = 'array-source' as StructuralTypeId
  const array: Representation = {
    kind: 'array-object',
    element: { kind: 'scalar', domain: 'number' },
    ownership: 'shared-refcount',
    extension: null
  }
  const sources = [writer({ ...value(null), type: absent }), writer({ ...value(null), type: present })]
  const derive = { ...deriver(), deriveStored: (type: StructuralTypeId): Representation => (type === absent ? { kind: 'null' } : array) }
  const storage = nativeCallableDataStorageOf(schema(sources), derive)
  assert.ok(storage)
  assert.equal(storage.storage.kind, 'tagged-union')
  if (storage.storage.kind === 'tagged-union') {
    assert.deepEqual(storage.storage.arms.map((arm) => arm.value.kind).sort(), ['array-object', 'null'])
    assert.deepEqual(new Set(storage.storage.arms.map((arm) => arm.semanticType)), new Set([absent, present]))
  }
  assert.equal(
    nativeCallableDataStorageOf(schema(sources), {
      ...derive,
      deriveStored: (type): Representation =>
        type === absent ? { kind: 'null' } : { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
    }),
    null
  )
})

test('a storage schema never licenses externally mutable or opaque Function slots', () => {
  for (const kind of [
    'unknown-key',
    'delete',
    'opaque-definition',
    'opaque-source',
    'unknown-target',
    'prototype-mutation',
    'exposure'
  ] as const) {
    const blocked = { ...schema(), blockers: [{ kind, operation: {} as CallableOwnDataSlotSchema['blockers'][number]['operation'] }] }
    assert.equal(nativeCallableDataStorageOf(blocked, deriver()), null, kind)
  }
})

test('observed deletion retains the payload family without licensing installed callable presence', () => {
  const operation = {} as CallableOwnDataSlotSchema['blockers'][number]['operation']
  const deletion: CallableOwnDataWriter = {
    mutation: { kind: 'reflect-delete', operation } as CallableOwnDataWriter['mutation'],
    value: null
  }
  const source = {
    ...schema([writer(value(null)), deletion]),
    blockers: [{ kind: 'delete' as const, operation }]
  }
  const held = deriver({ kind: 'scalar', domain: 'number' })
  assert.equal(nativeCallableDataStorageOf(source, held), null)
  assert.deepEqual(nativeCallableDataStorageOf(source, held, 'observed-presence')?.storage, { kind: 'scalar', domain: 'number' })
  assert.equal(nativeCallableDataStorageOf(source, held, 'observed-presence')?.writers.length, 1)
  assert.equal(
    nativeCallableDataStorageOf(
      { ...source, blockers: [{ kind: 'delete', operation: {} as typeof operation }] },
      held,
      'observed-presence'
    ),
    null
  )
  assert.equal(nativeCallableDataStorageOf({ ...source, writers: [deletion] }, held, 'observed-presence'), null)
})

test('native descriptor storage preserves object identity rather than copying an owned object', () => {
  const record = { kind: 'record', ownership: 'owned', fields: [], shape: type } as unknown as Representation
  assert.equal(nativeCallableDataCarrierHasStorageIdentity(record), false)
  assert.equal(nativeCallableDataStorageOf(schema([writer(value(null))]), deriver(record)), null)
  assert.equal(nativeCallableDataCarrierHasStorageIdentity({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }), false)
  assert.equal(nativeCallableDataCarrierHasStorageIdentity({ kind: 'string' }), true)
})
