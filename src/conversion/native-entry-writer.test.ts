import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { documentFieldWriterOf, documentRecordViewPlanOf } from './document-record-view.js'
import { nativeEntryWriterOf } from './native-entry-writer.js'
import { createConversionNodes } from './nodes.js'
import { representationKey, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'

const any: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const native: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'native-entry-payload',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'size', value: { kind: 'scalar', domain: 'number' }, required: true }]
}
const optional: Representation = { kind: 'optional', payload: native, absence: 'undefined' }
const layouts = {
  indexesForShape: () => [],
  accessorsForShape: () => [],
  forShape: () => native.fields,
  plainFieldsForShape: () => native.fields
}
const censusOf = () => createConversionNodes({ nodes: new Map(), registry: createCppConversionRegistry(layouts) })

test('a native entry writer stores the selected optional identity separately from its delayed declared-any observation', () => {
  const census = censusOf()
  const writer = nativeEntryWriterOf(optional, any, census.nodeFor, census.nodeById)
  assert.ok(writer)
  assert.equal(writer.stored, census.nodeFor(optional, optional))
  assert.equal(writer.stored.capability.kind, 'identity')
  assert.equal(writer.observation, census.nodeFor(optional, any))
  assert.notEqual(writer.stored, writer.observation)
  assert.deepEqual(documentFieldWriterOf(optional, any, census.nodeFor, census.nodeById), writer)
})

test('entry storage requires canonical identities and a complete unguarded observer at the actual dynamic boundary', () => {
  const census = censusOf()
  const writer = nativeEntryWriterOf(optional, any, census.nodeFor, census.nodeById)!
  assert.ok(writer)
  for (const missing of [writer.stored, writer.observation])
    assert.equal(
      nativeEntryWriterOf(optional, any, census.nodeFor, (id) => (id === missing.id ? null : census.nodeById(id))),
      null
    )
  assert.equal(
    nativeEntryWriterOf(optional, any, (from, into) => ({ ...census.nodeFor(from, into) }), census.nodeById),
    null
  )
  assert.equal(
    nativeEntryWriterOf(
      optional,
      any,
      (from, into) => census.nodeFor(from, representationKey(from) === representationKey(into) ? any : into),
      census.nodeById
    ),
    null,
    'an observation cannot substitute for native storage'
  )
  const guarded: ConversionNode = {
    ...writer.observation,
    capability: {
      kind: 'static',
      materializer: {
        id: 'guarded-entry-observation',
        domain: 'guarded-entry-observation',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true
      }
    }
  }
  const accepted = (from: Representation, into: Representation) =>
    representationKey(into) === representationKey(any) ? guarded : census.nodeFor(from, into)
  assert.equal(
    nativeEntryWriterOf(optional, any, accepted, (id) => (id === guarded.id ? guarded : census.nodeById(id))),
    null
  )
  for (const entry of [
    { kind: 'string' } as const,
    { kind: 'dynamic', reason: 'untyped-callable' } as const,
    { kind: 'dynamic', reason: 'thrown-error-carrier' } as const
  ])
    assert.equal(nativeEntryWriterOf(optional, entry, census.nodeFor, census.nodeById), null)
})

test('a named Document aggregate field cites both original Value entries and future native holder storage', () => {
  const census = censusOf()
  const target = { ...native, shapeId: 'native-entry-view', fields: [{ key: 'meta', value: optional, required: false }] }
  const plan = documentRecordViewPlanOf(
    { kind: 'dictionary', key: 'string', ownership: 'shared-refcount', value: any },
    target,
    layouts,
    census.nodeFor,
    census.dictionaryReadFor,
    census.nodeById
  )
  assert.ok(plan?.fields[0]?.write.kind === 'native-entry')
  assert.deepEqual(
    plan.nativeFields.fields.map((field) => field.read),
    [any, optional]
  )
  assert.equal(plan.nativeFields.fields[0]?.checkedRead, plan.fields[0].read)
  assert.deepEqual(plan.dependencies, [plan.fields[0].read, plan.fields[0].write.stored, plan.fields[0].write.observation])
  assert.equal(
    documentRecordViewPlanOf(
      { kind: 'dictionary', key: 'string', ownership: 'shared-refcount', value: any },
      { ...target, fields: [{ key: '0', value: optional, required: false }] },
      layouts,
      census.nodeFor,
      census.dictionaryReadFor,
      census.nodeById
    ),
    null,
    'a named holder receipt cannot invent numeric array storage'
  )
})

test('a lane-checked native entry store owns a numeric key; an unchecked one still cannot', () => {
  const census = censusOf()
  const document: Representation = { kind: 'dictionary', key: 'string', ownership: 'shared-refcount', value: any }
  const tuple = { ...native, shapeId: 'native-entry-tuple', fields: [{ key: '1', value: optional, required: false }] }
  const plan = (store?: { readonly laneChecked?: true }) =>
    documentRecordViewPlanOf(document, tuple, layouts, census.nodeFor, census.dictionaryReadFor, census.nodeById, store)
  assert.equal(plan(), null, 'an unchecked native entry store cannot claim an Array element lane')
  assert.equal(plan({}), null, 'a store that does not declare the lane check is unchecked')
  const checked = plan({ laneChecked: true })
  assert.ok(checked?.fields[0]?.write.kind === 'native-entry')
  assert.equal(checked.fields[0].write.laneChecked, true)
  assert.deepEqual(
    checked.nativeFields.fields.map((field) => [field.key, field.read]),
    [
      ['1', any],
      ['1', optional]
    ]
  )
  const writer = nativeEntryWriterOf(optional, any, census.nodeFor, census.nodeById, { laneChecked: true })
  assert.equal(writer?.laneChecked, true)
  assert.equal(nativeEntryWriterOf(optional, any, census.nodeFor, census.nodeById)?.laneChecked, undefined)
})
