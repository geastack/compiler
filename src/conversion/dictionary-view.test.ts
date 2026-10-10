import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { ConversionNode } from './algebra.js'
import { dictionaryViewPlan, readOnlyDictionaryViewPlan, composedDictionaryViewPlan } from './dictionary-view.js'
import { createConversionNodes } from './nodes.js'
import { structuralConversionKey } from './structural-plan.js'

const string: Representation = { kind: 'string' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const key: Representation = {
  kind: 'class-ref',
  declaration: 'native-dictionary-key' as DeclarationId,
  shapeId: 'native-dictionary-key',
  ancestors: [],
  ownership: 'shared-refcount'
}
const dictionary = (
  value: Representation,
  index: 'string' | 'number' | 'symbol' = 'string'
): Extract<Representation, { kind: 'dictionary' }> => ({
  kind: 'dictionary',
  key: index,
  value,
  ownership: 'shared-refcount'
})
const union = (values: readonly Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type|dictionary-view-${index}` as StructuralTypeId,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })

test('a typed view cites checked reads and native writes into the original declared-any entries', () => {
  const census = censusOf()
  for (const index of ['string', 'number'] as const) {
    const source = dictionary(dynamic, index)
    const target = dictionary(key, index)
    const plan = dictionaryViewPlan(source, target, census.nodeFor, census.nodeById, census.dictionaryReadFor)
    assert.ok(plan)
    assert.equal(plan.read, census.dictionaryReadFor(dynamic, key))
    assert.equal(plan.write, census.nodeFor(key, dynamic))
    assert.equal(plan.source, source)
    assert.equal(plan.target, target)
  }
})

test('a native union entry narrows at each read and widens every typed write back into live storage', () => {
  const wide = union([string, { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }])
  const census = censusOf()
  const source = dictionary(wide)
  const target = dictionary(string)
  const plan = dictionaryViewPlan(source, target, census.nodeFor, census.nodeById, census.dictionaryReadFor)
  assert.ok(plan)
  assert.equal(plan.read, census.dictionaryReadFor(wide, string))
  assert.equal(plan.write, census.nodeFor(string, wide))
  assert.equal(
    dictionaryViewPlan(target, source, census.nodeFor, census.nodeById),
    null,
    'a wider mutable view cannot reject legal array writes'
  )
})

test('a dictionary view cannot borrow a prior nominal guard for a future read', () => {
  const child: Representation = { ...key, declaration: 'native-dictionary-child' as DeclarationId, ancestors: [key.declaration] }
  const census = censusOf()
  assert.equal(dictionaryViewPlan(dictionary(key), dictionary(child), census.nodeFor, census.nodeById), null)
})

test('a dictionary view rejects object reconstruction, guarded writes and malformed citations', () => {
  const source = dictionary(dynamic)
  const target = dictionary(key)
  const census = censusOf()
  const read = census.nodeFor(dynamic, key)
  const write = census.nodeFor(key, dynamic)
  const choose =
    (reader: ConversionNode, writer: ConversionNode) =>
    (from: Representation, into: Representation): ConversionNode | null =>
      representationKey(from) === representationKey(dynamic) && representationKey(into) === representationKey(key) ? reader : writer
  const snapshot: ConversionNode = {
    ...read,
    capability: { kind: 'static', materializer: { id: 'test:snapshot', domain: 'snapshot', allocates: true } }
  }
  assert.equal(dictionaryViewPlan(source, target, choose(snapshot, write)), null)
  const guarded: ConversionNode = {
    ...write,
    capability: {
      kind: 'static',
      materializer: {
        id: 'test:checked-write',
        domain: 'checked-write',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true
      }
    }
  }
  assert.equal(dictionaryViewPlan(source, target, choose(read, guarded)), null, 'a write check is not a total writable contract')
  assert.throws(() => dictionaryViewPlan(source, target, () => census.nodeFor(number, string)), /different carriers/)
  const inconsistent: ConversionNode = { ...read, id: structuralConversionKey(number, string) }
  assert.equal(dictionaryViewPlan(source, target, choose(inconsistent, write), census.nodeById), null)
})

test('dictionary views preserve key domains and require a retained native owner', () => {
  const census = censusOf()
  const source = dictionary(dynamic)
  const target = dictionary(key)
  assert.equal(dictionaryViewPlan(source, dictionary(key, 'number'), census.nodeFor, census.nodeById), null)
  assert.equal(dictionaryViewPlan({ ...source, ownership: 'owned' }, target, census.nodeFor, census.nodeById), null)
  assert.equal(dictionaryViewPlan(source, { ...target, ownership: 'borrowed' }, census.nodeFor, census.nodeById), null)
  assert.equal(dictionaryViewPlan(source, source, census.nodeFor, census.nodeById), null, 'native identity already needs no view')
  assert.equal(
    dictionaryViewPlan(dictionary(dynamic, 'symbol'), dictionary(key, 'symbol'), census.nodeFor, census.nodeById, census.dictionaryReadFor),
    null
  )
})

test('a read-only contextual view widens entries without publishing a fictitious writer', () => {
  const census = censusOf()
  const source = dictionary(string)
  const target = dictionary(union([string, number]))
  assert.equal(census.nodeFor(source, target).capability.kind, 'never')
  const plan = readOnlyDictionaryViewPlan(source, target, census.nodeFor, census.nodeById, census.dictionaryReadFor)
  assert.ok(plan)
  assert.equal('write' in plan, false)
  const contextual = census.readOnlyDictionaryFor(source, target)
  assert.ok(contextual?.capability.kind === 'static')
  assert.ok(contextual.capability.materializer.readOnlyDictionary)
  assert.equal(census.nodeById(contextual.id), contextual)
  assert.equal(census.nodeFor(source, target).capability.kind, 'never', 'a contextual reader cannot upgrade the mutable store pair')
})

test('a contextual readonly plan preserves optional absence and selects one native dictionary arm', () => {
  const census = censusOf()
  const source: Representation = { kind: 'optional', payload: dictionary(string), absence: 'undefined' }
  const target: Representation = {
    kind: 'optional',
    payload: union([dictionary(union([string, number])), string]),
    absence: 'undefined'
  }
  const plan = composedDictionaryViewPlan(source, target, 'read-only', census.nodeFor, census.nodeById, census.dictionaryReadFor)
  assert.ok(plan)
  assert.equal(plan.step.kind, 'optional')
  assert.ok(plan.dependencies.every((node) => census.nodeById(node.id) === node))
  const node = census.readOnlyDictionaryFor(source, target)
  assert.ok(node?.capability.kind === 'static' && node.capability.materializer.readOnlyDictionary)
})

test('a subtype-reduced dictionary merge views every source arm instead of selecting only exact homes', () => {
  const census = censusOf()
  const narrow = dictionary(string)
  const wide = dictionary({ kind: 'optional', payload: union([string, number]), absence: 'undefined' })
  const array: Representation = { kind: 'array-object', element: string, ownership: 'shared-refcount', extension: null }
  const source: Representation = { kind: 'optional', payload: union([narrow, array, wide]), absence: 'undefined' }
  const target: Representation = { kind: 'optional', payload: union([array, wide]), absence: 'undefined' }
  const ordinary = census.nodeFor(source, target)
  assert.equal(ordinary.capability.kind, 'atom')
  assert.ok('materializer' in ordinary.capability && ordinary.capability.materializer.nativeSelection)
  const subset = ordinary.capability.materializer.nativeSelection.step
  assert.ok(subset.kind === 'optional' && subset.present?.kind === 'dispatch')
  assert.equal(subset.present.arms[0], null, 'the ordinary narrowing correctly rejects the removed dictionary tag')

  const node = census.readOnlyDictionaryFor(source, target)
  assert.ok(node?.capability.kind === 'static')
  const plan = node.capability.materializer.readOnlyDictionary
  assert.ok(plan?.step.kind === 'optional' && plan.step.present.kind === 'dispatch')
  assert.equal(plan.step.present.arms.length, 3)
  const widened = plan.step.present.arms[0]
  assert.ok(widened?.kind === 'wrap' && widened.payload.kind === 'inject' && widened.payload.payload.kind === 'read-only-dictionary')
  assert.equal(widened.payload.index, 1)
  assert.equal(widened.payload.payload.view.source, narrow)
  assert.equal(widened.payload.payload.view.target, wide)
  assert.ok(plan.dependencies.every((dependency) => census.nodeById(dependency.id) === dependency))
  assert.equal(
    composedDictionaryViewPlan(source, target, 'mutable', census.nodeFor, census.nodeById, census.dictionaryReadFor),
    null,
    'the wide mutable table cannot promise that arbitrary writes fit the narrow source'
  )
  assert.equal(census.nodeFor(source, target), ordinary, 'the contextual read proof does not replace real subset narrowing')

  const excluded: Representation = { kind: 'optional', payload: union([key, narrow, array, wide]), absence: 'undefined' }
  assert.equal(census.readOnlyDictionaryFor(excluded, target), null, 'an omitted class arm cannot masquerade as a dictionary view')
})

test('a future invalid entry uses an explicit catchable checked materializer rather than an unchecked payload load', () => {
  const census = censusOf()
  const ordinary = census.nodeFor(dynamic, key)
  assert.equal(dictionaryViewPlan(dictionary(dynamic), dictionary(key), census.nodeFor, census.nodeById), null)
  const reader = census.dictionaryReadFor(dynamic, key)
  assert.ok(reader?.capability.kind === 'static')
  assert.equal(reader.capability.materializer.dictionaryRead?.conversion, ordinary)
  assert.deepEqual(reader.capability.materializer.dependencies, [ordinary])
})
