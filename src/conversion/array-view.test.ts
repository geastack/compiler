import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { nativeArrayViewPlanMatches, nativeArrayViewPlanOf, nativeArrayViewPlansOf, nativeArrayRootViewPlansOf } from './array-view.js'
import { createConversionNodes } from './nodes.js'
import { recipeClosureOf } from './recipe-closure.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { representationKey, type Representation } from '../representation/model.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const record: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'array-view-entry',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'name', required: true, value: { kind: 'string' } }]
}
const arrayOf = (element: Representation): Extract<Representation, { kind: 'array-object' }> => ({
  kind: 'array-object',
  element,
  ownership: 'shared-refcount',
  extension: null
})
const layouts = {
  forShape: () => record.fields,
  plainFieldsForShape: () => record.fields,
  accessorsForShape: () => [],
  indexesForShape: () => []
}
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
const siteOf = (census: ReturnType<typeof censusOf>, node: ConversionNode): ConversionSite => {
  const closure = recipeClosureOf([node], census.nodeById)
  return {
    conversions: census,
    layouts,
    classes: new Map(),
    captures: emptyCaptureIndex,
    functionFacts: new Map(),
    printerDrift: [],
    owner: 'native-array-view-test',
    conversionIsCertified: (id) => closure.has(id)
  }
}

test('a declared-any array retains typed replacements natively and cites future checked reads separately from dynamic observations', () => {
  const layouts = {
    forShape: () => record.fields,
    plainFieldsForShape: () => record.fields,
    accessorsForShape: () => [],
    indexesForShape: () => []
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const source = arrayOf(dynamic)
  const target = arrayOf(record)
  const plan = nativeArrayViewPlanOf(source, target, census.nodeFor, census.nodeFor, census.nodeById)
  assert.ok(plan?.write.kind === 'native-entry')
  assert.equal(plan.read, census.nodeFor(dynamic, record))
  assert.ok('materializer' in plan.read.capability && plan.read.capability.materializer.documentRecordView)
  assert.equal(plan.write.stored, census.nodeFor(record, record))
  assert.equal(plan.write.stored.capability.kind, 'identity')
  assert.equal(plan.write.observation, census.nodeFor(record, dynamic))
  assert.notEqual(plan.write.stored, plan.write.observation)
  assert.deepEqual(plan.dependencies, [plan.read, plan.write.stored, plan.write.observation])
  assert.ok(nativeArrayViewPlanMatches(plan, source, target, census.nodeById))
  assert.equal(
    nativeArrayViewPlanMatches({ ...plan, read: { ...plan.read } }, source, target, census.nodeById),
    false,
    'a copied read object cannot borrow the canonical node identity'
  )
  assert.equal(nativeArrayViewPlanMatches(plan, source, arrayOf({ kind: 'string' }), census.nodeById), false)
  const selected = census.nodeFor(dynamic, target)
  assert.ok(selected.capability.kind === 'atom')
  const installed = selected.capability.materializer.nativeArrayView
  assert.ok(installed?.write.kind === 'native-entry')
  assert.equal(installed.read, plan.read)
  assert.equal(installed.write.stored, plan.write.stored)
  assert.equal(installed.write.observation, plan.write.observation)
  assert.equal(selected.capability.materializer.nativePayloadTransport, 'preserved')
  assert.equal(selected.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(selected.capability.materializer.requiresSourceGuard, true)
  assert.equal(selected.capability.materializer.executesSourceGuard, true)
  assert.equal(selected.capability.classifier.id, 'gea::detail::nativeArrayViewAccepts')
  assert.ok(nativeArrayViewPlanMatches(installed, dynamic, target, census.nodeById))
  assert.equal(
    nativeArrayViewPlanMatches({ ...installed, dependencies: installed.dependencies.slice(1) }, dynamic, target, census.nodeById),
    false
  )
  const closure = recipeClosureOf([selected], census.nodeById)
  assert.ok(installed.dependencies.every((child) => closure.get(child.id) === child))
  assert.deepEqual(nativeArrayViewPlansOf(closure.values()), [installed])
  const emitted = recipeText(siteOf(census, selected), selected, 'readArray()')!
  assert.ok(emitted.includes('checkedNativeArrayView<'))
  assert.ok(emitted.includes('makeDocumentViewWithOrigin<'))
  assert.equal(emitted.split('readArray()').length - 1, 1)
  assert.equal(emitted.includes('arrayFromDynamic'), false)
  assert.equal(emitted.includes('rebuildArray'), false)
})

test('an array reader survives optional and Promise wrappers through exact canonical callback dependencies', () => {
  const census = censusOf()
  const array = arrayOf(record)
  const promise: Representation = { kind: 'promise', value: array }
  const target: Representation = { kind: 'optional', payload: promise, absence: 'undefined' }
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'static')
  const optional = node.capability.materializer.dynamicWrapper
  assert.ok(optional?.kind === 'optional')
  assert.equal(optional.payload, census.nodeFor(dynamic, promise))
  assert.ok(optional.payload.capability.kind === 'static')
  const future = optional.payload.capability.materializer.dynamicWrapper
  assert.ok(future?.kind === 'promise')
  assert.equal(future.payload, census.nodeFor(dynamic, array))
  const closure = recipeClosureOf([node], census.nodeById)
  assert.equal(nativeArrayViewPlansOf(closure.values()).length, 1)
  assert.deepEqual(nativeArrayRootViewPlansOf(node, census.nodeById), nativeArrayViewPlansOf(closure.values()))
  const emitted = recipeText(siteOf(census, node), node, 'readOptionalPromise()')!
  assert.ok(emitted.includes('promiseFromDynamic<'))
  assert.ok(emitted.includes('checkedNativeArrayView<'))
  assert.ok(emitted.includes('Value::Tag::Undefined'))
  assert.equal(emitted.split('readOptionalPromise()').length - 1, 1)
  assert.equal(emitted.includes('arrayFromDynamic'), false)
})

test('the genuine Array<Value> envelope uses exact checked identity instead of copying or refusing its entries', () => {
  const census = censusOf()
  const target = arrayOf(dynamic)
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'atom')
  const plan = node.capability.materializer.nativeArrayView
  assert.ok(plan?.write.kind === 'native-entry')
  assert.equal(plan.read, census.nodeFor(dynamic, dynamic))
  assert.equal(plan.read.capability.kind, 'identity')
  assert.equal(plan.write.stored, plan.read)
  assert.equal(plan.write.observation, plan.read)
  assert.ok(nativeArrayViewPlanMatches(plan, dynamic, target, census.nodeById))
  const emitted = recipeText(siteOf(census, node), node, 'readDeclaredAnyArray()')!
  assert.ok(emitted.includes('checkedNativeArrayView<gea::Value'))
  assert.equal(emitted.includes('arrayFromDynamic'), false)
  assert.equal(emitted.split('readDeclaredAnyArray()').length - 1, 1)
})

test('a nested array field dependency cannot nominate its ordinary outer holder as an installed array root', () => {
  const census = censusOf()
  const array = census.nodeFor(dynamic, arrayOf(record))
  const outer: ConversionNode = {
    id: 'ordinary-array-holder',
    source: dynamic,
    target: { ...record, shapeId: 'ordinary-array-holder' },
    capability: {
      kind: 'static',
      materializer: { id: 'ordinary-array-holder', domain: 'ordinary-array-holder', allocates: true, dependencies: [array] }
    }
  }
  const resolve = (id: string) => (id === outer.id ? outer : census.nodeById(id))
  assert.equal(nativeArrayViewPlansOf(recipeClosureOf([outer], resolve).values()).length, 1)
  assert.deepEqual(nativeArrayRootViewPlansOf(outer, resolve), [])
  assert.equal(nativeArrayRootViewPlansOf(array, resolve).length, 1)
})

test('native element views require a total reverse writer and refuse a check that accepts only some replacement values', () => {
  const sourceElement: Representation = {
    kind: 'native-record-ref',
    shapeId: 'array-native-source',
    ownership: 'shared-refcount',
    native: null
  }
  const targetElement: Representation = {
    kind: 'native-record-ref',
    shapeId: 'array-native-target',
    ownership: 'shared-refcount',
    native: null
  }
  const source = arrayOf(sourceElement)
  const target = arrayOf(targetElement)
  const node = (from: Representation, into: Representation, guarded = false): ConversionNode => ({
    id: `${representationKey(from)}->${representationKey(into)}`,
    source: from,
    target: into,
    capability: {
      kind: 'static',
      materializer: {
        id: 'native-array-element-transfer',
        domain: 'native-array-element-transfer',
        allocates: false,
        nativePayloadTransport: 'preserved',
        nativeFieldProtocol: 'unused',
        ...(guarded ? { requiresSourceGuard: true, executesSourceGuard: true } : {})
      }
    }
  })
  const read = node(sourceElement, targetElement)
  const write = node(targetElement, sourceElement)
  const nodes = new Map([
    [read.id, read],
    [write.id, write]
  ])
  const resolve = (id: string) => nodes.get(id) ?? null
  const accepted = (from: Representation, into: Representation) => resolve(`${representationKey(from)}->${representationKey(into)}`)
  const plan = nativeArrayViewPlanOf(source, target, accepted, accepted, resolve)
  assert.ok(plan?.write.kind === 'conversion')
  assert.equal(plan.read, read)
  assert.equal(plan.write.conversion, write)
  assert.ok(nativeArrayViewPlanMatches(plan, source, target, resolve))
  nodes.set(write.id, node(targetElement, sourceElement, true))
  assert.equal(nativeArrayViewPlanOf(source, target, accepted, accepted, resolve), null)
  assert.equal(nativeArrayViewPlanMatches(plan, source, target, resolve), false)
})

test('an array view refuses copying reads, earlier source guards, synthetic dynamic storage and unrelated native source carriers', () => {
  const source = arrayOf(dynamic)
  const target = arrayOf(record)
  const layouts = {
    forShape: () => record.fields,
    plainFieldsForShape: () => record.fields,
    accessorsForShape: () => [],
    indexesForShape: () => []
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const read: ConversionNode = {
    id: `${representationKey(dynamic)}->${representationKey(record)}`,
    source: dynamic,
    target: record,
    capability: { kind: 'static', materializer: { id: 'copy-record', domain: 'copy-record', allocates: true } }
  }
  const selected = (from: Representation, into: Representation) =>
    representationKey(from) === representationKey(dynamic) && representationKey(into) === representationKey(record)
      ? read
      : census.nodeFor(from, into)
  const resolve = (id: string) => (id === read.id ? read : census.nodeById(id))
  assert.equal(nativeArrayViewPlanOf(source, target, selected, selected, resolve), null)
  const guarded = {
    ...read,
    capability: {
      kind: 'static' as const,
      materializer: { id: 'earlier-guard', domain: 'earlier-guard', allocates: false, requiresSourceGuard: true as const }
    }
  }
  assert.equal(
    nativeArrayViewPlanOf(
      source,
      target,
      census.nodeFor,
      () => guarded,
      (id) => (id === guarded.id ? guarded : census.nodeById(id))
    ),
    null
  )
  assert.equal(
    nativeArrayViewPlanOf(
      arrayOf({ kind: 'dynamic', reason: 'untyped-callable' }),
      target,
      census.nodeFor,
      census.nodeFor,
      census.nodeById
    ),
    null
  )
  assert.equal(nativeArrayViewPlanOf({ ...source, ownership: 'owned' }, target, census.nodeFor, census.nodeFor, census.nodeById), null)
  assert.equal(nativeArrayViewPlanOf({ ...source, extension: [] }, target, census.nodeFor, census.nodeFor, census.nodeById), null)
  assert.equal(nativeArrayViewPlanOf(source, source, census.nodeFor, census.nodeFor, census.nodeById), null)
  const wrong = census.nodeFor({ kind: 'string' }, record)
  assert.equal(
    nativeArrayViewPlanOf(source, target, census.nodeFor, () => wrong, census.nodeById),
    null
  )
})
