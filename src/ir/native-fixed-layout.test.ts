import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { Representation } from '../representation/model.js'
import { hasClosedFixedLayout } from './native-fixed-layout.js'

const scalar = (domain: 'number' | 'boolean'): Representation => ({ kind: 'scalar', domain })

const classRef = (declaration: string, shapeId: string): Representation => ({
  kind: 'class-ref',
  declaration: declaration as DeclarationId,
  shapeId,
  ownership: 'shared-refcount',
  ancestors: []
})

const deriverOf = (layouts: Readonly<Record<string, Representation>>): { layoutOf: (shape: StructuralTypeId) => Representation } => ({
  layoutOf: (shape) => {
    const layout = layouts[String(shape)]
    if (!layout) throw new Error(`no layout for ${String(shape)}`)
    return layout
  }
})

const noClasses: ReadonlyMap<DeclarationId, ClassLayout> = new Map()

// A class reached only through an inferred field type is never opened by
// census reachability, so no class-lifecycle operation is published for it and
// the projection has no row. `targets/cpp/records.ts` still emits its struct,
// rendered from the carrier's own shape and standalone, so those fields ARE
// the object's slots. Fourteen carriers in the three.js app were in this state.
test('a class-ref with no published layout answers from the shape its struct is rendered from', () => {
  const representation = classRef('decl|f1|1', 'shape|closed')
  const deriver = deriverOf({
    'shape|closed': {
      kind: 'record',
      shapeId: 'shape|closed',
      fields: [
        { key: 'extra', value: scalar('number'), required: true },
        { key: 'label', value: scalar('boolean'), required: true }
      ],
      accessors: [],
      ownership: 'shared-refcount'
    }
  })
  assert.equal(hasClosedFixedLayout(representation, deriver, noClasses), true)
})

// The branch above is not a blanket admission: an index signature gives the
// emitted struct a dynamic-property sidecar, so a fixed-field switch cannot
// answer every key and the generic protocol has to stay available.
test('a layout-less class-ref whose shape carries an index sidecar stays unproven', () => {
  const representation = classRef('decl|f1|2', 'shape|indexed')
  const deriver = deriverOf({
    'shape|indexed': {
      kind: 'record-with-index',
      shapeId: 'shape|indexed',
      fields: [{ key: 'extra', value: scalar('number'), required: true }],
      indexes: [{ key: 'string', value: scalar('number') }],
      ownership: 'shared-refcount'
    } as Representation
  })
  assert.equal(hasClosedFixedLayout(representation, deriver, noClasses), false)
})

// The same record test the `'record'` case already applies: an unresolved
// field has no storage the compiler chose, and a symbol key is not addressable
// by the field switch at all.
test('a layout-less class-ref whose shape has an unresolved or symbol member stays unproven', () => {
  const unresolved = classRef('decl|f1|3', 'shape|unresolved')
  const symbolic = classRef('decl|f1|4', 'shape|symbol')
  const deriver = deriverOf({
    'shape|unresolved': {
      kind: 'record',
      shapeId: 'shape|unresolved',
      fields: [{ key: 'extra', value: { kind: 'unresolved', reason: 'no-evidence' } as Representation, required: true }],
      accessors: [],
      ownership: 'shared-refcount'
    },
    'shape|symbol': {
      kind: 'record',
      shapeId: 'shape|symbol',
      fields: [{ key: 'sym(tag)', value: scalar('number'), required: true }],
      accessors: [],
      ownership: 'shared-refcount'
    }
  })
  assert.equal(hasClosedFixedLayout(unresolved, deriver, noClasses), false)
  assert.equal(hasClosedFixedLayout(symbolic, deriver, noClasses), false)
})

// Without a deriver there is no shape to read, so the answer stays closed-off
// rather than guessed -- the same fail-closed the `native-record-ref` case has.
test('a layout-less class-ref with no deriver stays unproven', () => {
  assert.equal(hasClosedFixedLayout(classRef('decl|f1|5', 'shape|closed'), null, noClasses), false)
})

// A plain array's own reflective surface beyond its native index/length
// transport is empty (`extension === null`), so there is nothing left
// unfixed to check.
test('a plain array-object (no extension) proves closed', () => {
  const representation: Representation = { kind: 'array-object', element: scalar('number'), ownership: 'shared-refcount', extension: null }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), true)
})

// An extension field is checked exactly like a record field: an unresolved
// carrier is a failed derivation, not a legitimate payload, and stays unproven.
test('an array-object whose extension has an unresolved field stays unproven', () => {
  const representation: Representation = {
    kind: 'array-object',
    element: scalar('number'),
    ownership: 'shared-refcount',
    extension: [{ key: 'pos', value: { kind: 'unresolved', reason: 'no-evidence' }, required: true }]
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), false)
})

// A recursive array's `representationKey` collapses to
// `recursive(type,container,ownership)`, discarding `extension`/`element`
// entirely, so this case must refuse rather than certify from a key that
// cannot actually distinguish one recursive array's fields from another's.
test('a recursive array-object stays unproven even with a closed extension', () => {
  const representation: Representation = {
    kind: 'array-object',
    element: scalar('number'),
    ownership: 'shared-refcount',
    extension: null,
    recursive: { type: 'shape|self-array' as StructuralTypeId, container: 'array-object', role: 'definition' }
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), false)
})

// A bare dictionary names no member at all -- it IS its index -- so a
// resolved value carrier is the whole proof, the degenerate case of
// `record-with-index` with an empty field list.
test('a dictionary with a resolved value carrier proves closed', () => {
  const representation: Representation = { kind: 'dictionary', key: 'string', value: scalar('number'), ownership: 'shared-refcount' }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), true)
})

// An unresolved value is a failed derivation, not `any`/`unknown` held
// legitimately dynamic, so the dictionary stays unproven.
test('a dictionary with an unresolved value carrier stays unproven', () => {
  const representation: Representation = {
    kind: 'dictionary',
    key: 'string',
    value: { kind: 'unresolved', reason: 'no-evidence' },
    ownership: 'shared-refcount'
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), false)
})

// A `Map`/`Set`/`WeakMap`/`WeakSet` has zero enumerable own data properties
// -- `get`/`set`/`has`/`delete` are prototype method calls, not property
// reads -- so a resolved key (and value, for the two map families) is the
// whole proof.
test('a keyed-collection with resolved key and value carriers proves closed', () => {
  const representation: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: scalar('number'),
    value: scalar('boolean'),
    ownership: 'shared-refcount'
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), true)
})

// A Set has no value slot at all (`value: null`); that must not be confused
// with an unresolved payload, so it still proves closed.
test('a keyed-collection set family with no value slot proves closed', () => {
  const representation: Representation = {
    kind: 'keyed-collection',
    family: 'set',
    key: scalar('number'),
    value: null,
    ownership: 'shared-refcount'
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), true)
})

// The same key-collapsing hazard `array-object` has: a recursive keyed
// collection's key discards its key/value carriers, so it must refuse rather
// than certify from an identity that cannot see them.
test('a recursive keyed-collection stays unproven', () => {
  const representation: Representation = {
    kind: 'keyed-collection',
    family: 'map',
    key: scalar('number'),
    value: scalar('boolean'),
    ownership: 'shared-refcount',
    recursive: { type: 'shape|self-map' as StructuralTypeId, container: 'keyed-collection', role: 'definition' }
  }
  assert.equal(hasClosedFixedLayout(representation, null, noClasses), false)
})
