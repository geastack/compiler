import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../../conversion/algebra.js'
import type { RecordViewPlan } from '../../conversion/record-view.js'
import { nativeViewTargetsOf } from './native-view-targets.js'

const fields = (shapeId: string, sharedSource = true): Extract<RecordViewPlan, { kind: 'fields' }> => ({
  kind: 'fields',
  source: { kind: 'record', shapeId: 'source', fields: [], accessors: [], ownership: sharedSource ? 'shared-refcount' : 'owned' },
  target: { kind: 'record', shapeId, fields: [], accessors: [], ownership: 'shared-refcount' },
  fields: [],
  indexes: [],
  expando: false
})

const node = (view: RecordViewPlan): ConversionNode => ({
  id: 'test:sealed-view',
  source: { kind: 'undefined' },
  target: { kind: 'undefined' },
  capability: {
    kind: 'static',
    materializer: {
      id: 'view:structural-record',
      domain: 'test',
      allocates: true,
      recordView: { source: { kind: 'undefined' }, target: { kind: 'undefined' }, view, leaves: new Map(), methods: [] }
    }
  }
})

test('certified nested views retain hidden origin edges while value copies stay leaves', () => {
  const nested = fields('nested')
  const copied = fields('copied', false)
  const outer = fields('outer')
  const withNested: RecordViewPlan = {
    ...outer,
    fields: [
      {
        field: { key: 'child', required: true, value: nested.target },
        read: { kind: 'view', held: { key: 'child', required: true, value: nested.source }, plan: nested }
      },
      {
        field: { key: 'copy', required: true, value: copied.target },
        read: { kind: 'view', held: { key: 'copy', required: true, value: copied.source }, plan: copied }
      }
    ]
  }
  assert.deepEqual(nativeViewTargetsOf([node({ kind: 'assert', target: outer.target, payload: withNested }), node(nested)]), [
    'outer',
    'nested'
  ])
})

test('owned targets and external native structs acquire no generated origin trait', () => {
  const shared = fields('owned')
  const owned: RecordViewPlan = { ...shared, target: { ...shared.target, ownership: 'owned' } }
  const external: RecordViewPlan = {
    ...fields('external'),
    target: { kind: 'native-record-ref', shapeId: 'external', ownership: 'shared-refcount', native: 'HostRecord' }
  }
  assert.deepEqual(nativeViewTargetsOf([node(owned), node(external)]), [])
})

test('family-member nodes and deferred conversion dependencies use the same native view closure', () => {
  const member = node(fields('family-member'))
  assert.ok(member.capability.kind === 'static')
  const familyMember: ConversionNode = {
    ...member,
    id: 'test:family-members',
    familyMembers: new Map([['family-member', new Set(['method'])]]),
    capability: {
      ...member.capability,
      materializer: { ...member.capability.materializer, id: 'view:family-member-record' }
    }
  }
  const parameter = node(fields('callable-parameter'))
  const payload = node(fields('promise-payload'))
  const dependencies = [familyMember, parameter, payload]
  const deferred: ConversionNode = {
    ...member,
    id: 'test:deferred-adapter',
    capability: { kind: 'static', materializer: { id: 'view:adapted-callable', domain: 'test', allocates: true, dependencies } }
  }
  dependencies.push(deferred)
  assert.deepEqual(nativeViewTargetsOf([deferred]), ['family-member', 'callable-parameter', 'promise-payload'])
})

test('a nested algebra capability retains its sealed view target without a separate conversion node', () => {
  const view = node(fields('nested-capability'))
  const composite: ConversionNode = {
    ...view,
    id: 'test:composite',
    capability: {
      kind: 'product',
      materializer: { id: 'test:product', domain: 'test', allocates: true },
      fields: [{ key: 'child', required: true, capability: { kind: 'optional', absenceTag: 'Undefined', payload: view.capability } }]
    }
  }
  assert.deepEqual(nativeViewTargetsOf([composite]), ['nested-capability'])
})
