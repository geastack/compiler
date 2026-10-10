import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from './algebra.js'
import { dynamicWrapperDependenciesOf, dynamicWrapperPlanMatches, dynamicWrapperPlanOf } from './dynamic-wrapper.js'
import { createConversionNodes } from './nodes.js'
import { recipeClosureOf } from './recipe-closure.js'
import { nativeFieldViewPlansOf } from './native-field-view.js'
import type { Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { createStructuralTypeTable } from '../semantics/model/structural-type-table.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const record: Extract<Representation, { kind: 'record' }> = {
  kind: 'record',
  shapeId: 'dynamic-wrapper-record',
  ownership: 'shared-refcount',
  accessors: [],
  fields: [{ key: 'name', value: { kind: 'string' }, required: true }]
}
const layouts = {
  indexesForShape: () => [],
  accessorsForShape: () => [],
  forShape: () => record.fields,
  plainFieldsForShape: () => record.fields
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
    owner: 'dynamic-wrapper-test',
    conversionIsCertified: (id) => closure.has(id)
  }
}

test('an existing dynamic arm retains its payload without observing a different structural alternative', () => {
  for (const values of [
    [dynamic, record],
    [record, dynamic]
  ]) {
    const union: Representation = {
      kind: 'tagged-union',
      arms: values.map((value, index) => ({
        tag: String(index),
        value,
        semanticType: `payload-${index}` as never,
        runtimeDiscriminator: { kind: 'carrier' }
      }))
    }
    for (const target of [union, { kind: 'optional', payload: union, absence: 'undefined' } as Representation]) {
      const census = censusOf()
      const node = census.nodeFor(dynamic, target)
      assert.ok(node.capability.kind === 'atom')
      assert.equal(node.capability.materializer.allocates, false)
      assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
      assert.equal(recipeClosureOf([node], census.nodeById).size, 1)
      const emitted = recipeText(siteOf(census, node), node, 'readValueOnce()')!
      assert.match(emitted, new RegExp(`::ofArm<${values.indexOf(dynamic)}>`))
      assert.equal(emitted.split('readValueOnce()').length - 1, 1)
      assert.doesNotMatch(emitted, /Value::box|makeDocumentView|dynamicRecordField|unbox/)
    }
  }
})

test('a claimed sum injection needs the exact installed payload contract', () => {
  const target: Representation = {
    kind: 'tagged-union',
    arms: [dynamic, record].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `payload-${index}` as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const registry = createCppConversionRegistry(layouts)
  const original = registry.widening(dynamic, target)!
  const { nativeFieldProtocol: omittedProtocol, ...reflective } = original.materializer
  assert.equal(omittedProtocol, 'unused')
  for (const materializer of [
    { ...original.materializer, domain: 'another-carrier-pair' },
    reflective,
    { ...original.materializer, allocates: true }
  ]) {
    const census = createConversionNodes({
      nodes: new Map(),
      registry: { ...registry, widening: () => ({ ...original, materializer }) }
    })
    assert.equal(census.nodeFor(dynamic, target).capability.kind, 'never')
  }
  const erased: Representation = { kind: 'dynamic', reason: 'untyped-callable' }
  const erasedTarget = { ...target, arms: target.arms.map((arm) => (arm.value === dynamic ? { ...arm, value: erased } : arm)) }
  assert.equal(censusOf().nodeFor(erased, erasedTarget).capability.kind, 'never')
})

test('a dynamic promise cites its checked live field reader for each future completion', () => {
  const census = censusOf()
  const target: Representation = { kind: 'promise', value: record }
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'static')
  const plan = node.capability.materializer.dynamicWrapper
  assert.ok(plan?.kind === 'promise')
  assert.equal(plan.payload, census.nodeFor(dynamic, record))
  assert.deepEqual(node.capability.materializer.dependencies, [plan.payload])
  const closure = recipeClosureOf([node], census.nodeById)
  assert.ok(nativeFieldViewPlansOf(closure.values()).some((entry) => entry.target === record))
  const emitted = recipeText(siteOf(census, node), node, 'readPromise()')!
  assert.ok(emitted.includes('promiseFromDynamic<'))
  assert.ok(emitted.includes('makeDocumentViewWithOrigin<'))
  assert.ok(emitted.includes('unboxDynamicDictionary'))
  assert.equal(emitted.split('readPromise()').length - 1, 1)
  assert.equal(emitted.includes('adoptProduct'), false)
  assert.equal(emitted.includes('unboxRef<'), false)
})

test('an optional promise owns only its declared absence and retains the canonical completion reader', () => {
  const census = censusOf()
  const promise: Representation = { kind: 'promise', value: record }
  const target: Representation = { kind: 'optional', payload: promise, absence: 'null' }
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'static')
  const plan = node.capability.materializer.dynamicWrapper
  assert.ok(plan?.kind === 'optional')
  assert.equal(plan.payload, census.nodeFor(dynamic, promise))
  const emitted = recipeText(siteOf(census, node), node, 'readOptionalPromise()')!
  assert.ok(emitted.includes('Value::Tag::Null'))
  assert.equal(emitted.includes('Value::Tag::Undefined ?'), false)
  assert.ok(emitted.includes('promiseFromDynamic<'))
  assert.ok(emitted.includes('makeDocumentViewWithOrigin<'))
  assert.equal(emitted.split('readOptionalPromise()').length - 1, 1)
  assert.equal(
    dynamicWrapperPlanMatches({ ...plan, payload: { ...plan.payload } }, dynamic, target, census.nodeById),
    false,
    'a copied child with the same id is not a canonical citation'
  )
  assert.equal(dynamicWrapperPlanMatches(plan, dynamic, promise, census.nodeById), false)
})

test('a discriminated dynamic union selects installed classifiers then runs each exact native field reader', () => {
  const census = censusOf()
  const table = createStructuralTypeTable()
  const name = table.intern({ kind: 'primitive', primitive: 'string' })
  const row = (text: string) => {
    const kind = table.intern({ kind: 'literal', primitive: 'string', text })
    return table.intern({
      kind: 'object',
      members: [
        { key: { kind: 'string', value: 'kind' }, type: kind, optional: false, readonly: false, accessor: null },
        { key: { kind: 'string', value: 'name' }, type: name, optional: false, readonly: false, accessor: null }
      ],
      index: [],
      membersDropped: false
    })
  }
  const leftType = row('left')
  const rightType = row('right')
  const fields = [{ key: 'kind', value: { kind: 'string' } as Representation, required: true }, ...record.fields]
  const left = { ...record, shapeId: leftType, fields }
  const right = { ...record, shapeId: rightType, fields }
  const target: Extract<Representation, { kind: 'tagged-union' }> = {
    kind: 'tagged-union',
    arms: [
      {
        tag: 'left',
        value: left,
        semanticType: leftType,
        runtimeDiscriminator: { kind: 'record-literal', key: 'kind', primitive: 'string', text: 'left' }
      },
      {
        tag: 'right',
        value: right,
        semanticType: rightType,
        runtimeDiscriminator: { kind: 'record-literal', key: 'kind', primitive: 'string', text: 'right' }
      }
    ]
  }
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'static')
  const plan = node.capability.materializer.dynamicWrapper
  assert.ok(plan?.kind === 'union')
  assert.deepEqual(
    plan.arms.map((arm) => arm.conversion),
    [census.nodeFor(dynamic, left), census.nodeFor(dynamic, right)]
  )
  assert.deepEqual(dynamicWrapperDependenciesOf(plan), node.capability.materializer.dependencies)
  assert.ok(plan.arms.every((arm) => arm.classifier.id === 'gea::detail::dynamicRecordDiscriminator'))
  const emitted = recipeText(siteOf(census, node), node, 'readUnion()')!
  assert.ok(emitted.includes('dynamicRecordDiscriminator'))
  assert.ok(emitted.includes('::ofArm<0>'))
  assert.ok(emitted.includes('::ofArm<1>'))
  assert.ok(emitted.includes('a dynamic value admitted by no union arm'))
  assert.ok(emitted.includes('makeDocumentViewWithOrigin<'))
  assert.equal(emitted.split('readUnion()').length - 1, 1)
  assert.equal(emitted.includes('dynamicRecordField'), false, 'classification inspects only inert own data descriptors')
  const overlapping = {
    ...target,
    arms: target.arms.map((arm) => ({ ...arm, runtimeDiscriminator: target.arms[0]!.runtimeDiscriminator }))
  }
  assert.equal(census.nodeFor(dynamic, overlapping).capability.kind, 'never')
})

test('future dynamic wrapper readers reject an earlier source guard and synthetic callable erasure', () => {
  const census = censusOf()
  const target: Representation = { kind: 'promise', value: record }
  const installed = createCppConversionRegistry(layouts).dynamicPromiseAdoptionMaterializer(target)!
  const guarded: ConversionNode = {
    id: 'earlier-guard',
    source: dynamic,
    target: record,
    capability: {
      kind: 'static',
      materializer: { id: 'earlier-guard', domain: 'earlier-guard', allocates: false, requiresSourceGuard: true }
    }
  }
  assert.equal(
    dynamicWrapperPlanOf(
      dynamic,
      target,
      { kind: 'atom', ...installed },
      () => guarded,
      () => guarded
    ),
    null
  )
  assert.equal(census.nodeFor({ kind: 'dynamic', reason: 'untyped-callable' }, target).capability.kind, 'never')
  const array: Representation = { kind: 'array-object', element: record, ownership: 'shared-refcount', extension: null }
  assert.equal(
    census.nodeFor({ kind: 'dynamic', reason: 'untyped-callable' }, array).capability.kind,
    'never',
    'an array callback cannot turn synthetic callable erasure into declared-any entry storage'
  )
})

test('a dynamic union retains the selected array classifier and rejects overlapping raw Array<Value> alternatives', () => {
  const census = censusOf()
  const table = createStructuralTypeTable()
  const numberType = table.intern({ kind: 'primitive', primitive: 'number' })
  const arrayType = table.intern({ kind: 'array', element: numberType, readonly: false, extension: [] })
  const stringType = table.intern({ kind: 'primitive', primitive: 'string' })
  const array: Representation = {
    kind: 'array-object',
    element: { kind: 'scalar', domain: 'number' },
    ownership: 'shared-refcount',
    extension: null
  }
  const target: Extract<Representation, { kind: 'tagged-union' }> = {
    kind: 'tagged-union',
    arms: [
      { tag: 'array', value: array, semanticType: arrayType, runtimeDiscriminator: { kind: 'carrier' } },
      { tag: 'string', value: { kind: 'string' }, semanticType: stringType, runtimeDiscriminator: { kind: 'carrier' } }
    ]
  }
  const node = census.nodeFor(dynamic, target)
  assert.ok(node.capability.kind === 'static')
  const plan = node.capability.materializer.dynamicWrapper
  assert.ok(plan?.kind === 'union')
  const child = census.nodeFor(dynamic, array)
  assert.ok(child.capability.kind === 'atom')
  assert.equal(plan.arms[0]?.classifier, child.capability.classifier)
  const emitted = recipeText(siteOf(census, node), node, 'readArrayOrString()')!
  assert.ok(emitted.includes('nativeArrayViewAccepts<'))
  assert.ok(emitted.includes('checkedNativeArrayView<'))
  assert.ok(emitted.includes('::ofArm<0>'))
  assert.equal(emitted.split('readArrayOrString()').length - 1, 1)
  const stringArray: Representation = { ...array, element: { kind: 'string' } }
  const stringArrayType = table.intern({ kind: 'array', element: stringType, readonly: false, extension: [] })
  const overlapping = {
    ...target,
    arms: [
      target.arms[0]!,
      { tag: 'strings', value: stringArray, semanticType: stringArrayType, runtimeDiscriminator: { kind: 'carrier' as const } }
    ]
  }
  // Both typed alternatives share the raw Array<Value> source domain, so a
  // classifier alone cannot pick one. Each arm admits its own exact native
  // payload first; a raw Array<Value> is then selected by its elements, and one
  // no arm admits is a TypeError -- never an unchecked first-arm load.
  const overlappingNode = census.nodeFor(dynamic, overlapping)
  assert.ok(overlappingNode.capability.kind === 'static')
  const overlappingPlan = overlappingNode.capability.materializer.dynamicWrapper
  assert.ok(overlappingPlan?.kind === 'union')
  assert.deepEqual(
    overlappingPlan.arms.map((arm) => arm.byElements),
    [true, true]
  )
  const selected = recipeText(siteOf(census, overlappingNode), overlappingNode, 'readArrays()')!
  assert.equal(selected.split('nativeArrayViewAcceptsExact<').length - 1, 2)
  assert.equal(selected.split('nativeArrayViewElementsAccept<').length - 1, 2)
  assert.ok(selected.includes('TypeError'))
})

// A dynamic value read as a record whose field holds that same record (an
// `image` field holding another `image`) may be a plain object written by code
// the program cannot see -- `JSON.parse`, or a source built in JS -- which exact payload
// recovery would refuse with a TypeError. It is read as a live view, and the
// self-referential field is wrapped when it is read, one view per access, so
// the view needs no proof of its own while it is being minted and a cyclic
// Document stays finite (runtime: self-referential-record-crossing-from-dynamic).
test('a recursive native field is a live document view whose self-referential field is read per access', () => {
  const native: Representation = {
    kind: 'native-record-ref',
    shapeId: 'recursive-native-wrapper',
    native: null,
    ownership: 'shared-refcount'
  }
  const fields = [{ key: 'parent', value: native, required: false }]
  const nativeLayouts = {
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: () => fields,
    plainFieldsForShape: () => fields
  }
  const registry = createCppConversionRegistry(nativeLayouts)
  const census = createConversionNodes({ registry, nodes: new Map() })
  const target: Representation = { kind: 'optional', payload: native, absence: 'undefined' }
  const payload = census.nodeFor(dynamic, native)
  assert.ok(payload.capability.kind === 'static')
  const view = payload.capability.materializer.documentRecordView
  assert.ok(view && view.step.kind === 'document' && view.step.payload.kind === 'view')
  const parent = view.step.payload.view.fields.find((field) => field.key === 'parent')
  assert.ok(parent, 'the self-referential field stays in the view')
  assert.equal(parent.read, undefined, 'its read is not an eager recursive conversion')
  assert.ok(parent.write)
  const node = census.nodeFor(dynamic, target)
  assert.notEqual(node.capability.kind, 'never')
  const site = { ...siteOf(census, node), layouts: nativeLayouts }
  const emitted = recipeText(site, node, 'readNativePayload()')!
  assert.ok(emitted.includes('makeDocumentViewWithOrigin'))
  assert.ok(emitted.includes('unboxDynamicDictionary'))
  assert.ok(emitted.includes('Value::Tag::Undefined'))
  assert.equal(emitted.split('readNativePayload()').length - 1, 1)
})

// A function written by code the program cannot see, read into a typed
// callable slot, is called through the checked adapter over it: each argument
// is only boxed OUT, the result is read back in. Library-internal state and
// property-cache classes handed JS-authored callbacks are the frames this admits.
const callableOf = (
  parameters: readonly Representation[],
  result: Representation,
  restFrom: number | null = null
): Extract<Representation, { kind: 'function-value-dispatch' }> => ({
  kind: 'function-value-dispatch',
  abi: {
    parameters: parameters.map((value) => ({ value, passing: 'by-value' as const, ownership: 'owned' as const })),
    result,
    receiver: null,
    restFrom
  }
})
const unionOf = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    semanticType: `type|adapter-arm-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' as const },
    value
  }))
})

test('an adapter argument needs every arm boxable, not a reader for each arm', () => {
  const table: Representation = { kind: 'dictionary', key: 'string', value: record, ownership: 'shared-refcount' }
  // A property cache's `update(object, key, value)`: the value is a union nested
  // inside its absences, and one arm is a typed `Record<string, T>` table.
  const value = unionOf({ kind: 'undefined' }, { kind: 'null' }, unionOf({ kind: 'string' }, table))
  const census = censusOf()
  assert.notEqual(census.nodeFor(dynamic, callableOf([value], { kind: 'void' })).capability.kind, 'never')
  assert.equal(
    census.nodeFor(dynamic, callableOf([], value)).capability.kind,
    'never',
    'a result is read back in, which a typed table entry has no checked reader for'
  )
})

test('a rest slot carried as a closed tuple record crosses as the forwarded argument list', () => {
  const tuple = (keys: readonly string[]): Representation => ({
    kind: 'record',
    shapeId: `adapter-rest-${keys.join('-')}`,
    ownership: 'shared-refcount',
    accessors: [],
    fields: keys.map((key) => ({ key, value: { kind: 'scalar', domain: 'number' } as Representation, required: false }))
  })
  const census = censusOf()
  assert.notEqual(census.nodeFor(dynamic, callableOf([tuple(['0', '1'])], { kind: 'void' }, 0)).capability.kind, 'never')
  assert.equal(
    census.nodeFor(dynamic, callableOf([tuple(['0', 'name'])], { kind: 'void' }, 0)).capability.kind,
    'never',
    'a record with a named slot is not an argument list'
  )
})
