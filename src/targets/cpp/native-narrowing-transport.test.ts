import assert from 'node:assert/strict'
import test from 'node:test'
import type { MaterializerContract } from '../../conversion/algebra.js'
import { createConversionNodes, type ConversionCensus } from '../../conversion/nodes.js'
import { defaultRecordLayoutPolicy } from '../../representation/policies.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import type { Representation } from '../../representation/model.js'
import { createCppConversionRegistry } from './conversions.js'
import { alignedValueText, conversionRecipeOf, namedConversionText, type ConversionSite } from './emit-narrowing.js'
import { chainFieldProtocolUnused, nativeSumNarrowingTransports } from './native-narrowing-transport.js'
import { cppTypeOf } from './types.js'
import { unboxedReadText } from './emit-dynamic-properties.js'
import { nativeViewOriginsOf } from '../../conversion/native-view-origins.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const point: Extract<Representation, { kind: 'class-ref' }> = {
  kind: 'class-ref',
  declaration: 'point' as never,
  shapeId: 'point-shape',
  ancestors: [],
  ownership: 'shared-refcount'
}
const child: Representation = { ...point, declaration: 'child' as never, shapeId: 'child-shape', ancestors: [point.declaration] }
const array = (element: Representation): Representation => ({
  kind: 'array-object',
  element,
  ownership: 'shared-refcount',
  extension: null
})
const float32: Representation = { kind: 'typed-array', element: 'float32', buffer: 'array-buffer', ownership: 'shared-refcount' } as never
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})
const absent = (payload: Representation): Representation => sum({ kind: 'undefined' }, { kind: 'null' }, payload)
/** Each render goes through the printer's census-backed entry point, as `emitConvert`'s does. */
const siteOf = (conversions: ConversionCensus): ConversionSite =>
  ({
    conversions,
    printerDrift: [],
    owner: 'native-narrowing-transport-test',
    layouts: defaultRecordLayoutPolicy,
    classes: new Map(),
    captures: {}
  }) as unknown as ConversionSite

const materializerOf = (node: ConversionNode): MaterializerContract | null =>
  node.capability.kind === 'atom' || node.capability.kind === 'static' || node.capability.kind === 'class-family'
    ? node.capability.materializer
    : null
const assertNative = (node: ConversionNode, native: boolean): void => {
  const materializer = materializerOf(node)
  assert.ok(materializer, node.id)
  assert.equal(materializer.allocates, false, node.id)
  assert.equal(materializer.nativeFieldProtocol === 'unused' && materializer.nativePayloadTransport === 'preserved', native, node.id)
}

test('a certified named conversion is planned while a printer pair lookup still records drift', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: number }
  const node = conversions.nodeFor(number, optional)
  const site: ConversionSite = { ...siteOf(conversions), conversionIsCertified: (id) => id === node.id }
  const named = namedConversionText(site, 'explicit-convert', node, 'input')
  assert.ok(named)
  assert.equal(site.printerDrift.length, 0)
  assert.equal(alignedValueText(site, 'printer-supplied-convert', number, optional, 'input'), named)
  assert.equal(site.printerDrift.length, 1)
  assert.equal(site.printerDrift[0]?.site, 'printer-supplied-convert')
})

test('a named conversion without an exact certificate remains printer drift', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: number }
  const node = conversions.nodeFor(number, optional)
  const site = siteOf(conversions)
  assert.ok(namedConversionText(site, 'uncertified-convert', node, 'input'))
  assert.equal(site.printerDrift.length, 1)
  assert.equal(site.printerDrift[0]?.site, 'uncertified-convert')
})

test('a tag-selected load out of a uniform-like sum states native transport when every candidate leaf does', () => {
  // A shader-uniform-like value: absences around an inner sum whose array arms
  // cannot be proven disjoint, so the sealed selection planner declines.
  const uniform = absent(sum(array(number), array(point), point, number, { kind: 'scalar', domain: 'boolean' }, float32))
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const load = conversions.nodeFor(uniform, array(number))
  assert.ok(load.capability.kind === 'atom')
  assert.equal(load.capability.materializer.id, 'gea::TaggedUnion::get')
  assert.equal(load.capability.materializer.nativeSelection, undefined)
  assertNative(load, true)
  // The emitted load reads the discriminant and the arm, and routes the dead
  // absences to the unreachable throw; it never boxes or rebuilds.
  const emitted = alignedValueText(siteOf(conversions), 'uniform-load', uniform, array(number), 'uniformOnce')
  assert.ok(emitted)
  for (const rebuild of ['Value::box(gea::Value::Tag::Object', 'unbox', 'OwnField', 'recast'])
    assert.ok(!emitted.includes(rebuild), rebuild)
  assert.ok(emitted.includes('get<2>().get<0>()'))
})

test('the absence the renderer spells as unreachable reads nothing', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(conversionRecipeOf({ kind: 'undefined' }, array(number))?.id, 'unreachable-value')
  assertNative(conversions.nodeFor({ kind: 'undefined' }, array(number)), true)
})

test('dynamic absence reads use the runtime tag-only loaders', () => {
  assert.equal(
    unboxedReadText({ kind: 'undefined' }, 'read', 'dynamic undefined read'),
    'gea::detail::unboxUndefinedValue(read, "dynamic undefined read")'
  )
  assert.equal(unboxedReadText({ kind: 'null' }, 'read', 'dynamic null read'), 'gea::detail::unboxNullValue(read, "dynamic null read")')
  assert.ok(!unboxedReadText({ kind: 'undefined' }, 'read', 'dynamic undefined read').includes('unboxAs'))
  assert.ok(!unboxedReadText({ kind: 'null' }, 'read', 'dynamic null read').includes('unboxAs'))
})

test('a narrowed presence load composes the upcast it performs', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: child }
  const node = conversions.nodeFor(optional, point)
  assert.ok(node.capability.kind === 'static')
  assert.equal(node.capability.materializer.id, 'chain:narrowed-load')
  assertNative(node, true)
  assert.equal(alignedValueText(siteOf(conversions), 'presence-load', optional, point, 'held'), `${cppTypeOf(point)}((*held))`)
})

test('class casts and the empty handle keep the same pointee', () => {
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assertNative(conversions.nodeFor(point, child), true)
  assertNative(conversions.nodeFor(child, point), true)
  assertNative(conversions.nodeFor({ kind: 'null' }, point), true)
  assert.ok(alignedValueText(siteOf(conversions), 'downcast', point, child, 'base')?.includes('downcastClassRef'))
})

test('a candidate leaf that reconstructs or boxes withholds the composite contract', () => {
  const registry = createCppConversionRegistry()
  // A record read as another shape with the same fields is a rebuild: the
  // renderer would emit it as a candidate, so the discriminant alone proves
  // nothing about the payload.
  const record = (shapeId: string): Representation => ({
    kind: 'record',
    shapeId,
    ownership: 'shared-refcount',
    fields: [{ key: 'x', value: number, required: true }],
    accessors: []
  })
  assert.equal(conversionRecipeOf(record('a'), record('b'))?.id, 'record-recast')
  assert.equal(nativeSumNarrowingTransports(registry, absent(sum(record('a'), record('b'))), record('b')), false)
  const conversions = createConversionNodes({ registry, nodes: new Map() })
  const withheld = materializerOf(conversions.nodeFor(absent(sum(record('a'), record('b'))), record('b')))
  assert.equal(withheld?.nativePayloadTransport, undefined)
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.equal(nativeSumNarrowingTransports(registry, absent(sum(dynamic, number)), number), false)
  assert.equal(nativeSumNarrowingTransports(registry, number, number), false, 'only a sum composes')
  assert.equal(nativeSumNarrowingTransports(registry, absent(sum(array(number), point)), array(number)), true)
})

test('a narrowed tuple element keeps an unchanged callable and named record payload at their selected native tags', () => {
  const context: Representation = { kind: 'native-record-ref', shapeId: 'context', native: null, ownership: 'shared-refcount' }
  const events: Representation = { ...context, shapeId: 'events' }
  const createEvents: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: events }
  }
  const source = sum(number, context, events, createEvents)
  const target = sum(createEvents, context)
  const registry = createCppConversionRegistry()
  assert.equal(nativeSumNarrowingTransports(registry, source, target), true)
  const conversions = createConversionNodes({ registry, nodes: new Map() })
  const selected = conversions.nodeFor(source, target)
  assertNative(selected, true)
  const site = siteOf(conversions)
  const rendered = alignedValueText(site, 'rest-tuple-selected-element', source, target, 'elementOnce')
  assert.ok(rendered)
  assert.equal(site.printerDrift.length, 1)
  assert.equal(site.printerDrift[0]?.kind, 'converted')
  for (const rebuilding of ['adaptSource', 'Value::box', 'OwnField', 'rememberViewOrigin'])
    assert.ok(!rendered.includes(rebuilding), rebuilding)
})

test('a sum that changes a callable convention still withholds the native payload identity contract', () => {
  const sourceCallable: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [],
      restFrom: null,
      result: number
    }
  }
  const targetCallable: Representation = {
    ...sourceCallable,
    abi: { ...sourceCallable.abi, parameters: [{ value: number, ownership: 'owned', passing: 'by-value' }] }
  }
  assert.equal(conversionRecipeOf(sourceCallable, targetCallable)?.renders, true)
  assert.equal(nativeSumNarrowingTransports(createCppConversionRegistry(), sum(number, sourceCallable), targetCallable), false)
})

test('an optional wrapped around a converted payload reads fields exactly as its inner conversion does', () => {
  const registry = createCppConversionRegistry()
  const conversions = createConversionNodes({ registry, nodes: new Map() })
  const record = (shapeId: string, fields: Extract<Representation, { kind: 'record' }>['fields']): Representation => ({
    kind: 'record',
    shapeId,
    ownership: 'shared-refcount',
    fields,
    accessors: []
  })
  const optional = (payload: Representation): Representation => ({ kind: 'optional', absence: 'undefined', payload })
  // A `clone({})` call: an empty literal read as optional options.
  const empty = record('empty', [])
  const options = record('options', [{ key: 'x', value: optional(number), required: false }])
  assert.equal(conversionRecipeOf(empty, optional(options))?.id, 'optional-wrap-converted')
  const inner = conversions.nodeFor(empty, options)
  assert.ok(inner.capability.kind === 'atom')
  assert.equal(inner.capability.materializer.id, 'gea::record::recast')
  assert.equal(inner.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(inner.capability.materializer.residualReflection, undefined)
  const wrapped = conversions.nodeFor(empty, optional(options))
  assert.ok(wrapped.capability.kind === 'static')
  assert.equal(wrapped.capability.materializer.id, 'chain:optional-wrap-converted')
  assert.equal(wrapped.capability.materializer.nativeFieldProtocol, 'unused')
  assert.deepEqual(wrapped.capability.materializer.residualReflection, inner.capability.materializer.residualReflection)
  const view = wrapped.capability.materializer.recordView
  assert.ok(view, 'the wrapper seals the reference payload view')
  assert.equal(view.view.kind, 'optional')
  if (view.view.kind === 'optional') {
    assert.equal(view.view.payload.kind, 'fields')
    if (view.view.payload.kind === 'fields')
      assert.deepEqual(
        view.view.payload.fields.map(({ read }) => read.kind),
        ['native-descriptor']
      )
  }
  assert.deepEqual(wrapped.capability.materializer.dependencies, [...view.leaves.values()])
  assert.equal(view.leaves.size, 0, 'allocation forwards the descriptor without licensing a field carrier or a dynamic read')
  assert.deepEqual(nativeViewOriginsOf([wrapped], conversions.nodeById), [{ source: empty, target: options }])
  // The wrap still builds the recast record: it states no payload transport.
  assert.equal(wrapped.capability.materializer.allocates, true)
  assert.equal(wrapped.capability.materializer.nativePayloadTransport, undefined)
  const emitted = alignedValueText(siteOf(conversions), 'optional-wrap', empty, optional(options), 'literal')
  assert.ok(emitted)
  assert.ok(!emitted.includes('Value::box'))
  // The ordinary-key delegation to the source's own native field protocol
  // lives in the runtime's live-view source helpers (`gea_readOwnFieldNative`
  // / `gea_writeOwnFieldNative`, aborting on a source with no such protocol).
  assert.ok(emitted.includes('gea::nativeLiveViewSourceRead<true>('), 'chained views retain exact native descriptor delegation')
  assert.ok(emitted.includes('gea::nativeLiveViewSourceWrite('))
  assert.ok(emitted.includes('nativeObjectDataReadNative'), 'the callback forwards exact native descriptor reads at Get time')
  assert.ok(!emitted.includes('nativeSidecarGetText'))
  assert.ok(!emitted.includes('gea_sidecar_read_'), 'allocation does not sample sidecar values or their presence')
  for (const changedOwnershipOrRead of ['rememberViewOrigin']) assert.ok(!emitted.includes(changedOwnershipOrRead), changedOwnershipOrRead)
  assert.ok(emitted.includes('gea::record::makeLiveViewWithOrigin<'), 'the view payload retains its source and lazy read/write routes')
  assert.equal(wrapped.capability.materializer.nativeFieldViewProtocol, 'live')
  // A payload that boxes keeps the wrap's field protocol unstated.
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.equal(conversionRecipeOf(number, optional(dynamic))?.id, 'optional-wrap-converted')
  const boxed = conversions.nodeFor(number, optional(dynamic))
  assert.ok(boxed.capability.kind === 'static')
  assert.equal(boxed.capability.materializer.nativeFieldProtocol, undefined)
  assert.equal(chainFieldProtocolUnused(registry, number, dynamic), false)
  assert.equal(chainFieldProtocolUnused(registry, number, number), true, 'the same carrier reads nothing')
})
