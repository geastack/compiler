import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import type { NativeFieldViewPlan } from '../conversion/native-field-view.js'
import type { RecordViewPlan } from '../conversion/record-view.js'
import type { Representation } from '../representation/model.js'
import type { ClassLayout } from '../projection/classes.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import { nativeFieldViewDomainsOf } from './native-field-view-domains.js'

const text: Representation = { kind: 'string' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const record = (shapeId: string, value: Representation): Extract<Representation, { kind: 'record' }> => ({
  kind: 'record',
  shapeId,
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'shown', value, required: true }]
})
const route = (
  source: ReturnType<typeof record>,
  target: ReturnType<typeof record>,
  read: Representation,
  write: Representation | null = read
): ConversionNode => {
  const view: Extract<RecordViewPlan, { kind: 'fields' }> = {
    kind: 'fields',
    source,
    target,
    indexes: [],
    expando: false,
    fields: [
      {
        field: target.fields[0]!,
        read: source.fields[0]
          ? { kind: 'held', held: source.fields[0] }
          : { kind: 'record-accessor', getter: source.accessors[0]!.getter!, setter: null, value: read, write }
      }
    ]
  }
  const domain: NativeFieldViewPlan = { source, target, fields: [{ key: 'shown', read, write }] }
  return {
    id: `${source.shapeId}->${target.shapeId}`,
    source,
    target,
    capability: {
      kind: 'static',
      materializer: {
        id: 'installed-view',
        domain: 'installed-view',
        allocates: true,
        nativeFieldViewProtocol: 'live',
        recordView: { source, target, view, leaves: new Map(), methods: [], fieldViews: new Map([[view, domain]]) }
      }
    }
  }
}

test('installed native descriptors retain their physical carriers independently of callable escape facts', () => {
  const source = record('actual', number)
  const target = record('public', text)
  const domain = nativeFieldViewDomainsOf([route(source, target, number)], null, () => null)
  assert.deepEqual(domain(target)?.get('shown'), [
    { read: text, write: text },
    { read: number, write: number }
  ])
  assert.equal(domain(record('uninstalled', text)), null)
  assert.equal(domain({ ...target, ownership: 'owned' }), null)
})

test('chained native descriptors include immediate and inherited allocation routes with setter absence intact', () => {
  const getter = 'getter' as FunctionId
  const source = { ...record('actual', number), fields: [], accessors: [{ key: 'shown', getter, setter: null, value: number }] }
  const first = record('first', text)
  const second = record('second', text)
  const domain = nativeFieldViewDomainsOf([route(source, first, number, null), route(first, second, text)], null, (id) =>
    id === getter ? { receiver: source, parameters: [], restFrom: null, result: number } : null
  )
  assert.deepEqual(domain(second)?.get('shown'), [
    { read: text, write: text },
    { read: number, write: null }
  ])
})

test('an intermediate public shape preserves descriptors for source keys it does not declare', () => {
  const source = { ...record('actual', text), fields: [...record('actual', text).fields, { key: 'hidden', value: number, required: true }] }
  const first = record('first', text)
  const second = record('second', text)
  const domain = nativeFieldViewDomainsOf([route(source, first, text), route(first, second, text)], null, () => null)
  assert.deepEqual(domain(second)?.get('hidden'), [{ read: number, write: number }])
})

test('ordinary native union arms have physical descriptors; a dynamic arm reads through its own Value', () => {
  const source = record('actual', text)
  const target = record('public', text)
  const domain = nativeFieldViewDomainsOf([route(source, target, text)], null, () => null)
  const union: Representation = {
    kind: 'tagged-union',
    arms: [target, record('other', text)].map((value, ordinal) => ({
      tag: String(ordinal),
      semanticType: String(ordinal) as never,
      runtimeDiscriminator: { kind: 'carrier' },
      value
    }))
  }
  assert.ok(domain(union)?.get('shown'))
  const opaque: Representation = {
    ...union,
    arms: [
      ...union.arms,
      {
        tag: 'opaque',
        semanticType: 'opaque' as never,
        runtimeDiscriminator: { kind: 'carrier' },
        value: { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
      }
    ]
  }
  // The `dynamic` arm invents no descriptor: it is flagged as its own
  // [[Get]], beside the object arms' unchanged physical routes.
  assert.deepEqual(domain(opaque)?.get('shown'), [
    ...domain(union)!.get('shown')!,
    { read: { kind: 'dynamic', reason: 'declared-any-never-narrowed' }, write: null, dynamicGet: true }
  ])
  const onlyDynamic: Representation = { ...union, arms: [opaque.arms[2]!, { ...opaque.arms[2]!, tag: 'again' }] }
  assert.equal(domain(onlyDynamic), null, 'a union of dynamic arms has no live view to read')
})

test('a key one union arm stores is a per-arm union with a certified absence for the plain arms', () => {
  const source = record('actual', text)
  const target = record('public', text)
  const convertible: Extract<Representation, { kind: 'record' }> = {
    ...record('convertible', text),
    fields: [...record('convertible', text).fields, { key: 'toLog', value: number, required: true }]
  }
  const declaration = 'Started' as DeclarationId
  const instance: Representation = { kind: 'class-ref', declaration, shapeId: 'Started', ancestors: [], ownership: 'shared-refcount' }
  const layout: ClassLayout = {
    declaration,
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
    name: 'Started',
    length: 0,
    nativeStorage: { fields: [{ key: 'shown', value: text, required: true }], omittedOverlays: [] }
  }
  const classes = new Map([[declaration, layout]])
  const domain = nativeFieldViewDomainsOf([route(source, target, text)], null, () => null, classes)
  const arm = (value: Representation, ordinal: number) => ({
    tag: String(ordinal),
    semanticType: String(ordinal) as never,
    runtimeDiscriminator: { kind: 'carrier' as const },
    value
  })
  const union: Representation = { kind: 'tagged-union', arms: [target, instance, convertible].map(arm) }
  const absent = { read: { kind: 'undefined' }, write: null, originalAbsent: true }
  assert.deepEqual(domain(union)?.get('toLog'), [absent, { read: number, write: number }])
  assert.equal(
    domain(union)
      ?.get('shown')
      ?.some((route) => route.originalAbsent === true),
    false,
    'a key every arm stores has no absence'
  )
  // A class member, an index signature, or a view source that may hold the
  // key is no proof of absence: the key is dropped exactly as before.
  const method = new Map([[declaration, { ...layout, methods: [{ key: 'toLog', callable: null } as never] }]])
  assert.equal(nativeFieldViewDomainsOf([route(source, target, text)], null, () => null, method)(union)?.get('toLog'), undefined)
  const indexed: Representation = {
    kind: 'record-with-index',
    shapeId: 'indexed',
    fields: record('indexed', text).fields,
    indexes: [],
    ownership: 'shared-refcount'
  }
  assert.equal(domain({ kind: 'tagged-union', arms: [convertible, indexed].map(arm) })?.get('toLog'), undefined)
  const stored = nativeFieldViewDomainsOf(
    [route(source, target, text)],
    null,
    () => null,
    classes,
    (shape, key) => (shape === 'public' && key === 'toLog' ? [number] : [])
  )
  assert.equal(stored(union)?.get('toLog'), undefined, 'an expando a copy stored natively is not absent')
})

test('an ordinary class arm contributes its actual native storage independently of a record view arm', () => {
  const source = record('actual', text)
  const target = record('public', text)
  const declaration = 'NativeClass' as DeclarationId
  const instance: Representation = { kind: 'class-ref', declaration, shapeId: 'NativeClass', ancestors: [], ownership: 'shared-refcount' }
  const layout: ClassLayout = {
    declaration,
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
    name: 'NativeClass',
    length: 0,
    nativeStorage: { fields: [{ key: 'shown', value: number, required: true }], omittedOverlays: [] }
  }
  const domain = nativeFieldViewDomainsOf([route(source, target, text)], null, () => null, new Map([[declaration, layout]]))
  const union: Representation = {
    kind: 'tagged-union',
    arms: [target, instance].map((value, ordinal) => ({
      tag: String(ordinal),
      semanticType: String(ordinal) as never,
      runtimeDiscriminator: { kind: 'carrier' },
      value
    }))
  }
  assert.deepEqual(domain(union)?.get('shown'), [
    { read: text, write: text },
    { read: number, write: number }
  ])
  assert.deepEqual(
    domain(instance)?.get('shown'),
    [{ read: number, write: number }],
    'projected native class storage remains fixed even when Function provenance is opaque'
  )
  assert.equal(domain({ ...instance, ownership: 'owned' }), null)
  assert.equal(nativeFieldViewDomainsOf([], null, () => null)(instance), null)
  const { nativeStorage: _storage, ...unprojected } = layout
  assert.equal(nativeFieldViewDomainsOf([], null, () => null, new Map([[declaration, unprojected]]))(instance), null)

  const getter = 'NativeClass.get' as FunctionId
  const absent: Representation = { kind: 'undefined' }
  const publicAbi = { receiver: instance, parameters: [], restFrom: null, result: absent }
  const getterLayout: ClassLayout = {
    ...layout,
    nativeStorage: { fields: [], omittedOverlays: [] },
    accessors: [{ key: 'shown', getter, setter: null, representation: { kind: 'function-value-dispatch', abi: publicAbi } }]
  }
  const bodyAbi = { ...publicAbi, result: { kind: 'void' as const } }
  const absentDomain = nativeFieldViewDomainsOf([], null, (id) => (id === getter ? bodyAbi : null), new Map([[declaration, getterLayout]]))
  assert.deepEqual(
    absentDomain(instance)?.get('shown'),
    [{ read: absent, write: null }],
    'a void physical getter exposes its published undefined value rather than a void payload token'
  )
  const unsupported: ClassLayout = {
    ...getterLayout,
    accessors: [
      { key: 'shown', getter, setter: null, representation: { kind: 'function-value-dispatch', abi: { ...publicAbi, result: number } } }
    ]
  }
  assert.equal(nativeFieldViewDomainsOf([], null, () => bodyAbi, new Map([[declaration, unsupported]]))(instance), null)
})

test('a key no live descriptor names reads each original allocation expando, never a guessed slot', () => {
  const source = record('actual', number)
  const target = record('public', text)
  const stored: Representation = { kind: 'scalar', domain: 'boolean' }
  const domain = nativeFieldViewDomainsOf(
    [route(source, target, number)],
    null,
    () => null,
    new Map(),
    (shapeId, key) => (shapeId === 'actual' && key === 'extended' ? [stored] : [])
  )
  assert.deepEqual(domain.absentRoutesOf(target, 'missing'), [{ read: { kind: 'undefined' }, write: null, originalAbsent: true }])
  // A copy that stored a native carrier in the source's expando is a typed route beside the absence.
  assert.deepEqual(domain.absentRoutesOf(target, 'extended'), [
    { read: { kind: 'undefined' }, write: null, originalAbsent: true },
    { read: stored, write: null }
  ])
  // A named key keeps its exact descriptor routes; an uninstalled carrier has no live view to answer for.
  assert.equal(domain.absentRoutesOf(target, 'shown'), null)
  assert.equal(domain.absentRoutesOf(record('uninstalled', text), 'missing'), null)
})
