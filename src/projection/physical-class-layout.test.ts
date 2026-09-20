import assert from 'node:assert/strict'
import test from 'node:test'
import { physicalClassInstanceResolverOf, physicalClassLayoutsOf, type ClassLayout } from './classes.js'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'

const classRef = (
  declaration: string,
  shapeId: string,
  ancestors: readonly string[] = []
): Extract<Representation, { readonly kind: 'class-ref' }> => ({
  kind: 'class-ref',
  declaration: declaration as DeclarationId,
  shapeId,
  ownership: 'shared-refcount',
  ancestors: ancestors as DeclarationId[]
})

const projectedBase = (instance: Representation): ClassLayout => ({
  declaration: 'base' as DeclarationId,
  base: null,
  nativeBase: null,
  construct: null,
  instance,
  constructor: null,
  fields: [],
  fieldOwnership: [],
  methods: [],
  accessors: [],
  staticFields: [],
  staticMethods: [],
  staticAccessors: [],
  name: null,
  length: null
})

test('publishes authenticated base storage for a type-only derived class reference', () => {
  const base = classRef('base', 'base-shape')
  const derived = classRef('derived', 'derived-shape', ['base'])
  const publication = physicalClassLayoutsOf(
    new Map([['base' as DeclarationId, projectedBase(base)]]) as ReadonlyMap<DeclarationId, ClassLayout>,
    [derived]
  )
  const layout = publication.layouts.get('derived' as DeclarationId)
  assert.equal(publication.complete, true)
  assert.deepEqual(publication.missingBases, [])
  assert.equal(layout?.base, 'base')
  assert.equal(layout?.instance, derived)
  // The physical publication cannot be mistaken for a class lifecycle layout.
  assert.equal(Object.hasOwn(layout ?? {}, 'constructor'), false)
  assert.equal(Object.hasOwn(layout ?? {}, 'methods'), false)
})

test('fails closed when a type-only class reference lacks its authenticated base layout', () => {
  const derived = classRef('derived', 'derived-shape', ['missing-base'])
  const publication = physicalClassLayoutsOf(new Map(), [derived])
  assert.equal(publication.complete, false)
  assert.deepEqual(publication.missingBases, ['missing-base'])
  assert.equal(publication.layouts.get('derived' as DeclarationId)?.base, 'missing-base')
})

test('resolves a missing ancestor through the sealed class-ref authority', () => {
  const base = classRef('base', 'base-shape')
  const derived = classRef('derived', 'derived-shape', ['base'])
  const publication = physicalClassLayoutsOf(new Map(), [derived], (declaration) => (declaration === 'base' ? base : null))
  assert.equal(publication.complete, true)
  assert.deepEqual(publication.missingBases, [])
  assert.equal(publication.layouts.get('base' as DeclarationId)?.instance, base)
  assert.equal(publication.layouts.get('derived' as DeclarationId)?.base, 'base')
})

test('builds a unique type-only class-ref resolver from structural anchors', () => {
  const base = classRef('base', 'base-shape')
  const deriver = {
    derive: (type: StructuralTypeId) => (type === ('base-type' as never) ? base : ({ kind: 'unresolved', reason: String(type) } as const))
  } as never
  const resolver = physicalClassInstanceResolverOf(
    new Map(),
    new Map([
      [
        'base-type' as StructuralTypeId,
        {
          id: 'base-type' as StructuralTypeId,
          shape: { kind: 'class-instance', declaration: 'base' as DeclarationId, typeArguments: [], body: 'base-shape' as StructuralTypeId }
        }
      ]
    ]),
    deriver
  )
  assert.equal(resolver('base' as DeclarationId), base)
})

test('discovers type-only class references nested in an optional carrier', () => {
  const base = classRef('base', 'base-shape')
  const derived = classRef('derived', 'derived-shape', ['base'])
  const optional: Representation = { kind: 'optional', payload: derived, absence: 'undefined' }
  const publication = physicalClassLayoutsOf(
    new Map([['base' as DeclarationId, projectedBase(base)]]) as ReadonlyMap<DeclarationId, ClassLayout>,
    [optional]
  )
  assert.equal(publication.layouts.get('derived' as DeclarationId)?.instance, derived)
  assert.equal(publication.complete, true)
})

test('two instantiations of one type-only class are one physical carrier, and unused anchors are not derived', () => {
  // A class is nominal: `representationKey` spells a `class-ref` from its
  // declaration and ownership alone, so two structural anchors of one generic
  // class name the same struct and resolve rather than conflict.
  const declaration = 'generic-base' as DeclarationId
  const ids = ['first', 'second'].map((id) => id as StructuralTypeId)
  const derived: StructuralTypeId[] = []
  const resolver = physicalClassInstanceResolverOf(
    new Map(),
    new Map(ids.map((id) => [id, { id, shape: { kind: 'class-instance' as const, declaration, typeArguments: [], body: id } }])),
    {
      derive: (id: StructuralTypeId) => {
        derived.push(id)
        return classRef(declaration, id)
      }
    } as never
  )
  assert.deepEqual(derived, [])
  const resolved = resolver(declaration)
  assert.equal(resolved?.kind, 'class-ref')
  assert.equal(resolved?.declaration, declaration)
  assert.deepEqual(derived, ids)
  assert.equal(resolver(declaration), resolved)
  assert.deepEqual(derived, ids)
})

test('anchors deriving physically different carriers of one class refuse resolution', () => {
  const declaration = 'generic-base' as DeclarationId
  const ids = ['shared', 'owned'].map((id) => id as StructuralTypeId)
  const resolver = physicalClassInstanceResolverOf(
    new Map(),
    new Map(ids.map((id) => [id, { id, shape: { kind: 'class-instance' as const, declaration, typeArguments: [], body: id } }])),
    {
      derive: (id: StructuralTypeId) => ({ ...classRef(declaration, id), ownership: id === 'owned' ? 'owned' : 'shared-refcount' })
    } as never
  )
  assert.equal(resolver(declaration), null)
  assert.equal(resolver(declaration), null)
})
