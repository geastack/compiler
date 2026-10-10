import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import { recordViewResidualReflection, recordViewUsesOnlyDirectFields, type RecordViewPlan } from './record-view.js'
import type { Representation } from '../representation/model.js'
import { nativeFieldViewIdentityTransportOf, nativeFieldViewPlanOf, nativeFieldViewPlansOf } from './native-field-view.js'
import type { ConversionNode } from './algebra.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey } from '../representation/model.js'
import { structuralConversionKey } from './structural-plan.js'

const text: Representation = { kind: 'string' }
const numeric: Representation = { kind: 'scalar', domain: 'number' }
const source: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'original',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'shown', value: text, required: true }]
}
const target: Extract<Representation, { kind: 'record' }> = { ...source, shapeId: 'public' }
const data: Extract<RecordViewPlan, { kind: 'fields' }> = {
  kind: 'fields',
  source,
  target,
  indexes: [],
  expando: false,
  fields: [{ field: target.fields[0]!, read: { kind: 'held', held: source.fields[0]! } }]
}

test('a shared data view records original field carriers and an owned copy has no alias route', () => {
  assert.deepEqual(nativeFieldViewPlanOf(data, { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null })?.fields, [
    { key: 'shown', read: text, write: text }
  ])
  assert.equal(
    nativeFieldViewPlanOf(
      { ...data, source: { ...source, ownership: 'owned' } },
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
    ),
    null
  )
})

test('accessor routes keep independent native getter and setter carriers without evaluating their bodies', () => {
  const declaration = 'accessor-origin' as DeclarationId
  const receiver: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration,
    shapeId: 'accessor-origin',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const plan: Extract<RecordViewPlan, { kind: 'fields' }> = {
    ...data,
    source: receiver,
    fields: [{ field: target.fields[0]!, read: { kind: 'class-accessor', value: text } }]
  }
  let queries = 0
  const routed = nativeFieldViewPlanOf(plan, {
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: () => null,
    classAccessorSetterFor: (owner, key) => {
      assert.equal(owner, declaration)
      assert.equal(key, 'shown')
      queries++
      return numeric
    }
  })
  assert.equal(queries, 1)
  assert.deepEqual(routed?.fields, [{ key: 'shown', read: text, write: numeric }])
  assert.equal(
    nativeFieldViewPlanOf(plan, { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }),
    null,
    'no setter authority is not a read-only accessor'
  )
})

test('native descriptor forwarding publishes no invented sidecar storage or symbol route', () => {
  const symbol = { ...data, fields: [{ ...data.fields[0]!, field: { ...data.fields[0]!.field, key: 'sym(member)' } }] }
  assert.equal(nativeFieldViewPlanOf(symbol, { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }), null)
  assert.equal(
    nativeFieldViewPlanOf(
      { ...data, fields: [{ field: target.fields[0]!, read: { kind: 'sidecar' } }] },
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
    ),
    null,
    'a declared field cannot manufacture an any slot on its source allocation'
  )
  assert.deepEqual(
    nativeFieldViewPlanOf(
      { ...data, fields: [{ field: target.fields[0]!, read: { kind: 'native-descriptor' } }] },
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
    )?.fields,
    [{ key: 'shown', read: text, write: null, descriptorForward: true }]
  )
  assert.equal(
    nativeFieldViewPlanOf(
      { ...data, fields: [{ field: { ...target.fields[0]!, value: source }, read: { kind: 'sidecar' } }] },
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
    ),
    null,
    'a typed object key requires native extension storage rather than a Value slot'
  )
})

test('a primitive sidecar result cannot erase its dynamic accessor receiver exposure', () => {
  const plan: Extract<RecordViewPlan, { kind: 'fields' }> = {
    ...data,
    fields: [{ field: target.fields[0]!, read: { kind: 'sidecar' } }]
  }
  assert.equal(recordViewUsesOnlyDirectFields(plan), false)
  assert.deepEqual(recordViewResidualReflection(plan), [source, text])
})

test('a layout proof alone does not claim live alias transport before its runtime contract is installed', () => {
  const fields = nativeFieldViewPlanOf(data, { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null })!
  const node: ConversionNode = {
    id: 'view',
    source,
    target,
    capability: {
      kind: 'static',
      materializer: {
        id: 'view',
        domain: 'view',
        allocates: true,
        recordView: { source, target, view: data, leaves: new Map(), methods: [], fieldViews: new Map([[data, fields]]) }
      }
    }
  }
  assert.equal(nativeFieldViewIdentityTransportOf(node), false)
  assert.equal(
    nativeFieldViewIdentityTransportOf({
      ...node,
      capability: {
        kind: 'static',
        materializer: {
          ...(node.capability.kind === 'static' ? node.capability.materializer : {}),
          id: 'view',
          domain: 'view',
          allocates: true,
          nativeFieldViewProtocol: 'live'
        }
      }
    }),
    true
  )
})

test('a complete union dispatch retains live identity through its exact delegated leaf', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const child = census.nodeFor(source, target)
  assert.equal(nativeFieldViewIdentityTransportOf(child), true)
  const sum: Extract<Representation, { kind: 'tagged-union' }> = {
    kind: 'tagged-union',
    arms: [source, target].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const view: RecordViewPlan = { kind: 'dispatch', source: sum, target, arms: [{ via: 'convert' }, { via: 'exact' }] }
  const dispatch: ConversionNode = {
    id: structuralConversionKey(sum, target),
    source: sum,
    target,
    capability: {
      kind: 'static',
      materializer: {
        id: 'view:structural-record',
        domain: 'view:structural-record',
        allocates: true,
        nativeFieldViewProtocol: 'live',
        recordView: {
          source: sum,
          target,
          view,
          leaves: new Map([[structuralConversionKey(source, target), child]]),
          methods: [],
          fieldViews: new Map()
        }
      }
    }
  }
  assert.equal(nativeFieldViewIdentityTransportOf(dispatch), true)
  assert.equal(nativeFieldViewPlansOf([dispatch]).length, 0, 'delegation installs no new callback layout')
  assert.deepEqual(nativeFieldViewPlansOf([dispatch, child]), nativeFieldViewPlansOf([child]))
  assert.ok(dispatch.capability.kind === 'static')
  const materializer = dispatch.capability.materializer
  const certified = materializer.recordView!
  const withLeaf = (leaf: ConversionNode): ConversionNode => ({
    ...dispatch,
    capability: {
      kind: 'static',
      materializer: {
        ...materializer,
        recordView: { ...certified, leaves: new Map([[structuralConversionKey(source, target), leaf]]) }
      }
    }
  })
  assert.equal(nativeFieldViewIdentityTransportOf(withLeaf({ ...child, source: text })), false, 'a different pair is no child proof')
  const copy: ConversionNode = {
    ...child,
    capability: { kind: 'static', materializer: { id: 'copy', domain: 'copy', allocates: true, nativeFieldProtocol: 'unused' } }
  }
  assert.equal(nativeFieldViewIdentityTransportOf(withLeaf(copy)), false, 'one copying branch prevents a live identity claim')
})

test('a stored explicit-this Function read cites its contextual frame instead of minting an ordinary receiver cast', () => {
  const fn: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, parameters: [], restFrom: null, result: text }
  }
  const member: typeof fn = { ...fn, abi: { ...fn.abi, receiver: null } }
  const cursor = { ...source, fields: [{ key: 'next', value: fn, required: true }] }
  const publicCursor = { ...target, fields: [{ key: 'next', value: member, required: true }] }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const contextual = conversions.nativeMethodFor(fn, member)
  assert.ok(contextual)
  const node = conversions.nodeFor(cursor, publicCursor)
  assert.notEqual(node.capability.kind, 'never')
  assert.ok('materializer' in node.capability)
  const plan = node.capability.materializer.recordView
  assert.ok(plan)
  assert.ok([...plan.leaves.values()].some((leaf) => leaf === contextual))
  assert.equal(plan.fieldViews?.get(plan.view)?.fields[0]?.read, fn)
  assert.equal(representationKey(contextual.source), representationKey(fn))
})

test('an accessor-returned method uses the actual getter result frame and remains a lazy live route', () => {
  const getter = 'next-getter' as FunctionId
  const physical: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, parameters: [], restFrom: null, result: text }
  }
  const publicMethod: typeof physical = { ...physical, abi: { ...physical.abi, receiver: null } }
  const cursor = { ...source, fields: [], accessors: [{ key: 'next', getter, setter: null, value: publicMethod }] }
  const publicCursor = { ...target, fields: [{ key: 'next', value: publicMethod, required: true }] }
  const conversions = createConversionNodes({
    registry: createCppConversionRegistry({
      indexesForShape: () => [],
      accessorsForShape: () => [],
      forShape: () => null,
      accessorAbiFor: (id) => (id === getter ? { receiver: cursor, parameters: [], restFrom: null, result: physical } : null)
    }),
    nodes: new Map()
  })
  const node = conversions.nodeFor(cursor, publicCursor)
  assert.ok('materializer' in node.capability)
  const view = node.capability.materializer.recordView
  assert.ok(view)
  assert.ok(view.view.kind === 'fields')
  assert.equal(view.view.fields[0]?.read.kind, 'record-accessor')
  assert.equal(view.fieldViews?.get(view.view)?.fields[0]?.read, physical)
  assert.equal(view.fieldViews?.get(view.view)?.fields[0]?.write, null)
  const method = conversions.nativeMethodFor(physical, publicMethod)
  assert.ok(method)
  assert.ok([...view.leaves.values()].includes(method))
  assert.equal(nativeFieldViewIdentityTransportOf(node), true)
})
