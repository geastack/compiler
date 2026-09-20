import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createConversionNodes } from './nodes.js'
import { nativeClassReferenceIdentityOf, nativeClassReferenceTransportMatches } from './native-class-reference.js'

const base: Extract<Representation, { kind: 'class-ref' }> = {
  kind: 'class-ref',
  declaration: 'base' as never,
  shapeId: 'base-shape',
  ownership: 'shared-refcount',
  ancestors: []
}
const child: Representation = { ...base, declaration: 'child' as never, shapeId: 'child-shape', ancestors: [base.declaration] }
const optional: Representation = { kind: 'optional', payload: base, absence: 'undefined' }
const union: Representation = {
  kind: 'tagged-union',
  arms: [base, { kind: 'undefined' } as Representation].map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `arm-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
}

test('installed native wraps, selections and class casts publish reference identity', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const [source, target] of [
    [base, optional],
    [optional, base],
    [base, union],
    [union, base],
    [child, base],
    [base, child],
    [{ kind: 'undefined' }, optional],
    [{ kind: 'null' }, base]
  ] as const) {
    const node = conversions.nodeFor(source, target)
    assert.ok(nativeClassReferenceTransportMatches(source, target, node), `${source.kind} -> ${target.kind}`)
  }
})

test('native transport needs matching citations and explicit identity, not merely no boxing', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(base, optional)
  assert.equal(nativeClassReferenceTransportMatches(base, optional, null), false)
  assert.equal(nativeClassReferenceTransportMatches(child, optional, node), false)
  assert.equal(nativeClassReferenceTransportMatches(base, union, node), false)
  assert.ok(node.capability.kind === 'atom')
  const { nativeClassReferenceIdentity: _identity, ...unproved } = node.capability.materializer
  assert.equal(
    nativeClassReferenceTransportMatches(base, optional, {
      ...node,
      capability: { ...node.capability, materializer: unproved }
    }),
    false
  )
  assert.equal(
    nativeClassReferenceTransportMatches(base, optional, {
      ...node,
      capability: { ...node.capability, materializer: { ...node.capability.materializer, allocates: true } }
    }),
    false
  )
})

test('structural views, containers, dynamic carriers and value-class copies are not reference envelopes', () => {
  const excluded: Representation[] = [
    { kind: 'record', shapeId: 'view', ownership: 'shared-refcount', fields: [], accessors: [] },
    { kind: 'array-object', element: base, ownership: 'shared-refcount', extension: null },
    { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    { ...base, ownership: 'owned' }
  ]
  for (const value of excluded) {
    assert.deepEqual(nativeClassReferenceIdentityOf(base, value), {})
    assert.deepEqual(nativeClassReferenceIdentityOf(value, base), {})
  }
})
