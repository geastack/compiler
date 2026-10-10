import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { declarationId, functionId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from '../conversion/recipe-closure.js'
import { nativeUnboundMethodText } from '../targets/cpp/emit-native-method.js'
import type { GetOperation, IrBody } from './model.js'
import { deferredMethodValuesOf, nativeMethodFrameInputsOf, nativeMethodSourceInputsOf } from './native-method-frames.js'
import { operationConversionInputsOf, operationConversionsOf } from './operation-conversions.js'

const classRef = (ordinal: number): Representation => ({
  kind: 'class-ref',
  declaration: declarationId('native-method-frame', ordinal),
  shapeId: `method-instance-${ordinal}`,
  ownership: 'shared-refcount',
  ancestors: []
})
const receiver = classRef(0)
const sibling = classRef(1)
const callable = functionId(declarationId('native-method-frame', 2))
const abi: CallableAbi = { receiver, parameters: [], result: { kind: 'void' }, restFrom: null }
const source: Representation = { kind: 'function-value-dispatch', abi }
const get = (target: Representation): GetOperation =>
  ({
    kind: 'get',
    receiver: { value: 'receiver', representation: receiver },
    key: { value: 'key', representation: { kind: 'string' } },
    result: { id: 'method', representation: target }
  }) as unknown as GetOperation
const classes = new Map([
  [
    (receiver as Extract<Representation, { kind: 'class-ref' }>).declaration,
    {
      declaration: (receiver as Extract<Representation, { kind: 'class-ref' }>).declaration,
      base: null,
      nativeBase: null,
      instance: receiver,
      fields: [],
      accessors: [],
      methods: [{ key: 'probe', callable, representation: source }],
      methodOverrides: []
    } as unknown as ClassLayout
  ]
])
const abis = new Map([[callable, abi]])

test('erased construction remains native without inventing an unimplemented method body', () => {
  const root = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')
  const result = compile({
    rootFileNames: [root],
    projectFileName: null,
    sourceOverlay: new Map([
      [
        root,
        `export {}
          abstract class Missing { abstract process(): boolean }
          const value: Missing = new (Missing as any)()
        `
      ]
    ]),
    includeIr: true
  })
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.ok(
    result.irBodies?.some((body) =>
      [...body.blocks.values()].some((block) =>
        block.operations.some((operation) => operation.kind === 'construct' && operation.result.representation.kind === 'class-ref')
      )
    )
  )
  assert.doesNotMatch(result.source!, /is abstract and no class/)
})

test('an evaluated native method read requires an executable body instead of an aborting callable substitute', () => {
  const root = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')
  for (const implementation of [false, true]) {
    const result = compile({
      rootFileNames: [root],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          root,
          `export {}
            ${implementation ? 'class Missing { process(): boolean { return true } }' : 'abstract class Missing { abstract process(): boolean }'}
            const value: Missing = new (Missing as any)()
            console.log(value.process())
          `
        ]
      ]),
      includeIr: true
    })
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    if (implementation) {
      assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
      assert.notEqual(result.source, null, JSON.stringify(result.refusals))
    } else {
      assert.equal(result.certificate, null)
      assert.equal(result.source, null)
      assert.ok(
        result.certification?.refusals.some((refusal) => refusal.key === 'property-access:computed-class-method-virtual'),
        JSON.stringify(result.refusals)
      )
      assert.equal(result.emissionRefusals.length, 0, 'the missing body must be rejected before printing')
    }
  }
})

test('an unused concrete subclass cannot supply a missing method for a constructed base or its own prototype', () => {
  const root = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')
  for (const prototype of [false, true]) {
    const result = compile({
      rootFileNames: [root],
      projectFileName: null,
      sourceOverlay: new Map([
        [
          root,
          `export {}
            abstract class Missing { abstract process(): boolean }
            class UnusedConcrete extends Missing { process(): boolean { return true } }
            ${prototype ? 'console.log(Missing.prototype.process)' : 'const value: Missing = new (Missing as any)(); console.log(value.process())'}
          `
        ]
      ]),
      includeIr: true
    })
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.equal(result.source, null, 'the unused subclass must not fabricate a callable for the base')
    assert.ok(
      result.refusals.some(
        (refusal) =>
          refusal.key === 'property-access:computed-class-method-virtual' ||
          refusal.key === 'property-access:class-prototype:abstract-method'
      ),
      JSON.stringify(result.refusals)
    )
  }
})

test('an unknown native computed key publishes the same finite prototype method domain used by its dynamic read', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const frames = nativeMethodFrameInputsOf(get(dynamic), null, classes, abis)
  assert.deepEqual(
    frames.map((frame) => [representationKey(frame.source), representationKey(frame.target)]),
    [[representationKey(source), representationKey(dynamic)]]
  )
})

test('dynamic native reads seal derived-only prototype bodies and preserve missing allocations', () => {
  const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
  const root = (receiver as Extract<Representation, { kind: 'class-ref' }>).declaration
  const derived = (sibling as Extract<Representation, { kind: 'class-ref' }>).declaration
  const own = functionId(declarationId('native-method-frame', 7))
  const derivedAbi: CallableAbi = { ...abi, receiver: sibling }
  const family = new Map(classes)
  family.set(root, { ...family.get(root)!, methods: [] })
  family.set(derived, {
    ...family.get(root)!,
    declaration: derived,
    base: root,
    instance: sibling,
    methods: [{ key: 'introduced', callable: own }]
  })
  const sources = nativeMethodSourceInputsOf(get(dynamic), null, family, new Map([[own, derivedAbi]]))
  assert.equal(sources.length, 1)
  assert.equal(sources[0]!.callable, own)
  assert.equal(sources[0]!.key, 'introduced')
  assert.equal(representationKey(sources[0]!.source), representationKey({ kind: 'function-value-dispatch', abi: derivedAbi }))
})

test('a nonoverridden generic method read selects the copy held by its published frame', () => {
  const stringAbi: CallableAbi = { ...abi, result: { kind: 'string' } }
  const numberAbi: CallableAbi = { ...abi, result: { kind: 'scalar', domain: 'number' } }
  const stringCallable = functionId(declarationId('native-method-frame', 3))
  const target: Representation = { kind: 'function-value-dispatch', abi: stringAbi }
  const split = new Map(
    [...classes].map(([declaration, layout]) => [
      declaration,
      {
        ...layout,
        methods: [
          { key: 'probe', callable, representation: { kind: 'function-value-dispatch' as const, abi: numberAbi } },
          { key: 'probe', callable: stringCallable, representation: target }
        ]
      }
    ])
  )
  const sources = nativeMethodSourceInputsOf(
    get(target),
    'probe',
    split,
    new Map([
      [callable, numberAbi],
      [stringCallable, stringAbi]
    ])
  )
  assert.equal(sources.length, 1)
  assert.equal(sources[0]!.callable, stringCallable)
  assert.equal(representationKey(sources[0]!.source), representationKey(target))
})

test('a materialized method cannot acquire an unrelated sibling body receiver by printing', () => {
  const target: Representation = { kind: 'function-value-dispatch', abi: { ...abi, receiver: sibling } }
  const operation = get(target)
  const frames = nativeMethodFrameInputsOf(operation, 'probe', classes, abis)
  assert.equal(frames.length, 1)
  assert.equal(representationKey(frames[0]!.source), representationKey(source))
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const deriver = {
    layoutOf: (shapeId: string): Representation => ({
      kind: 'record',
      shapeId,
      ownership: 'shared-refcount',
      fields: [],
      accessors: []
    })
  } as unknown as RepresentationDeriver
  const inputs = operationConversionInputsOf(operation, 'probe', deriver, classes, false, abis)
  assert.equal(inputs[0]?.role, 'method-frame')
  const recipes = operationConversionsOf(inputs, census)
  assert.equal(census.nodeById(recipes[0]!.conversion)?.capability.kind, 'never')
  assert.equal(census.nativeMethodFor(source, target), null)
})

test('only exclusively immediate settled native calls defer the method Function object', () => {
  const operation = get(source)
  const bodyOf = (target: 'direct' | 'virtual' | 'union-arm' | 'unresolved', escape: boolean): IrBody =>
    ({
      abi: null,
      blocks: new Map([
        [
          'block',
          {
            operations: [
              operation,
              {
                kind: 'call',
                target: { kind: target },
                callee: { value: operation.result.id, representation: source },
                receiver: null,
                arguments: [],
                result: { id: 'call-result', representation: { kind: 'void' } }
              },
              ...(escape
                ? [
                    {
                      kind: 'binding-write',
                      declaration: declarationId('native-method-frame', 3),
                      value: { value: operation.result.id, representation: source }
                    }
                  ]
                : [])
            ],
            terminator: { kind: 'return', value: null }
          }
        ]
      ])
    }) as unknown as IrBody
  for (const target of ['direct', 'virtual', 'union-arm'] as const) {
    assert.equal(deferredMethodValuesOf(bodyOf(target, false)).has(operation.result.id), true)
    assert.equal(deferredMethodValuesOf(bodyOf(target, true)).has(operation.result.id), false)
  }
  assert.equal(deferredMethodValuesOf(bodyOf('unresolved', false)).has(operation.result.id), false)
})

test('source-only receiver erasure certifies discarded argument frames before rendering', () => {
  const string: Representation = { kind: 'string' }
  const target: Representation = {
    kind: 'function-value-dispatch',
    abi: {
      ...abi,
      receiver: null,
      parameters: [string, string, string].map((value) => ({ value, ownership: 'owned', passing: 'const-ref' }))
    }
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.equal(census.nodeFor(source, target).capability.kind, 'never')
  const node = census.nativeMethodFor(source, target)
  assert.ok(node?.capability.kind === 'static')
  const method = node.capability.materializer.nativeMethod
  assert.ok(method?.frameAdaptation)
  assert.notEqual(method.frameAdaptation.capability.kind, 'never')
  assert.deepEqual(
    node.capability.materializer.dependencies?.map((child) => child.id),
    [method.frameAdaptation.id]
  )
  const text = nativeUnboundMethodText(method, 'source_method', (child, value) => {
    assert.equal(child.id, method.frameAdaptation!.id)
    return `certified_frame(${value})`
  })
  assert.ok(text.includes('unboundMethod(certified_frame(source_method))'))
})

test('a native method selected from one union arm authenticates logical this after public-frame adaptation', () => {
  const union: Representation = {
    kind: 'tagged-union',
    arms: [receiver, sibling].map((value, ordinal) => ({
      tag: String(ordinal),
      value,
      semanticType: String(ordinal) as never,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  }
  const target: Representation = { kind: 'function-value-dispatch', abi: { ...abi, receiver: union } }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const ordinary = census.nodeFor(source, target)
  assert.ok(ordinary.capability.kind === 'atom')
  const selection = ordinary.capability.materializer.callableView?.receiver
  assert.ok(selection?.capability.kind === 'atom')
  assert.equal(selection.capability.materializer.requiresSourceGuard, true)
  assert.equal(selection.capability.materializer.executesSourceGuard, true)
  assert.equal(recipeIsMaterializableWithoutPriorSourceGuard(ordinary, census.nodeById), true)
  const node = census.nativeMethodFor(source, target)
  assert.ok(node?.capability.kind === 'static')
  const method = node.capability.materializer.nativeMethod
  assert.ok(method?.publicAdaptation)
  assert.notEqual(method.publicAdaptation.capability.kind, 'never')
  const text = nativeUnboundMethodText(method, 'source_method', (child, value) => {
    assert.equal(child.id, method.publicAdaptation!.id)
    return `certified_public_frame(${value})`
  })
  assert.ok(text.startsWith('certified_public_frame('))
  assert.ok(text.includes('unboundMethod(source_method)'))
  assert.ok(!text.includes('bindReceiver'))
})

test('the generic override gap is rejected by certification before any printer attempts the method frame', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/generic-reader-override-at-any-family-copies.runtime.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true
  })
  assert.ok(result.certification)
  assert.equal(result.certification.certified, false)
  assert.ok(result.certification.refusals.some((refusal) => refusal.reason.includes('method compiled for receivers')))
  assert.equal(result.printerDrift.filter((row) => row.kind === 'refused').length, 0)
})
