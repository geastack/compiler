import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeDescriptorSnapshotPlanMatches, nativeDescriptorSnapshotPlanOf } from './native-descriptor-snapshot.js'
import { createConversionNodes } from './nodes.js'
import { recipeClosureOf } from './recipe-closure.js'
import { nativeFieldViewPlansOf } from './native-field-view.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import type { Representation } from '../representation/model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const undefinedValue: Representation = { kind: 'undefined' }
const optional = (payload: Representation): Extract<Representation, { kind: 'optional' }> => ({
  kind: 'optional',
  payload,
  absence: 'undefined'
})
const record: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'native-array-descriptor-test',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [
    { key: 'value', value: optional(number), required: true },
    { key: 'writable', value: optional(boolean), required: true },
    { key: 'enumerable', value: boolean, required: true },
    { key: 'configurable', value: boolean, required: true }
  ]
}
const source = optional({
  kind: 'native-record-ref',
  native: 'gea::NativeDescriptorSnapshot',
  shapeId: record.shapeId,
  ownership: 'shared-refcount'
})
const target = optional(record)
const fixture = () => {
  const layouts = {
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: () => record.fields,
    plainFieldsForShape: () => record.fields
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const fields = record.fields.map((field) => ({
    field,
    reads: (field.key === 'value'
      ? [dynamic, number, undefinedValue]
      : field.key === 'writable'
        ? [boolean, undefinedValue]
        : [boolean]
    ).map((from) => census.dictionaryReadFor(from, field.value)!)
  }))
  assert.ok(fields.every((field) => field.reads.every((read) => read !== null)))
  return { census, fields, layouts }
}

test('a selected descriptor snapshot defers checked data reads and preserves original native field policies', () => {
  const { census, fields, layouts } = fixture()
  const plan = nativeDescriptorSnapshotPlanOf(source, target, fields, true, census.nodeById)
  assert.ok(plan)
  const node = census.nativeDescriptorSnapshotFor('actual-capture', plan)
  assert.ok(node && node.capability.kind === 'static')
  assert.ok(nativeDescriptorSnapshotPlanMatches(node.capability.materializer.nativeDescriptorSnapshot!, census.nodeById))
  const closure = recipeClosureOf([node], census.nodeById)
  assert.ok(plan.dependencies.every((child) => closure.get(child.id) === child))
  assert.deepEqual(nativeFieldViewPlansOf(closure.values()), [node.capability.materializer.nativeDescriptorSnapshot!.nativeFields])
  const site: ConversionSite = {
    conversions: census,
    layouts,
    classes: new Map(),
    captures: emptyCaptureIndex,
    functionFacts: new Map(),
    printerDrift: [],
    owner: 'snapshot-test',
    conversionIsCertified: (id) => closure.has(id)
  }
  const emitted = recipeText(site, node, 'captureOriginalDescriptor()')!
  assert.ok(emitted.includes('makeDescriptorSnapshotViewWithOrigin<'))
  assert.ok(emitted.includes('nativeDescriptorSnapshotRead('))
  assert.equal(emitted.includes('elementAt('), false)
  assert.equal(emitted.includes('unboxDouble('), false, 'the value check runs at desc.value, not during capture')
  assert.equal(emitted.split('captureOriginalDescriptor()').length - 1, 1)
  assert.ok(emitted.includes('if (!gea_snapshot.has_value())'))
})

test('snapshot readers reject copied child objects, synthetic dynamic storage, and incomplete descriptor fields', () => {
  const { census, fields } = fixture()
  assert.equal(nativeDescriptorSnapshotPlanOf(source, target, fields, false, census.nodeById), null)
  assert.equal(nativeDescriptorSnapshotPlanOf(source, target, fields.slice(1), true, census.nodeById), null)
  const copied = fields.map((field, index) =>
    index === 0 ? { ...field, reads: [{ ...field.reads[0]! }, ...field.reads.slice(1)] } : field
  )
  assert.equal(nativeDescriptorSnapshotPlanOf(source, target, copied, true, census.nodeById), null)
  const synthetic = census.nodeFor({ kind: 'dynamic', reason: 'untyped-callable' }, record.fields[0]!.value)
  assert.equal(
    nativeDescriptorSnapshotPlanOf(source, target, [{ ...fields[0]!, reads: [synthetic] }, ...fields.slice(1)], true, census.nodeById),
    null
  )
  const plan = nativeDescriptorSnapshotPlanOf(source, target, fields, true, census.nodeById)!
  assert.equal(nativeDescriptorSnapshotPlanMatches({ ...plan, dependencies: plan.dependencies.slice(1) }, census.nodeById), false)
})

test('copied getter and setter fields retain their opaque native holders without publishing a typed callable reader', () => {
  const { census, fields } = fixture()
  const callable: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: dynamic }
  }
  const accessorFields = ['get', 'set'].map((key) => ({ key, value: optional(callable), required: true }))
  const accessorTarget = optional({ ...record, fields: [...record.fields, ...accessorFields] })
  const retained = accessorFields.map((field) => ({ field, reads: [], retainedAccessor: true as const }))
  const complete = [...fields, ...retained]
  const plan = nativeDescriptorSnapshotPlanOf(source, accessorTarget, complete, true, census.nodeById)
  assert.ok(plan)
  assert.equal(nativeDescriptorSnapshotPlanMatches(plan, census.nodeById), true)
  assert.deepEqual(
    plan.nativeFields.fields.filter((field) => field.key === 'get' || field.key === 'set'),
    accessorFields.map((field) => ({ key: field.key, read: field.value, write: null, descriptorForward: true }))
  )
  const projected = nativeDescriptorSnapshotPlanOf(source, target, fields, true, census.nodeById)
  assert.ok(projected)
  assert.deepEqual(plan.dependencies, projected.dependencies)
  assert.equal(
    nativeDescriptorSnapshotPlanOf(
      source,
      accessorTarget,
      [...fields, ...retained.map(({ retainedAccessor, ...field }) => field)],
      true,
      census.nodeById
    ),
    null
  )
  assert.equal(
    nativeDescriptorSnapshotPlanOf(
      source,
      accessorTarget,
      [{ ...fields[0]!, retainedAccessor: true }, ...complete.slice(1)],
      true,
      census.nodeById
    ),
    null
  )
  assert.equal(
    nativeDescriptorSnapshotPlanOf(
      source,
      accessorTarget,
      [...fields, { ...retained[0]!, reads: [census.nodeFor(callable, accessorFields[0]!.value)] }, retained[1]!],
      true,
      census.nodeById
    ),
    null
  )
})
