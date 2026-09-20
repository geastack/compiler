import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { Representation } from '../representation/model.js'
import type { MergeLiveArmRebuildOperation } from './model.js'
import { nativeMergePayloadTransportMatches, nativeMergeTransportMatches, nativeMergeTransportOf } from './native-merge-transport.js'

const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const point: Representation = {
  kind: 'class-ref',
  declaration: 'point' as never,
  shapeId: 'point-shape',
  ancestors: [],
  ownership: 'shared-refcount'
}
const source = sum({ kind: 'undefined' }, { kind: 'null' }, point)
const target = sum({ kind: 'undefined' }, { kind: 'null' }, boolean)

test('a native rebuild cites only its live arms, retaining distinct null and undefined transfers', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const nativeTransport = nativeMergeTransportOf(source, target, [0, 1], false, conversions)
  assert.ok(nativeTransport)
  const operation: MergeLiveArmRebuildOperation = {
    kind: 'merge-live-arm-rebuild',
    lineage: 'lineage' as never,
    source: { value: 'source' as never, representation: source },
    result: { id: 'result' as never, representation: target },
    liveArms: [0, 1],
    sourceAbsenceLive: false,
    nativeTransport
  }
  assert.equal(nativeMergeTransportMatches(operation, conversions), true)
  assert.equal(nativeMergePayloadTransportMatches(operation, conversions), true)
  assert.equal(nativeMergeTransportMatches({ ...operation, liveArms: [0, 2] }, conversions), false)
  const wrong = conversions.nodeFor(boolean, boolean)
  assert.equal(
    nativeMergeTransportMatches(
      { ...operation, nativeTransport: { ...nativeTransport, arms: [{ index: 0, conversion: wrong.id }, nativeTransport.arms[1]!] } },
      conversions
    ),
    false
  )
  assert.equal(nativeMergeTransportMatches(operation, { nodeById: () => null }), false)
})

test('optional absence is a separate conversion and dynamic alternatives cannot claim native transport', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: sum({ kind: 'null' }, point) }
  const nativeTransport = nativeMergeTransportOf(optional, target, [0], true, conversions)
  assert.ok(nativeTransport?.absence)
  const operation: MergeLiveArmRebuildOperation = {
    kind: 'merge-live-arm-rebuild',
    lineage: 'lineage' as never,
    source: { value: 'optional-source' as never, representation: optional },
    result: { id: 'optional-result' as never, representation: target },
    liveArms: [0],
    sourceAbsenceLive: true,
    nativeTransport
  }
  assert.equal(nativeMergePayloadTransportMatches(operation, conversions), true)
  assert.equal(nativeMergePayloadTransportMatches({ ...operation, sourceAbsenceLive: false }, conversions), false)
  assert.equal(conversions.nodeById(nativeTransport.absence)?.source.kind, 'undefined')
  assert.equal(nativeMergeTransportOf(source, target, [2], false, conversions), undefined)
  assert.equal(
    nativeMergeTransportOf(sum({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }), target, [0], false, conversions),
    undefined
  )
})

test('a merge into a bare class handle keeps the handle and stores null as the empty handle', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const nullable = sum({ kind: 'undefined' }, { kind: 'null' }, point)
  const nativeTransport = nativeMergeTransportOf(nullable, point, [1, 2], false, conversions)
  assert.ok(nativeTransport)
  assert.equal(conversions.nodeById(nativeTransport.arms[1]!.conversion)?.capability.kind, 'identity')
  const operation: MergeLiveArmRebuildOperation = {
    kind: 'merge-live-arm-rebuild',
    lineage: 'lineage' as never,
    source: { value: 'nullable-source' as never, representation: nullable },
    result: { id: 'nullable-result' as never, representation: point },
    liveArms: [1, 2],
    sourceAbsenceLive: false,
    nativeTransport
  }
  assert.equal(nativeMergeTransportMatches(operation, conversions), true)
  assert.equal(nativeMergePayloadTransportMatches(operation, conversions), true)
  const child: Representation = { ...point, declaration: 'child' as never, shapeId: 'child-shape', ancestors: ['point' as never] }
  assert.ok(nativeMergeTransportOf(sum({ kind: 'null' }, child), point, [0, 1], false, conversions), 'a nominal upcast is total')
  assert.equal(nativeMergeTransportOf(nullable, point, [0, 1, 2], false, conversions), undefined, 'undefined has no home in the handle')
  assert.equal(nativeMergeTransportOf(sum({ kind: 'null' }, point), child, [0, 1], false, conversions), undefined, 'no downcast')
  const optional: Representation = { kind: 'optional', absence: 'null', payload: sum(point, child) }
  assert.ok(nativeMergeTransportOf(optional, point, [0, 1], true, conversions)?.absence, 'the null absence is the empty handle')
  const undefinedOptional: Representation = { kind: 'optional', absence: 'undefined', payload: sum(point, child) }
  assert.equal(nativeMergeTransportOf(undefinedOptional, point, [0, 1], true, conversions), undefined)
})
