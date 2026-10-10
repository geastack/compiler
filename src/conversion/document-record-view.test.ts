import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { composedDocumentRecordViewPlanOf, documentRecordViewPlanOf, nativeDocumentEntryViewOf } from './document-record-view.js'
import { createConversionNodes } from './nodes.js'
import { recipeClosureOf } from './recipe-closure.js'
import { nativeFieldViewIdentityTransportOf, nativeFieldViewPlansOf } from './native-field-view.js'
import { nativeViewOriginsOf } from './native-view-origins.js'
import { nativeFieldViewDomainsOf } from '../ir/native-field-view-domains.js'
import type { Representation } from '../representation/model.js'
import type { StructuralTypeId } from '../identity/ids.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { dictionaryEntryReadIsLive } from './dictionary-view.js'
import { dictionaryReadText } from '../targets/cpp/emit-dictionary-view.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'
import { createRepresentationDeriver } from '../representation/derive.js'
import { recordShapeLayoutsOf } from '../projection/fields.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const text: Representation = { kind: 'string' }
const document: Representation = { kind: 'dictionary', key: 'string', value: dynamic, ownership: 'shared-refcount' }
const record: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'document-field-view',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'shown', value: text, required: true }]
}
const layouts = {
  forShape: () => record.fields,
  plainFieldsForShape: () => record.fields,
  accessorsForShape: () => [],
  indexesForShape: () => []
}
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
const siteOf = (conversions: ReturnType<typeof censusOf>): ConversionSite => ({
  conversions,
  layouts,
  classes: new Map(),
  captures: emptyCaptureIndex,
  functionFacts: new Map(),
  printerDrift: [],
  owner: 'document-field-view'
})

test('a shared document view cites checked future entry reads and total writes without sampling an allocation', () => {
  const census = censusOf()
  const node = census.nodeFor(document, record)
  assert.ok('materializer' in node.capability)
  const plan = node.capability.materializer.documentRecordView
  assert.ok(plan?.step.kind === 'view')
  const field = plan.step.view.fields[0]!
  assert.equal(field.read, census.dictionaryReadFor(dynamic, text))
  assert.deepEqual(field.write, { kind: 'conversion', conversion: census.nodeFor(text, dynamic) })
  assert.ok(plan.dependencies.every((child) => census.nodeById(child.id) === child))
  const routes = nativeFieldViewPlansOf(recipeClosureOf([node], census.nodeById).values())
  assert.equal(routes.length, 1)
  assert.deepEqual(nativeViewOriginsOf([node], census.nodeById), [{ source: document, target: record }])
  const domains = nativeFieldViewDomainsOf([node], null, () => null)(record)?.get('shown')
  assert.ok(domains?.some((entry) => entry.read === dynamic && entry.checkedRead === field.read && entry.declaredAnyEntry === true))
  const source = recipeText(siteOf(census), node, 'document')
  assert.match(source!, /makeDocumentViewWithOrigin/)
  assert.match(source!, /readDocumentField/)
  assert.doesNotMatch(source!, /adoptProduct|dynamicRecordField|gea_from_dynamic/)
})

test('a genuine dynamic object enters the same live document view through its exact canonical child', () => {
  const census = censusOf()
  const target: Representation = { kind: 'optional', payload: record, absence: 'undefined' }
  const node = census.nodeFor(dynamic, target)
  assert.ok('materializer' in node.capability)
  const plan = node.capability.materializer.documentRecordView
  assert.ok(plan?.step.kind === 'dynamic-optional')
  assert.ok(plan.step.present.kind === 'document')
  assert.equal(plan.step.present.conversion, census.nodeFor(dynamic, document))
  const source = recipeText(siteOf(census), node, 'value')
  assert.match(source!, /Value::Tag::Undefined/)
  assert.match(source!, /unboxDynamicDictionary/)
  assert.doesNotMatch(source!, /adoptProduct|dynamicRecordField/)
  const named: Representation = {
    kind: 'native-record-ref',
    shapeId: record.shapeId,
    ownership: 'shared-refcount',
    native: null
  }
  const direct = census.nodeFor(dynamic, named)
  assert.ok('materializer' in direct.capability && direct.capability.materializer.documentRecordView)
  assert.equal(census.dictionaryReadFor(dynamic, named), direct, 'a live field view must not become an exact-payload-only reader')
})

test('a nullish argument artifact cites its live payload and cannot invent a context-free structural load', () => {
  const census = censusOf()
  const target: Representation = { kind: 'optional', payload: record, absence: 'undefined' }
  const node = census.nullishOptionalFor(dynamic, target)
  assert.ok(node?.capability.kind === 'static')
  const payload = census.nodeFor(dynamic, record)
  assert.deepEqual(node.capability.materializer.dependencies, [payload])
  assert.equal(node.capability.materializer.allocates, true)
  const closure = recipeClosureOf([node], census.nodeById)
  assert.equal(closure.get(payload.id), payload)
  assert.ok(nativeFieldViewPlansOf(closure.values()).some((plan) => plan.target === record))
  const site = { ...siteOf(census), conversionIsCertified: (id: string) => closure.has(id) }
  const source = recipeText(site, node, 'readNullishArgument()')
  assert.match(source!, /Value::Tag::Null/)
  assert.match(source!, /Value::Tag::Undefined/)
  assert.match(source!, /makeDocumentViewWithOrigin/)
  assert.match(source!, /unboxDynamicDictionary/)
  assert.equal(source!.match(/readNullishArgument\(\)/g)?.length, 1)
  const missing = { ...node, capability: { ...node.capability, materializer: { ...node.capability.materializer, dependencies: [] } } }
  assert.equal(recipeText(siteOf(census), missing, 'value'), null)
  const substituted = {
    ...node,
    capability: { ...node.capability, materializer: { ...node.capability.materializer, dependencies: [{ ...payload }] } }
  }
  assert.equal(recipeText(siteOf(census), substituted, 'value'), null)
  assert.equal(census.nullishOptionalFor({ kind: 'dynamic', reason: 'untyped-callable' }, target), null)
  const array: Representation = { kind: 'array-object', element: record, ownership: 'shared-refcount', extension: null }
  // The array is its own live native array view over the canonical element
  // reader (`array-view.test.ts`), never the standalone record's protocol.
  const viewed = census.nodeFor(dynamic, array).capability
  assert.ok(viewed.kind === 'atom', 'an array cannot borrow a standalone record field protocol')
  assert.equal(viewed.materializer.documentRecordView, undefined)
  assert.equal(viewed.materializer.nativeArrayView?.read, census.nodeFor(dynamic, record))
  const promise = census.nodeFor(dynamic, { kind: 'promise', value: record })
  assert.ok('materializer' in promise.capability && promise.capability.materializer.dynamicWrapper?.kind === 'promise')
  assert.equal(promise.capability.materializer.dynamicWrapper.payload, payload)
})

test('optional document fields check each future present entry and preserve the declared absence', () => {
  const census = censusOf()
  for (const absence of ['undefined', 'null'] as const) {
    const target: Representation = { kind: 'optional', payload: text, absence }
    const reader = census.dictionaryReadFor(dynamic, target)
    assert.ok(reader && 'materializer' in reader.capability)
    const contract = reader.capability.materializer.dictionaryRead
    assert.ok(contract?.kind === 'dynamic-optional')
    assert.equal(contract.present, census.dictionaryReadFor(dynamic, text))
    assert.equal(contract.absent, census.nodeFor({ kind: absence }, target))
    assert.equal(census.nodeById(contract.present.id), contract.present)
    assert.equal(census.nodeById(contract.absent.id), contract.absent)
    assert.equal(dictionaryEntryReadIsLive(reader, census.nodeById), true)
    assert.equal(dictionaryReadText(contract, 'entry'), null, 'the renderer cannot invent a missing child renderer')
    const source = recipeText(siteOf(census), reader, 'entry')
    assert.match(source!, new RegExp(`Value::Tag::${absence === 'null' ? 'Null' : 'Undefined'}`))
    assert.match(source!, /checkedPayloadEntry<std::string>/)
    assert.doesNotMatch(source!, /gea_from_dynamic|adoptProduct/)

    const optionalRecord: Extract<Representation, { kind: 'record' }> = {
      ...record,
      fields: [{ key: 'shown', value: target, required: false }]
    }
    const layouts = {
      forShape: () => optionalRecord.fields,
      plainFieldsForShape: () => optionalRecord.fields,
      accessorsForShape: () => [],
      indexesForShape: () => []
    }
    const plan = documentRecordViewPlanOf(document, optionalRecord, layouts, census.nodeFor, census.dictionaryReadFor)
    assert.ok(plan)
    assert.equal(plan.fields[0]!.read, reader)

    const uncheckedPresent: ConversionNode = {
      ...contract.present,
      id: `${contract.present.id}:unchecked`,
      capability: {
        kind: 'static',
        materializer: { id: 'unchecked-present', domain: 'unchecked-present', allocates: false, requiresSourceGuard: true }
      }
    }
    const uncheckedReader: ConversionNode = {
      ...reader,
      id: `${reader.id}:unchecked`,
      capability: {
        kind: 'static',
        materializer: {
          ...reader.capability.materializer,
          dictionaryRead: { ...contract, present: uncheckedPresent },
          dependencies: [contract.conversion, uncheckedPresent, contract.absent]
        }
      }
    }
    assert.equal(dictionaryEntryReadIsLive(uncheckedReader), false, 'a wrapper cannot hide a present entry requiring an earlier guard')
    assert.equal(
      documentRecordViewPlanOf(document, optionalRecord, layouts, census.nodeFor, () => uncheckedReader),
      null
    )
  }
})

test('a field view refuses an unchecked future reader, guarded writer and mismatched carrier citation', () => {
  const census = censusOf()
  const read = census.dictionaryReadFor(dynamic, text)!
  const write = census.nodeFor(text, dynamic)
  const unsafe: ConversionNode = {
    ...read,
    capability: {
      kind: 'static',
      materializer: {
        id: 'unsafe-read',
        domain: 'unsafe-read',
        allocates: false,
        requiresSourceGuard: true
      }
    }
  }
  assert.equal(
    documentRecordViewPlanOf(document, record, layouts, census.nodeFor, () => unsafe),
    null
  )
  const guarded: ConversionNode = {
    ...write,
    capability: {
      kind: 'static',
      materializer: {
        id: 'guarded-write',
        domain: 'guarded-write',
        allocates: false,
        requiresSourceGuard: true,
        executesSourceGuard: true
      }
    }
  }
  assert.equal(
    documentRecordViewPlanOf(
      document,
      record,
      layouts,
      () => guarded,
      () => read
    ),
    null
  )
  assert.throws(() => documentRecordViewPlanOf(document, record, layouts, census.nodeFor, () => write), /different carriers/)
})

test('closed native storage cannot manufacture declared-any entries, and unresolved schemas retain no migration fallback', () => {
  const census = censusOf()
  assert.equal(
    documentRecordViewPlanOf({ ...document, value: text } as Representation, record, layouts, census.nodeFor, census.dictionaryReadFor),
    null
  )
  assert.equal(
    documentRecordViewPlanOf(document, { ...record, ownership: 'owned' }, layouts, census.nodeFor, census.dictionaryReadFor),
    null
  )
  const indexed = { ...layouts, indexesForShape: () => [{ key: 'string' as const, value: dynamic }] }
  assert.ok(documentRecordViewPlanOf(document, record, indexed, census.nodeFor, census.dictionaryReadFor))
  const typed = { ...layouts, indexesForShape: () => [{ key: 'string' as const, value: text }] }
  assert.equal(documentRecordViewPlanOf(document, record, typed, census.nodeFor, census.dictionaryReadFor), null)
  const unresolved = createConversionNodes({ registry: createCppConversionRegistry(typed), nodes: new Map() })
  assert.equal(unresolved.nodeFor(dynamic, record).capability.kind, 'never')
})

test('only an actual declared-any string index receives the original Document entry protocol', () => {
  const indexed: Extract<Representation, { kind: 'record-with-index' }> = {
    kind: 'record-with-index',
    shapeId: 'document-index-view',
    ownership: 'shared-refcount',
    fields: record.fields,
    indexes: [{ key: 'string', value: dynamic }]
  }
  const policies = { ...layouts, indexesForShape: () => indexed.indexes }
  const census = createConversionNodes({ registry: createCppConversionRegistry(policies), nodes: new Map() })
  const node = census.nodeFor(dynamic, indexed)
  assert.ok('materializer' in node.capability && node.capability.materializer.documentRecordView)
  assert.equal(nativeDocumentEntryViewOf(node, census.nodeById), dynamic)
  const plan = node.capability.materializer.documentRecordView
  assert.equal(plan.nativeFields[0]?.target, indexed)
  const source = recipeText({ ...siteOf(census), layouts: policies }, node, 'parsed')
  assert.match(source!, /makeDocumentViewWithOrigin/)
  assert.match(source!, /readDocumentField|writeDocumentField/)
  assert.doesNotMatch(source!, /adoptProduct|dynamicRecordField|Value::box/)
  for (const indexes of [
    [{ key: 'number' as const, value: dynamic }],
    [{ key: 'symbol' as const, value: dynamic }],
    [{ key: 'string' as const, value: text }],
    [{ key: 'string' as const, value: { kind: 'dynamic' as const, reason: 'untyped-callable' as const } }],
    [
      { key: 'string' as const, value: dynamic },
      { key: 'symbol' as const, value: dynamic }
    ]
  ])
    assert.equal(
      documentRecordViewPlanOf(document, { ...indexed, indexes }, policies, census.nodeFor, census.dictionaryReadFor),
      null,
      'a wildcard lane needs its actual declared-any string-entry storage'
    )
  assert.equal(nativeDocumentEntryViewOf(census.nodeFor(record, record), census.nodeById), null)
  const aggregate = documentRecordViewPlanOf(
    document,
    {
      ...record,
      fields: [{ key: 'typed', value: record, required: true }]
    },
    layouts,
    census.nodeFor,
    census.dictionaryReadFor,
    census.nodeById
  )
  assert.ok(aggregate?.fields[0]?.write.kind === 'native-entry')
  assert.equal(aggregate.fields[0].write.stored.capability.kind, 'identity')
  assert.equal(aggregate.fields[0].write.observation.target, dynamic)
})

test('a nominal Document view consumes its admitted indexed layout rather than the plain-field copy policy', () => {
  const table = createStructuralTypeTable()
  const entry = table.intern({ kind: 'primitive', primitive: 'any' })
  const shown = table.intern({ kind: 'primitive', primitive: 'string' })
  const shapeId = table.intern({
    kind: 'object',
    members: [{ key: { kind: 'string', value: 'shown' }, type: shown, optional: false, readonly: false, accessor: null }],
    index: [{ key: 'string', value: entry, readonly: false }],
    membersDropped: false
  })
  const deriver = createRepresentationDeriver(table.seal())
  const policies = recordShapeLayoutsOf(deriver, new Map())
  assert.equal(policies.plainFieldsForShape?.(shapeId), null, 'an indexed layout is not an immutable plain-field copy')
  const target: Representation = { kind: 'native-record-ref', shapeId, ownership: 'shared-refcount', native: null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(policies), nodes: new Map() })
  const node = census.nodeFor(dynamic, target)
  assert.ok('materializer' in node.capability && node.capability.materializer.documentRecordView)
  const plan = node.capability.materializer.documentRecordView
  assert.ok(plan.step.kind === 'document' && plan.step.payload.kind === 'view')
  assert.deepEqual(
    plan.step.payload.view.fields.map((field) => field.key),
    ['shown']
  )
  assert.equal(plan.step.payload.view.fields[0]!.read, census.dictionaryReadFor(dynamic, text))
  assert.equal(nativeDocumentEntryViewOf(node, census.nodeById), dynamic)
})

test('one copying union arm prevents a whole-source live identity claim', () => {
  const census = censusOf()
  const owned: Representation = { ...record, shapeId: 'owned-field-source', ownership: 'owned' }
  assert.notEqual(census.nodeFor(owned, record).capability.kind, 'never', 'the value copy itself remains supported')
  const mixed: Representation = {
    kind: 'tagged-union',
    arms: [document, owned].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `document-copy-arm-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const node = census.nodeFor(mixed, record)
  assert.equal(nativeFieldViewIdentityTransportOf(node), false, 'a copying child cannot authorize an alias-preserving source union')
  assert.equal(composedDocumentRecordViewPlanOf(mixed, record, layouts, census.nodeFor, census.dictionaryReadFor, census.nodeById), null)
})
