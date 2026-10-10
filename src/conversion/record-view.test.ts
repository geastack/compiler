import assert from 'node:assert/strict'
import test from 'node:test'
import { representationKey, type Representation } from '../representation/model.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import type { ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { certifiedRecordViewText } from '../targets/cpp/emit-record-view.js'
import { certifiedRecordViewPlan, structuralConversionKey } from './structural-plan.js'
import { cppTypeOf } from '../targets/cpp/types.js'
import { tailFieldsOf } from '../targets/cpp/records.js'
import { structuralRecordViewPlan, type PairConvertible } from './record-view.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { StructuralTypeId } from '../identity/ids.js'

/**
 * `Object.getOwnPropertyDescriptor(strings, 'raw')!` (the shape behind
 * `template-strings-array-identity.ts`/`-structural.ts`): the call's carrier
 * is `optional(record#<per-overload PropertyDescriptor>, undefined)`, the
 * `!`-asserted binding's slot is the canonical, non-optional
 * `native-record-ref(<binding's own shape>)`, and the two shapes are
 * DIFFERENT interned records with the same fields -- so neither the
 * optional-to-optional peel nor the present-optional unwrap in
 * `targets/cpp/conversions.ts`'s `narrowing` (keyed on the payload's shape
 * already equalling the target's) has anywhere to install.
 */

const numberField = (): Representation => ({ kind: 'scalar', domain: 'number' })

const sourcePayloadRecord: Representation = {
  kind: 'record',
  shapeId: 'per-overload-property-descriptor',
  fields: [{ key: 'value', value: numberField(), required: true }],
  accessors: [],
  ownership: 'shared-refcount'
}

const source: Representation = { kind: 'optional', payload: sourcePayloadRecord, absence: 'undefined' }

const target: Representation = {
  kind: 'native-record-ref',
  shapeId: 'canonical-property-descriptor',
  ownership: 'shared-refcount',
  native: null
}

const layoutsFor = (fields: readonly { key: string; value: Representation; required: boolean }[]): RecordLayoutPolicy => ({
  indexesForShape: () => [],
  accessorsForShape: () => [],
  forShape: (shapeId) => (shapeId === target.shapeId ? fields : null)
})

const structurallyCompatibleLayouts = layoutsFor([{ key: 'value', value: numberField(), required: true }])

/** The registry's own pair answer, stood in for by shape identity: exactly what the plan itself does not decide. */
const identityConvertible: PairConvertible = (a, b) => representationKey(a) === representationKey(b)

const renderedView = (from: Representation, into: Representation, layouts: RecordLayoutPolicy, operand = 'gea_source'): string => {
  const plan = certifiedRecordViewPlan(layouts, from, into, (source, target) =>
    identityConvertible(source, target)
      ? { id: structuralConversionKey(source, target), source, target, capability: { kind: 'identity' } }
      : null
  )
  assert.ok(plan)
  const ctx = {
    layouts,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) },
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  const text = certifiedRecordViewText(ctx, plan, operand)
  assert.ok(text)
  return text
}

test('an asserted optional payload views onto a differently-shaped non-optional record target', () => {
  const plan = structuralRecordViewPlan(structurallyCompatibleLayouts, source, target, identityConvertible)
  assert.ok(plan !== null)
  assert.equal(plan?.kind, 'assert')
  if (plan?.kind !== 'assert') return
  assert.equal(plan.target, target)
  assert.equal(plan.payload.kind, 'fields')
})

test('an asserted optional payload with no structural home in the target still refuses', () => {
  const incompatibleLayouts = layoutsFor([{ key: 'value', value: { kind: 'string' }, required: true }])
  const plan = structuralRecordViewPlan(incompatibleLayouts, source, target, identityConvertible)
  assert.equal(plan, null)
})

test('an optional source viewed onto an optional target still takes the existing peeling plan, not the new one', () => {
  const optionalTarget: Representation = { kind: 'optional', payload: target, absence: 'undefined' }
  const plan = structuralRecordViewPlan(structurallyCompatibleLayouts, source, optionalTarget, identityConvertible)
  assert.equal(plan?.kind, 'optional')
})

test('the asserting unwrap renders a checked throw on absence, never a bare dereference', () => {
  const ctx = {
    layouts: structurallyCompatibleLayouts,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) },
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  const plan = certifiedRecordViewPlan(structurallyCompatibleLayouts, source, target, (from, into) =>
    identityConvertible(from, into)
      ? { id: structuralConversionKey(from, into), source: from, target: into, capability: { kind: 'identity' } }
      : null
  )
  assert.ok(plan)
  const text = certifiedRecordViewText(ctx, plan, 'gea_v0')
  assert.ok(text !== null)
  const rendered = text ?? ''
  // The presence test and the throwing fallback both name the SAME target
  // type -- `x!` is erased at runtime, so a genuinely-absent value must throw
  // exactly what a later member read of `undefined` would in JS, not fall
  // through to an unchecked `*gea_v0` (undefined behaviour on absence).
  assert.ok(rendered.includes('gea_v0.has_value()'))
  assert.ok(rendered.includes(`gea::host::throwGetPropertyOfNullish<${cppTypeOf(target)}>()`))
  assert.ok(rendered.includes('(*gea_v0)'))
})

test('an optional source enters a sum carrying its absence as an arm: absence to that arm, payload to its one present home', () => {
  // `requireTextureImageRecord(image)`: `optional(record)` into `undefined |
  // null | record'`, where the record needs a view to become the present arm.
  const sum: Extract<Representation, { kind: 'tagged-union' }> = {
    kind: 'tagged-union',
    arms: [
      { tag: 'undefined', value: { kind: 'undefined' }, semanticType: 'u' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'null', value: { kind: 'null' }, semanticType: 'n' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'present', value: target, semanticType: 'p' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  const plan = structuralRecordViewPlan(structurallyCompatibleLayouts, source, sum, identityConvertible)
  assert.equal(plan?.kind, 'arm')
  if (plan?.kind !== 'arm') return
  assert.equal(plan.index, 2)
  assert.equal(plan.absentIndex, 0)
  assert.equal(plan.source, sourcePayloadRecord)
  assert.equal(plan.payload?.kind, 'fields')
  const rendered = renderedView(source, sum, structurallyCompatibleLayouts, 'gea_v0')
  assert.ok(rendered.includes('gea_v0.has_value()'))
  assert.ok(rendered.includes('::ofArm<0>('))
  assert.ok(rendered.includes('::ofArm<2>('))
  const withoutAbsence: Representation = { kind: 'tagged-union', arms: sum.arms.slice(1) }
  assert.equal(structuralRecordViewPlan(structurallyCompatibleLayouts, source, withoutAbsence, identityConvertible), null)
})

test('native source handles attach their origin within the view allocation and evaluate the source once', () => {
  const nativeClass: Representation = {
    kind: 'class-ref',
    declaration: 'native-origin' as never,
    shapeId: 'native-origin',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const fields = [{ key: 'value', value: numberField(), required: true }]
  const layouts: RecordLayoutPolicy = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => fields }
  for (const from of [nativeClass, sourcePayloadRecord]) {
    const text = renderedView(from, target, layouts, 'produceSource()')
    assert.equal(text.split('produceSource()').length - 1, 1)
    assert.ok(text.includes('gea::record::makeLiveViewWithOrigin<'))
    assert.ok(text.includes('gea_readOwnFieldNative'))
    assert.ok(text.includes('gea_writeOwnFieldNative'))
    assert.ok(!text.includes('gea_source->value'))
    assert.ok(!text.includes('rememberViewOrigin'))
    assert.ok(!text.includes('gea::makeRef<'))
    assert.ok(!text.includes('Value::box'))
  }
})

test('value-record copies keep their ordinary allocation and owned targets keep aggregate construction', () => {
  const valueSource: Representation = { ...sourcePayloadRecord, ownership: 'owned' }
  const text = renderedView(valueSource, target, structurallyCompatibleLayouts)
  assert.ok(text.includes('gea::makeRef<'))
  assert.ok(!text.includes('makeViewWithOrigin'))
  const valueTarget: Representation = { ...sourcePayloadRecord, shapeId: 'owned-view', ownership: 'owned' }
  const owned = renderedView(sourcePayloadRecord, valueTarget, structurallyCompatibleLayouts)
  assert.ok(!owned.includes('makeRef<'))
  assert.ok(!owned.includes('makeViewWithOrigin'))
})

test('a tailed source is read lazily through its native field protocol without copying its tail', () => {
  const value: Representation = { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }
  const fields = Array.from({ length: 33 }, (_, index) => ({ key: `option${index}`, value, required: false }))
  assert.equal(tailFieldsOf({ fields }).size, fields.length)
  const from: Representation = { ...sourcePayloadRecord, shapeId: 'large-source', fields }
  const text = renderedView(from, target, { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => fields })
  assert.ok(text.includes('gea::record::makeLiveViewWithOrigin<'))
  assert.ok(text.includes('gea_readOwnFieldNative'))
  assert.ok(text.includes('gea_writeOwnFieldNative'))
  assert.ok(!text.includes('gea_tail'))
  assert.ok(!text.includes('gea_source->option'))
  assert.ok(!text.includes('rememberViewOrigin'))
})

test('an absent optional source slot reads its undefined carrier without treating protocol mismatch as absence', () => {
  const value: Representation = { kind: 'optional', payload: numberField(), absence: 'undefined' }
  const fields = [{ key: 'value', value, required: false }]
  const from: Representation = { ...sourcePayloadRecord, fields }
  const text = renderedView(from, target, layoutsFor(fields))
  assert.ok(text.includes('makeLiveViewWithOrigin'))
  assert.ok(text.includes('gea_ownFieldPresent'))
  assert.ok(text.includes('if (!gea_origin_present) return'))
  assert.ok(text.indexOf('gea_ownFieldPresent') < text.indexOf('gea_readOwnFieldNative'))
  assert.ok(text.includes('a live native field has no source read protocol'))
})

test('an added key forwards a native descriptor without inventing storage from its public field', () => {
  const from: Extract<Representation, { kind: 'record' }> = { ...sourcePayloadRecord, kind: 'record', accessors: [], fields: [] }
  const into: Extract<Representation, { kind: 'record' }> = {
    ...from,
    shapeId: 'sidecar-target',
    fields: [{ key: 'extra', value: { kind: 'optional', payload: { kind: 'string' }, absence: 'undefined' }, required: false }]
  }
  const layouts: RecordLayoutPolicy = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const node = conversions.nodeFor(from, into)
  assert.ok('materializer' in node.capability)
  const plan = node.capability.materializer.recordView
  assert.ok(plan)
  const site = {
    layouts,
    conversions,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) },
    printerDrift: [],
    owner: 'test'
  } as unknown as ConversionSite
  const rendered = certifiedRecordViewText(site, plan, 'produceSource()')
  assert.ok(rendered)
  assert.equal(rendered.split('produceSource()').length - 1, 1)
  assert.ok(rendered.includes('makeLiveViewWithOrigin'))
  assert.ok(rendered.includes('nativeObjectDataReadNative'))
  assert.ok(!rendered.includes('nativeSidecarGetText'))
  assert.ok(!rendered.includes('nativeDynamicSet'))
  assert.ok(!rendered.includes('Value::box'))
  assert.ok(!rendered.includes('gea::makeRef<'))
  assert.equal(plan.leaves.size, 0)
  assert.equal(plan.view.kind, 'fields')
  if (plan.view.kind === 'fields') {
    assert.equal(plan.view.fields[0]!.read.kind, 'native-descriptor')
    assert.equal(plan.fieldViews?.get(plan.view)?.fields[0]!.descriptorForward, true)
  }
})
