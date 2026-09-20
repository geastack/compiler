import assert from 'node:assert/strict'
import test from 'node:test'
import type { MaterializerContract } from '../../conversion/algebra.js'
import { createConversionNodes, type ConversionCensus } from '../../conversion/nodes.js'
import { defaultRecordLayoutPolicy } from '../../representation/policies.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import type { Representation } from '../../representation/model.js'
import { createCppConversionRegistry } from './conversions.js'
import { alignedValueText, conversionRecipeOf, type ConversionSite } from './emit-narrowing.js'
import { chainFieldProtocolUnused, nativeSumNarrowingTransports } from './native-narrowing-transport.js'
import { cppTypeOf } from './types.js'
import { unboxedReadText } from './emit-dynamic-properties.js'

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

test('a tag-selected load out of a uniform-like sum states native transport when every candidate leaf does', () => {
  // Three's uniform value: absences around an inner sum whose array arms
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
  // BufferGeometry's `clone({})`: an empty literal read as optional options.
  const empty = record('empty', [])
  const options = record('options', [{ key: 'x', value: optional(number), required: false }])
  assert.equal(conversionRecipeOf(empty, optional(options))?.id, 'optional-wrap-converted')
  const inner = conversions.nodeFor(empty, options)
  assert.ok(inner.capability.kind === 'atom')
  assert.equal(inner.capability.materializer.id, 'gea::record::recast')
  assert.equal(inner.capability.materializer.nativeFieldProtocol, 'unused')
  const wrapped = conversions.nodeFor(empty, optional(options))
  assert.ok(wrapped.capability.kind === 'static')
  assert.equal(wrapped.capability.materializer.id, 'chain:optional-wrap-converted')
  assert.equal(wrapped.capability.materializer.nativeFieldProtocol, 'unused')
  // The wrap still builds the recast record: it states no payload transport.
  assert.equal(wrapped.capability.materializer.allocates, true)
  assert.equal(wrapped.capability.materializer.nativePayloadTransport, undefined)
  const emitted = alignedValueText(siteOf(conversions), 'optional-wrap', empty, optional(options), 'literal')
  assert.ok(emitted)
  for (const rebuild of ['Value::box', 'unbox', 'OwnField']) assert.ok(!emitted.includes(rebuild), rebuild)
  // A payload that boxes keeps the wrap's field protocol unstated.
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  assert.equal(conversionRecipeOf(number, optional(dynamic))?.id, 'optional-wrap-converted')
  const boxed = conversions.nodeFor(number, optional(dynamic))
  assert.ok(boxed.capability.kind === 'static')
  assert.equal(boxed.capability.materializer.nativeFieldProtocol, undefined)
  assert.equal(chainFieldProtocolUnused(registry, number, dynamic), false)
  assert.equal(chainFieldProtocolUnused(registry, number, number), true, 'the same carrier reads nothing')
})
