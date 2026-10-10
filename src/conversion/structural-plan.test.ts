import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversionNeedsPriorSourceGuard,
  conversionRequiresSourceGuard,
  type ConversionCapability,
  type ConversionNode
} from './algebra.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { callableViewText } from '../targets/cpp/emit-callable-view.js'
import type { ConversionSite } from '../targets/cpp/emit-narrowing.js'
import {
  certifiedRecordViewPlan,
  callableViewPlan,
  recordToArrayPlan,
  structuralConversionKey,
  structuralRecipeRequiredFor,
  type AcceptedConversion
} from './structural-plan.js'
import type { Representation } from '../representation/model.js'
import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import { nativeUnboundMethodContractOf } from './native-method.js'
import { recipeClosureOf } from './recipe-closure.js'
import { nativeSumPlan } from './native-sum.js'
import { nativeViewOriginsOf } from './native-view-origins.js'
import { nativeViewTargetsOf } from '../targets/cpp/native-view-targets.js'
import { certifiedRecordViewText } from '../targets/cpp/emit-record-view.js'
import { emptyCaptureIndex } from '../targets/cpp/emit-context.js'
import { nativeSubsetSelectionRecipeOf } from './native-selection.js'
import { nativeFieldViewIdentityTransportOf, nativeFieldViewPlansOf } from './native-field-view.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const proof = (source: Representation, target: Representation): ConversionNode => ({
  id: structuralConversionKey(source, target),
  source,
  target,
  capability:
    structuralConversionKey(source, source) === structuralConversionKey(source, target)
      ? { kind: 'identity' }
      : { kind: 'static', materializer: { id: 'test:native-leaf', domain: 'test:native-leaf', allocates: false } }
})
const identity: AcceptedConversion = (source, target) => {
  const node = proof(source, target)
  return node.capability.kind === 'identity' ? node : null
}
const record = (values: readonly Representation[]): Extract<Representation, { kind: 'record' }> => ({
  kind: 'record',
  shapeId: 'tuple',
  ownership: 'owned',
  fields: values.map((value, index) => ({ key: String(index), value, required: true })),
  accessors: []
})
const array = (element: Representation): Extract<Representation, { kind: 'array-object' }> => ({
  kind: 'array-object',
  ownership: 'shared-refcount',
  element,
  extension: null
})

test('a complete conditional record view precedes a single exact-arm extraction in lazy and eager censuses', () => {
  const fields = [{ key: 'label', value: string, required: true }]
  const target: Representation = { kind: 'native-record-ref', shapeId: 'target', native: null, ownership: 'shared-refcount' }
  const other: Representation = {
    kind: 'record',
    shapeId: 'other',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [...fields, { key: 'count', value: number, required: true }]
  }
  const source: Representation = {
    kind: 'tagged-union',
    arms: [other, target].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: String(index) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const targetFields = (shapeId: string) => (shapeId === 'target' ? fields : null)
  const registry = createCppConversionRegistry({
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: targetFields,
    plainFieldsForShape: targetFields
  })
  assert.equal(registry.narrowing(source, target), null)
  const eager: ConversionNode = {
    id: structuralConversionKey(source, target),
    source,
    target,
    capability: {
      kind: 'atom',
      classifier: { id: 'gea::TaggedUnion::is', domain: 'live-arm:target' },
      materializer: { id: 'gea::TaggedUnion::get', domain: 'live-arm:target', allocates: false, armSelection: 'guarded-load' }
    }
  }
  const selection = nativeSubsetSelectionRecipeOf(source, target)
  assert.ok(selection)
  const selected: ConversionNode = {
    ...eager,
    capability: {
      kind: 'atom',
      classifier: { id: 'gea::native-sum::matches', domain: 'live-arm:target' },
      materializer: {
        id: 'gea::native-sum::select',
        domain: 'live-arm:target',
        allocates: false,
        armSelection: 'native-sum',
        nativeSelection: selection,
        nativePayloadTransport: 'preserved',
        nativeFieldProtocol: 'unused',
        requiresSourceGuard: true,
        executesSourceGuard: true
      }
    }
  }
  for (const nodes of [new Map(), new Map([[eager.id, eager]]), new Map([[selected.id, selected]])]) {
    const census = createConversionNodes({ registry, nodes })
    const node = census.nodeFor(source, target)
    assert.ok(node.capability.kind === 'static' || node.capability.kind === 'atom')
    const plan = node.capability.materializer.recordView
    assert.ok(plan)
    assert.equal(plan.view.kind, 'dispatch')
    if (plan.view.kind === 'dispatch') assert.equal(plan.view.arms.length, 2)
    assert.equal(census.nodeById(node.id), node)
    assert.equal(nativeFieldViewIdentityTransportOf(node), true)
    assert.ok(nativeFieldViewPlansOf(recipeClosureOf([node], census.nodeById).values()).length > 0)
  }
})

test('tuple materialization carries the exact accepted conversion for each field', () => {
  const source = record([number, dynamic])
  const target = array(dynamic)
  const nodes = [proof(number, dynamic), proof(dynamic, dynamic)]
  const plan = recordToArrayPlan(
    source,
    target,
    (from, into) => nodes.find((node) => node.id === structuralConversionKey(from, into)) ?? null
  )
  assert.ok(plan)
  assert.deepEqual(
    plan.fields.map((field) => field.conversion),
    nodes
  )
  assert.equal(plan.fields[0]?.conversion, nodes[0])
  assert.equal(plan.source, source)
  assert.equal(plan.target, target)
})

test('tuple materialization refuses a leaf the authority rejects', () => {
  assert.equal(recordToArrayPlan(record([number, string]), array(number), identity), null)
})

test('tuple materialization refuses gaps, empty storage and borrowed output', () => {
  const source = record([number])
  assert.equal(recordToArrayPlan({ ...source, fields: [{ key: '1', value: number, required: true }] }, array(number), identity), null)
  assert.equal(recordToArrayPlan(record([]), array(number), identity), null)
  assert.equal(recordToArrayPlan(source, { ...array(number), ownership: 'borrowed' }, identity), null)
})

test('structural view seals only the chosen field conversion and preserves its identity proof', () => {
  const source = record([number])
  const target: Representation = { ...source, shapeId: 'other-layout' }
  const leaf = proof(number, number)
  const plan = certifiedRecordViewPlan(
    { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null },
    source,
    target,
    (from, into) => (leaf.id === structuralConversionKey(from, into) ? leaf : null)
  )
  assert.ok(plan)
  assert.equal(plan.view.kind, 'fields')
  assert.equal(plan.leaves.size, 1)
  assert.equal(plan.leaves.get(leaf.id), leaf)
})

test('structural view never accepts a never-node returned as a leaf proof', () => {
  const source = record([number])
  const target: Representation = { ...source, shapeId: 'other-layout' }
  assert.equal(
    certifiedRecordViewPlan(
      { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null },
      source,
      target,
      (from, into) => ({
        id: structuralConversionKey(from, into),
        source: from,
        target: into,
        capability: { kind: 'never', reason: 'test refusal' }
      })
    ),
    null
  )
})

test('tuple materialization rejects a leaf proof for different carriers', () => {
  assert.throws(() => recordToArrayPlan(record([number]), array(number), () => proof(string, number)), /different carriers/)
})

test('a named-record recast atom must receive a sealed plan before it can print', () => {
  const source = record([number])
  const target: Representation = { kind: 'native-record-ref', shapeId: 'named', ownership: 'shared-refcount', native: null }
  const node: ConversionNode = {
    id: structuralConversionKey(source, target),
    source,
    target,
    capability: {
      kind: 'atom',
      classifier: { id: 'gea::record::recast', domain: 'test:named-record-recast' },
      materializer: { id: 'gea::record::recast', domain: 'test:named-record-recast', allocates: true }
    }
  }
  assert.equal(structuralRecipeRequiredFor(node), true)
  assert.equal(structuralRecipeRequiredFor({ ...node, target: source }), false)
  assert.equal(
    structuralRecipeRequiredFor({
      ...node,
      target: {
        kind: 'optional',
        payload: {
          kind: 'tagged-union',
          arms: [{ tag: '0', value: target, semanticType: 'type|test' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } }]
        },
        absence: 'undefined'
      }
    }),
    true
  )
})

test('ordinary shared record recasts seal inherited native origin ownership and its generated target trait', () => {
  const source: Extract<Representation, { kind: 'record' }> = {
    kind: 'record',
    shapeId: 'shared-wide',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [
      { key: 'shown', value: string, required: true },
      { key: 'also', value: string, required: true }
    ]
  }
  const target: Extract<Representation, { kind: 'record' }> = {
    ...source,
    shapeId: 'shared-narrow',
    fields: source.fields.slice(0, 1)
  }
  const registry = createCppConversionRegistry()
  for (const wrapped of [false, true]) {
    const from: Representation = wrapped ? { kind: 'optional', payload: source, absence: 'undefined' } : source
    const into: Representation = wrapped ? { kind: 'optional', payload: target, absence: 'undefined' } : target
    const materializer = registry.staticRecipe?.(from, into)
    assert.ok(materializer)
    const eager: ConversionNode = {
      id: structuralConversionKey(from, into),
      source: from,
      target: into,
      capability: { kind: 'static', materializer }
    }
    for (const nodes of [new Map(), new Map([[eager.id, eager]])]) {
      const census = createConversionNodes({ registry, nodes })
      const node = census.nodeFor(from, into)
      assert.ok(node.capability.kind === 'static' || node.capability.kind === 'atom')
      const plan = node.capability.materializer.recordView
      assert.ok(plan)
      assert.deepEqual(nativeViewOriginsOf([node], census.nodeById), [{ source, target }])
      assert.deepEqual(nativeViewTargetsOf([node]), [target.shapeId])
      const text = certifiedRecordViewText(
        {
          conversions: census,
          printerDrift: [],
          owner: 'reference-recast-test',
          layouts: { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null },
          classes: new Map(),
          captures: emptyCaptureIndex,
          functionFacts: new Map()
        },
        plan,
        'held'
      )
      assert.ok(text)
      assert.match(text, /gea::record::makeLiveViewWithOrigin</)
      assert.match(text, /hasLiveFieldView\(gea_immediate\)/)
      assert.match(text, /gea_readOwnFieldNative/)
      assert.match(text, /gea_writeOwnFieldNative/)
      assert.doesNotMatch(text, /->shown/)
      assert.doesNotMatch(text, /gea::makeRef</)
    }
  }
  const census = createConversionNodes({ registry, nodes: new Map() })
  const owned = census.nodeFor({ ...source, ownership: 'owned' }, { ...target, ownership: 'owned' })
  assert.equal(structuralRecipeRequiredFor(owned), false)
  assert.deepEqual(nativeViewOriginsOf([owned], census.nodeById), [])
})

test('checked native sum selection keeps the registry payload contract without demanding a record rebuild', () => {
  const target: Representation = { kind: 'native-record-ref', shapeId: 'selected', ownership: 'shared-refcount', native: null }
  const selected: Representation = {
    kind: 'tagged-union',
    arms: [string, target].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type|selected-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const source: Representation = {
    kind: 'optional',
    payload: {
      ...selected,
      arms: [
        ...selected.arms,
        { tag: '2', value: number, semanticType: 'type|extra' as StructuralTypeId, runtimeDiscriminator: { kind: 'carrier' } }
      ]
    },
    absence: 'undefined'
  }
  for (const id of ['gea::TaggedUnion::ofArm', 'gea::Optional::recastPayload', 'gea::Optional::converting-ctor']) {
    const materializer = {
      id,
      domain: 'selected-native-transport',
      allocates: false,
      nativeFieldProtocol: 'unused' as const,
      nativePayloadTransport: 'preserved' as const
    }
    const node: ConversionNode = {
      id: structuralConversionKey(source, selected),
      source,
      target: selected,
      capability: { kind: 'static', materializer }
    }
    assert.equal(structuralRecipeRequiredFor(node), false, id)
    const { nativePayloadTransport: _transport, ...withoutPayloadProof } = materializer
    assert.equal(
      structuralRecipeRequiredFor({
        ...node,
        capability: { kind: 'static', materializer: withoutPayloadProof }
      }),
      true,
      `${id} has no identity payload contract`
    )
  }
})

test('an interface method seals a source-only method view and its finite public frame', () => {
  const declaration = 'method-owner' as DeclarationId
  const receiver: Representation = {
    kind: 'class-ref',
    declaration,
    shapeId: 'method-owner',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const member: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: number }
  }
  const own = { ...member, abi: { ...member.abi, receiver } }
  const target: Representation = {
    kind: 'record',
    shapeId: 'interface',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'probe', value: member, required: true }]
  }
  const nativeMethod: AcceptedConversion = (source, target) => {
    const contract = nativeUnboundMethodContractOf(source, target)
    return contract === null
      ? null
      : {
          id: `${structuralConversionKey(source, target)}#native-method`,
          source,
          target,
          capability: {
            kind: 'static',
            materializer: {
              id: 'gea::CallableObject::unboundMethod',
              domain: 'static:native-unbound-method',
              allocates: true,
              nativeMethod: contract
            }
          }
        }
  }
  const plan = certifiedRecordViewPlan(
    {
      indexesForShape: () => [],
      accessorsForShape: () => [],
      forShape: () => [],
      classMethodFor: () => true,
      classMethodAbiFor: () => own.abi,
      classMethodValueSourcesFor: () => [own]
    },
    receiver,
    target,
    identity,
    undefined,
    nativeMethod
  )
  assert.ok(plan)
  assert.equal(plan.methods.length, 1)
  assert.equal(plan.methods[0]?.method.capability.kind, 'static')
  assert.equal(plan.methods[0]?.adaptation.capability.kind, 'identity')
  assert.equal(plan.methods[0]?.source.abi.receiver, receiver)
  assert.equal(plan.leaves.get(structuralConversionKey(own, member)), plan.methods[0]?.method)
})

test('a structural method read seals body and own override native public frames with every dependency', () => {
  const base: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: 'base-method-owner' as DeclarationId,
    shapeId: 'base-method-owner',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const receiver = {
    ...base,
    declaration: 'derived-method-owner' as DeclarationId,
    shapeId: 'derived-method-owner',
    ancestors: [base.declaration]
  }
  const own: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: base, parameters: [], restFrom: null, result: number }
  }
  const optional: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
  const override: Representation = {
    ...own,
    abi: { ...own.abi, parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }] }
  }
  const member: Representation = { ...own, abi: { ...own.abi, receiver } }
  const target: Representation = {
    kind: 'record',
    shapeId: 'method-interface',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'probe', value: member, required: true }]
  }
  const layouts = {
    indexesForShape: () => [],
    accessorsForShape: () => [],
    forShape: () => [],
    classMethodFor: () => true,
    classMethodAbiFor: () => own.abi,
    classMethodValueSourcesFor: () => [own, override]
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const plan = certifiedRecordViewPlan(layouts, receiver, target, census.nodeFor, undefined, census.nativeMethodFor, census.nodeById)
  assert.ok(plan)
  for (const source of [own, override]) {
    const selected = plan.leaves.get(structuralConversionKey(source, member))
    assert.equal(selected, census.nativeMethodFor(source, member))
    assert.ok(selected?.capability.kind === 'static')
    assert.equal(selected.capability.materializer.id, 'gea::CallableObject::unboundMethod')
    assert.ok(selected.capability.materializer.nativeMethod?.publicAdaptation)
    for (const dependency of recipeClosureOf([selected], census.nodeById).values()) assert.equal(census.nodeById(dependency.id), dependency)
  }
  const selectedOverride = plan.leaves.get(structuralConversionKey(override, member))
  assert.ok(selectedOverride?.capability.kind === 'static')
  assert.ok(selectedOverride.capability.materializer.nativeMethod?.frameAdaptation)
  const view = census.nodeFor(receiver, target)
  assert.ok(view.capability.kind === 'static' || view.capability.kind === 'atom')
  assert.deepEqual(view.capability.materializer.dependencies, [...view.capability.materializer.recordView!.leaves.values()])
})

test('a refused native method dependency cannot fall back to an ordinary structural leaf', () => {
  const receiver: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: 'refused-method-owner' as DeclarationId,
    shapeId: 'refused-method-owner',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const member: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: number }
  }
  const own = { ...member, abi: { ...member.abi, receiver } }
  const target: Representation = {
    kind: 'record',
    shapeId: 'refused-interface',
    ownership: 'shared-refcount',
    accessors: [],
    fields: [{ key: 'probe', value: member, required: true }]
  }
  const missing: ConversionNode = {
    ...proof(string, number),
    capability: { kind: 'never', reason: 'the exact method frame is unsupported' }
  }
  const plan = certifiedRecordViewPlan(
    {
      indexesForShape: () => [],
      accessorsForShape: () => [],
      forShape: () => [],
      classMethodFor: () => true,
      classMethodAbiFor: () => own.abi,
      classMethodValueSourcesFor: () => [own]
    },
    receiver,
    target,
    proof,
    undefined,
    (source, into) => ({
      ...proof(source, into),
      capability: {
        kind: 'static',
        materializer: { id: 'gea::CallableObject::unboundMethod', domain: 'native-method', allocates: true, dependencies: [missing] }
      }
    })
  )
  assert.equal(plan, null)
})

test('a future callable result cannot inherit a nominal proof hidden in a materializer dependency', () => {
  const base: Extract<Representation, { kind: 'class-ref' }> = {
    kind: 'class-ref',
    declaration: 'future-base' as DeclarationId,
    shapeId: 'future-base',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const derived = { ...base, declaration: 'future-derived' as DeclarationId, shapeId: 'future-derived', ancestors: [base.declaration] }
  const payload: ConversionNode = {
    ...proof(base, derived),
    capability: {
      kind: 'static',
      materializer: { id: 'test:nominal-downcast', domain: 'nominal-downcast', allocates: false, requiresSourceGuard: true }
    }
  }
  const from: Representation = { kind: 'promise', value: base }
  const into: Representation = { kind: 'promise', value: derived }
  const nested: ConversionNode = {
    ...proof(from, into),
    capability: {
      kind: 'static',
      materializer: { id: 'test:future-payload', domain: 'future-payload', allocates: true, dependencies: [payload] }
    }
  }
  const source: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: from }
  }
  const target: Representation = { ...source, abi: { ...source.abi, result: into } }
  assert.equal(
    callableViewPlan(source, target, (from, into) => (structuralConversionKey(from, into) === nested.id ? nested : identity(from, into))),
    null
  )
})

test('omitting an optional argument cannot prove the entries of an unknown future dictionary result', () => {
  const union = (values: readonly Representation[]): Representation => ({
    kind: 'tagged-union',
    arms: values.map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type|future-dictionary-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  })
  const dictionary: Representation = {
    kind: 'dictionary',
    key: 'string',
    value: union([string, array(string)]),
    ownership: 'shared-refcount'
  }
  const narrowDictionary: Representation = { ...dictionary, value: string }
  const optionalString: Representation = { kind: 'optional', payload: string, absence: 'undefined' }
  const optionalBoolean: Representation = { kind: 'optional', payload: { kind: 'scalar', domain: 'boolean' }, absence: 'undefined' }
  const source: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [string, optionalString, optionalBoolean].map((value) => ({ value, passing: 'by-value', ownership: 'owned' })),
      restFrom: null,
      result: { kind: 'optional', payload: union([string, array(string), dictionary]), absence: 'undefined' }
    }
  }
  const target: Representation = {
    ...source,
    abi: {
      ...source.abi,
      parameters: source.abi.parameters.slice(0, 2),
      result: { kind: 'optional', payload: union([string, narrowDictionary]), absence: 'undefined' }
    }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  // The omitted argument is undefined, but the ABI gives no body proof that
  // dictionary entries are strings. Copying the table would also detach its
  // identity and later mutations from aliases retained by the source function.
  assert.equal(census.nodeFor(source, target).capability.kind, 'never')
})

test('dictionary value recasts cannot replace mutable storage with a snapshot', () => {
  const value: Representation = {
    kind: 'tagged-union',
    arms: [string, number].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type|dictionary-entry-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  for (const key of ['string', 'number'] as const) {
    for (const ownership of ['shared-refcount', 'owned'] as const) {
      const source: Representation = { kind: 'dictionary', key, value: string, ownership }
      const target: Representation = { ...source, value }
      assert.equal(census.nodeFor(source, target).capability.kind, 'never', 'widening entries cannot detach dictionary aliases')
      const narrowed = census.nodeFor(target, source)
      if (ownership === 'shared-refcount') {
        assert.ok(
          narrowed.capability.kind === 'static' && narrowed.capability.materializer.dictionaryView,
          'a retained native view checks each entry at read time and writes into the original storage'
        )
      } else assert.equal(narrowed.capability.kind, 'never', 'owned storage has no retained native allocation to view')
      assert.equal(census.nodeFor(source, source).capability.kind, 'identity')
      const nativeSum: Representation = {
        kind: 'tagged-union',
        arms: [source, number].map((value, index) => ({
          tag: String(index),
          value,
          semanticType: `type|dictionary-transport-${index}` as StructuralTypeId,
          runtimeDiscriminator: { kind: 'carrier' }
        }))
      }
      assert.notEqual(census.nodeFor(source, nativeSum).capability.kind, 'never', 'a sum can hold the same native dictionary storage')
    }
  }
})

test('a callable result adapter cites an admitted iterator object transport as its exact result proof', () => {
  const cursor: Representation = {
    kind: 'async-generator',
    element: string,
    completion: { kind: 'undefined' },
    resume: { kind: 'undefined' }
  }
  const iterator: Representation = { kind: 'native-record-ref', shapeId: 'async-iterator', ownership: 'shared-refcount', native: null }
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [], restFrom: null, result: cursor }
  }
  const target: Representation = { ...source, abi: { ...source.abi, result: iterator } }
  const conversion: ConversionNode = {
    id: structuralConversionKey(cursor, iterator),
    source: cursor,
    target: iterator,
    capability: { kind: 'static', materializer: { id: 'gea::Iterator::objectView', domain: 'iterator-object-view', allocates: true } }
  }
  const accepted: AcceptedConversion = (from, into) =>
    conversion.id === structuralConversionKey(from, into) ? conversion : identity(from, into)
  const plan = callableViewPlan(source, target, accepted)
  assert.ok(plan)
  assert.equal(plan.result, conversion)
  assert.equal(callableViewPlan(source, target, identity), null)
  assert.equal(
    callableViewPlan(source, target, () => ({ ...conversion, capability: { kind: 'never', reason: 'unadmitted iterator result' } })),
    null
  )
  assert.throws(() => callableViewPlan(source, target, () => proof(string, iterator)), /different carriers/)
})

test('a void body read into an undefined-result slot is planned as an identity completion, not refused', () => {
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [{ value: string, ownership: 'owned', passing: 'by-value' }],
      restFrom: null,
      result: { kind: 'void' }
    }
  }
  const target: Representation = { ...source, abi: { ...source.abi, result: { kind: 'undefined' } } }
  const plan = callableViewPlan(source, target, identity)
  assert.ok(plan, 'the native entry returns no C++ value, so the frame must supply undefined')
  assert.equal(plan.result?.capability.kind, 'identity', 'the completion value itself is the same undefined')
  assert.deepEqual(
    plan.parameters.map((node) => node.capability.kind),
    ['identity']
  )
  assert.equal(callableViewPlan(source, source, identity), null, 'an identical frame still needs no plan')
})

test('a checked class-origin recovery is not a total home competing with a structural record arm', () => {
  const source: Representation = { ...record([string]), ownership: 'shared-refcount' }
  const classTarget: Representation = {
    kind: 'class-ref',
    declaration: 'origin-class' as DeclarationId,
    shapeId: 'origin-class',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const recordTarget: Representation = { ...source, shapeId: 'record-arm' }
  const target: Representation = {
    kind: 'tagged-union',
    arms: [classTarget, recordTarget].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type|origin-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const origin = census.nodeFor(source, classTarget)
  assert.equal(origin.capability.kind, 'atom', 'the guarded explicit class recovery remains installed')
  assert.equal(conversionRequiresSourceGuard(origin.capability), true)
  const plan = certifiedRecordViewPlan(layouts, source, target, (from, into) => {
    const node = census.nodeFor(from, into)
    return node.capability.kind === 'never' ? null : node
  })
  assert.ok(plan?.view.kind === 'arm')
  assert.equal(plan.view.index, 1)
  assert.ok(!plan.leaves.has(structuralConversionKey(source, classTarget)))
  assert.ok(plan.leaves.has(structuralConversionKey(source, recordTarget)))
})

test('optional wrappers and eager record fields retain the checked origin guard fact', () => {
  const source: Representation = { ...record([string]), ownership: 'shared-refcount' }
  const classTarget: Representation = {
    kind: 'class-ref',
    declaration: 'origin-class' as DeclarationId,
    shapeId: 'origin-class',
    ancestors: [],
    ownership: 'shared-refcount'
  }
  const registry = createCppConversionRegistry({ indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null })
  const origin = registry.narrowing(source, classTarget)
  assert.ok(origin)
  const capability = { kind: 'atom' as const, classifier: origin.classifier, materializer: origin.materializer }
  assert.equal(conversionRequiresSourceGuard({ kind: 'optional', payload: capability, absenceTag: 'Undefined' }), true)
  const census = createConversionNodes({ registry, nodes: new Map() })
  const sourceOuter: Representation = { ...record([source]), shapeId: 'source-outer' }
  const targetOuter: Representation = { ...record([classTarget]), shapeId: 'target-outer' }
  const wrapper = census.nodeFor(sourceOuter, targetOuter)
  assert.notEqual(wrapper.capability.kind, 'never')
  assert.equal(conversionRequiresSourceGuard(wrapper.capability), true)
  assert.equal(conversionNeedsPriorSourceGuard(wrapper.capability), false)
})

test('an eager static fallback cannot shadow the ordinary structural view of native record fields', () => {
  const source: Representation = { ...record([string]), ownership: 'shared-refcount' }
  const target: Representation = { kind: 'native-record-ref', shapeId: 'fallback-target', native: null, ownership: 'shared-refcount' }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => [{ key: '0', value: string, required: true }] }
  const eager: ConversionNode = {
    id: structuralConversionKey(source, target),
    source,
    target,
    capability: {
      kind: 'static',
      materializer: { id: 'view:boxed-assertion', domain: 'static:boxed-assertion', allocates: true, staticRecipeFallback: true }
    }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map([[eager.id, eager]]) })
  const selected = census.nodeFor(source, target)
  assert.ok(selected.capability.kind === 'atom' || selected.capability.kind === 'static')
  assert.notEqual(selected.capability.materializer.id, eager.capability.kind === 'static' && eager.capability.materializer.id)
  assert.ok(selected.capability.materializer.recordView)
  assert.equal(selected.capability.materializer.staticRecipeFallback, undefined)
  const leaf = selected.capability.materializer.recordView.leaves.get(structuralConversionKey(string, string))
  assert.equal(leaf, census.nodeFor(string, string))
})

test('a callable fallback remains a sealed finite adapter with the exact structural parameter recipe', () => {
  const incoming: Representation = { ...record([string]), ownership: 'shared-refcount' }
  const parameter: Representation = { kind: 'native-record-ref', shapeId: 'callback-parameter', native: null, ownership: 'shared-refcount' }
  const own: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [{ value: parameter, ownership: 'shared-refcount', passing: 'const-ref' }],
      restFrom: null,
      result: number
    }
  }
  const member: Representation = {
    ...own,
    abi: { ...own.abi, parameters: [{ value: incoming, ownership: 'shared-refcount', passing: 'const-ref' }] }
  }
  const eager: ConversionNode = {
    id: structuralConversionKey(own, member),
    source: own,
    target: member,
    capability: {
      kind: 'static',
      materializer: { id: 'view:adapted-callable', domain: 'static:adapted-callable', allocates: true, staticRecipeFallback: true }
    }
  }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => [{ key: '0', value: string, required: true }] }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map([[eager.id, eager]]) })
  const selected = census.nodeFor(own, member)
  assert.ok(selected.capability.kind === 'static' || selected.capability.kind === 'atom')
  const plan = selected.capability.materializer.callableView
  assert.ok(plan)
  assert.equal(plan.parameters[0], census.nodeFor(incoming, parameter))
  assert.ok(selected.capability.materializer.dependencies?.includes(plan.parameters[0]!))
})

test('a finite callback supplies omitted trailing optional arguments through exact undefined recipes', () => {
  const optional: Representation = { kind: 'optional', payload: { kind: 'promise', value: { kind: 'void' } }, absence: 'undefined' }
  const own: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: {
      receiver: null,
      parameters: [{ value: optional, ownership: 'owned', passing: 'by-value' }],
      restFrom: null,
      result: { kind: 'void' }
    }
  }
  const member: Representation = { ...own, abi: { ...own.abi, parameters: [] } }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(own, member)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const plan = node.capability.materializer.callableView
  assert.ok(plan)
  assert.equal(plan.parameters.length, 0)
  assert.equal(plan.omittedArguments?.[0], census.nodeFor({ kind: 'undefined' }, optional))
  const ctx = { conversions: census, printerDrift: [], owner: 'test' } as unknown as ConversionSite
  const rendered = callableViewText(ctx, plan, 'sourceCallback')
  assert.ok(rendered)
  assert.ok(!rendered.includes('gea_adapt_arg_0'))
  assert.equal(nativeSumPlan({ kind: 'undefined' }, optional)?.kind, 'empty')
  assert.ok(rendered.includes('return GeaSumTarget{};'), 'the exact omission recipe constructs an absent Optional')
  const required: Representation = { ...own, abi: { ...own.abi, parameters: [{ value: number, ownership: 'owned', passing: 'by-value' }] } }
  assert.equal(
    callableViewPlan(required, member, (from, into) => census.nodeFor(from, into)),
    null
  )
})

test('a fixed callback reads a public rest Array through exact present and missing argument recipes', () => {
  const own: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [{ value: string, ownership: 'owned', passing: 'const-ref' }], restFrom: null, result: number }
  }
  const rest = array(dynamic)
  const member: Representation = {
    ...own,
    abi: { ...own.abi, parameters: [{ value: rest, ownership: 'shared-refcount', passing: 'const-ref' }], restFrom: 0 }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(own, member)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  const plan = node.capability.materializer.callableView
  assert.ok(plan?.restUnpacking)
  const element = plan.restUnpacking.elements[0]
  assert.equal(element?.present, census.nodeFor(dynamic, string))
  assert.equal(element?.absent, census.nodeFor({ kind: 'undefined' }, string))
  assert.ok(node.capability.materializer.dependencies?.includes(element!.present))
  assert.ok(node.capability.materializer.dependencies?.includes(element!.absent!))
  const ctx = { conversions: census, printerDrift: [], owner: 'test' } as unknown as ConversionSite
  const rendered = callableViewText(ctx, plan, 'sourceCallback')
  assert.ok(rendered)
  assert.ok(rendered.includes('hasElementValue(0)'))
  // `readElementAt`, not the storage reference `elementAt`: a rest Array can
  // be a live native view, whose elements exist only behind its reader.
  assert.ok(rendered.includes('readElementAt(0)'))
  assert.ok(rendered.includes('unreachableValue'), 'a missing required native string throws instead of becoming an empty string')
})

test('a fixed callback reads a required rest tuple field using its exact native carrier', () => {
  const own: Extract<Representation, { kind: 'function-value-dispatch' }> = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [{ value: string, ownership: 'owned', passing: 'const-ref' }], restFrom: null, result: number }
  }
  const tuple = record([string])
  const member: Representation = {
    ...own,
    abi: { ...own.abi, parameters: [{ value: tuple, ownership: 'owned', passing: 'by-value' }], restFrom: 0 }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const plan = callableViewPlan(own, member, (from, into) => census.nodeFor(from, into))
  assert.ok(plan?.restUnpacking)
  assert.equal(plan.restUnpacking.elements[0]?.absent, null)
  const ctx = { conversions: census, printerDrift: [], owner: 'test' } as unknown as ConversionSite
  const rendered = callableViewText(ctx, plan, 'sourceCallback')
  assert.ok(rendered?.includes('gea_adapt_arg_0.gea_slot_0'))
})

test('a finite callback refuses nominal downcasts whose source guard is only a caller proof', () => {
  const base: Representation = {
    kind: 'class-ref',
    declaration: 'base' as DeclarationId,
    shapeId: 'base',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const child: Representation = { ...base, declaration: 'child' as DeclarationId, shapeId: 'child', ancestors: [base.declaration] }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const downcast = census.nodeFor(base, child)
  assert.equal(conversionNeedsPriorSourceGuard(downcast.capability), true)
  const accepted: AcceptedConversion = (from, into) => {
    const node = census.nodeFor(from, into)
    return node.capability.kind === 'never' ? null : node
  }
  const parameter = (value: Representation) => ({ value, ownership: 'shared-refcount' as const, passing: 'const-ref' as const })
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [parameter(child)], restFrom: null, result: number }
  }
  const target: Representation = { ...source, abi: { ...source.abi, parameters: [parameter(base)] } }
  assert.equal(callableViewPlan(source, target, accepted), null)
  const nullableBase: Representation = { kind: 'optional', payload: base, absence: 'undefined' }
  assert.equal(conversionNeedsPriorSourceGuard(census.nodeFor(nullableBase, child).capability), true)
  assert.equal(callableViewPlan(source, { ...target, abi: { ...target.abi, parameters: [parameter(nullableBase)] } }, accepted), null)
  const nullableChild: Representation = { kind: 'optional', payload: child, absence: 'undefined' }
  for (const supplied of [base, nullableBase]) {
    const wrappedDowncast = census.nodeFor(supplied, nullableChild)
    assert.equal(conversionRequiresSourceGuard(wrappedDowncast.capability), true)
    assert.equal(conversionNeedsPriorSourceGuard(wrappedDowncast.capability), true)
    const ownOptional: Representation = { ...source, abi: { ...source.abi, parameters: [parameter(nullableChild)] } }
    const member: Representation = { ...target, abi: { ...target.abi, parameters: [parameter(supplied)] } }
    assert.equal(callableViewPlan(ownOptional, member, accepted), null, 'wrapping cannot create the nominal proof for a future invocation')
  }
  const resultSource: Representation = { ...source, abi: { ...source.abi, parameters: [], result: base } }
  const resultTarget: Representation = { ...resultSource, abi: { ...resultSource.abi, result: child } }
  assert.equal(callableViewPlan(resultSource, resultTarget, accepted), null)
})

test('a finite callback may cite native origin recovery because its recipe authenticates every invocation', () => {
  const native: Representation = {
    kind: 'class-ref',
    declaration: 'native-origin' as DeclarationId,
    shapeId: 'native-origin',
    ownership: 'shared-refcount',
    ancestors: []
  }
  const view: Representation = { ...record([string]), ownership: 'shared-refcount' }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const origin = census.nodeFor(view, native)
  assert.equal(conversionRequiresSourceGuard(origin.capability), true)
  assert.equal(conversionNeedsPriorSourceGuard(origin.capability), false)
  const parameter = (value: Representation) => ({ value, ownership: 'shared-refcount' as const, passing: 'const-ref' as const })
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [parameter(native)], restFrom: null, result: number }
  }
  const target: Representation = { ...source, abi: { ...source.abi, parameters: [parameter(view)] } }
  const plan = callableViewPlan(source, target, (from, into) => {
    const node = census.nodeFor(from, into)
    return node.capability.kind === 'never' ? null : node
  })
  assert.ok(plan)
  assert.equal(plan.parameters[0], origin)
})

test('a fixed public method frame packs its trailing arguments using exact rest element nodes', () => {
  const event: Representation = {
    kind: 'tagged-union',
    arms: [string, { kind: 'symbol' } as Representation].map((value, index) => ({
      tag: String(index),
      value,
      semanticType: `type|event-${index}` as StructuralTypeId,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const rest = array(dynamic)
  const parameter = (value: Representation) => ({ value, ownership: 'owned' as const, passing: 'by-value' as const })
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [parameter(event), parameter(rest)], restFrom: 1, result: { kind: 'scalar', domain: 'boolean' } }
  }
  const target: Representation = {
    ...source,
    abi: { ...source.abi, parameters: [parameter(string), parameter(string), parameter(string)], restFrom: null, result: { kind: 'void' } }
  }
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const plan = callableViewPlan(source, target, (from, into) => {
    const node = census.nodeFor(from, into)
    return node.capability.kind === 'never' ? null : node
  })
  assert.ok(plan?.restPacking)
  assert.equal(plan.parameters.length, 1)
  assert.equal(plan.restPacking.from, 1)
  assert.equal(plan.restPacking.array, rest)
  assert.deepEqual(plan.restPacking.elements, [census.nodeFor(string, dynamic), census.nodeFor(string, dynamic)])
  const node = census.nodeFor(source, target)
  assert.ok(node.capability.kind === 'static' || node.capability.kind === 'atom')
  assert.ok(node.capability.materializer.callableView?.restPacking)
  assert.deepEqual(node.capability.materializer.dependencies?.slice(1), plan.restPacking.elements)
  const ctx = {
    conversions: census,
    printerDrift: [],
    owner: 'test',
    layouts,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) }
  } as unknown as ConversionSite
  const text = callableViewText(ctx, plan, 'originalMethod')
  assert.ok(text !== null)
  assert.ok(text.includes('gea::arrayOf<gea::Value>({'))
  assert.ok(text.includes('gea_adapt_arg_1') && text.includes('gea_adapt_arg_2'))
  assert.ok(text.includes('callWithReceiver(gea_adapt_logical_receiver'))
  assert.ok(!text.includes('gea::bind'))
})

test('a zero-tail rest frame seals and emits an empty native pack', () => {
  const rest = array(string)
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [{ value: rest, ownership: 'shared-refcount', passing: 'const-ref' }], restFrom: 0, result: number }
  }
  const target: Representation = { ...source, abi: { ...source.abi, parameters: [], restFrom: null } }
  const plan = callableViewPlan(source, target, identity)
  assert.ok(plan?.restPacking)
  assert.equal(plan.restPacking.elements.length, 0)
  const layouts = { indexesForShape: () => [], accessorsForShape: () => [], forShape: () => null }
  const census = createConversionNodes({ registry: createCppConversionRegistry(layouts), nodes: new Map() })
  const ctx = {
    conversions: census,
    printerDrift: [],
    owner: 'test',
    layouts,
    classes: new Map(),
    captures: { of: () => ({ kind: 'none' }) }
  } as unknown as ConversionSite
  assert.ok(callableViewText(ctx, plan, 'originalMethod')?.includes('gea::arrayOf<std::string>({})'))
})

test('recursive guard queries authenticate cited nodes and retain guarded siblings through a cycle', () => {
  const materializer = { id: 'test:recursive-product', domain: 'test:recursive-product', allocates: true }
  const guarded: ConversionCapability = {
    kind: 'static',
    materializer: {
      id: 'test:checked-origin',
      domain: 'test:checked-origin',
      allocates: false,
      requiresSourceGuard: true,
      executesSourceGuard: true
    }
  }
  const a: ConversionNode = {
    id: 'recursive-a',
    source: dynamic,
    target: record([number]),
    capability: {
      kind: 'product',
      materializer,
      fields: [
        { key: 'next', required: true, capability: { kind: 'recursive-ref', node: 'recursive-b' } },
        { key: 'origin', required: true, capability: guarded }
      ]
    }
  }
  const b: ConversionNode = {
    id: 'recursive-b',
    source: dynamic,
    target: record([string]),
    capability: {
      kind: 'product',
      materializer,
      fields: [{ key: 'next', required: true, capability: { kind: 'recursive-ref', node: a.id } }]
    }
  }
  const nodes = new Map([
    [a.id, a],
    [b.id, b]
  ])
  const resolve = (id: string): ConversionNode | null => nodes.get(id) ?? null
  const reference: ConversionCapability = { kind: 'recursive-ref', node: b.id }
  assert.equal(conversionRequiresSourceGuard(reference, resolve), true)
  assert.equal(conversionNeedsPriorSourceGuard(reference, resolve), false)
  nodes.set(a.id, {
    ...a,
    capability: {
      kind: 'product',
      materializer,
      fields: [
        { key: 'next', required: true, capability: reference },
        { key: 'origin', required: true, capability: { kind: 'static', materializer: { ...materializer, requiresSourceGuard: true } } }
      ]
    }
  })
  assert.equal(conversionNeedsPriorSourceGuard(reference, resolve), true)
  assert.equal(conversionRequiresSourceGuard(reference), true)
  assert.equal(
    conversionNeedsPriorSourceGuard(reference, () => null),
    true
  )
  nodes.set(a.id, { ...a, capability: { kind: 'product', materializer, fields: [{ key: 'next', required: true, capability: reference }] } })
  assert.equal(conversionRequiresSourceGuard(reference, resolve), false)
  assert.equal(conversionNeedsPriorSourceGuard(reference, resolve), false)
})

test('a callback whose result is discarded is a plan even when every parameter is the same carrier', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const parameter = { value: string, ownership: 'owned' as const, passing: 'const-ref' as const }
  const source: Representation = {
    kind: 'function-value-dispatch',
    abi: { receiver: null, parameters: [parameter], restFrom: null, result: number }
  }
  const target: Representation = { ...source, abi: { ...source.abi, result: { kind: 'void' } } }
  const plan = callableViewPlan(source, target, (from, into) => census.nodeFor(from, into))
  assert.ok(plan)
  assert.equal(plan.result, null)
  assert.equal(
    callableViewPlan(source, source, (from, into) => census.nodeFor(from, into)),
    null
  )
})
