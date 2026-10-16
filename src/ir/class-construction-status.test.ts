import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { capabilityKeysOf, type CertifyContext } from './certify.js'
import { classConstructionStatusMatches } from './class-construction-status.js'
import type { AllocateConstructorOperation } from './model.js'

const allocation = (deferred = false): AllocateConstructorOperation => ({
  kind: 'allocate-constructor',
  lineage: 'class-allocation' as never,
  declaration: 'class' as never,
  captures: [],
  ...(deferred ? { constructionDeferred: true as const } : {}),
  result: {
    id: 'class-value' as never,
    representation: {
      kind: 'constructor-family',
      members: ['class' as never],
      abi: { receiver: null, parameters: [], result: { kind: 'void' }, restFrom: null }
    }
  }
})
const semantic = (deferred: boolean): SemanticOperation =>
  ({
    family: 'allocation',
    allocated: 'class-constructor-object',
    ...(deferred ? { classConstructionDeferred: true } : {})
  }) as SemanticOperation
const context = (source: SemanticOperation | null): CertifyContext =>
  ({
    semanticOperationOf: () => source,
    classes: new Map(),
    deriver: { derive: () => allocation().result.representation },
    body: { tryRegions: [] },
    definitionOf: () => null
  }) as unknown as CertifyContext

test('construct-entry status must match the exact semantic allocation', () => {
  for (const deferred of [false, true]) {
    assert.equal(classConstructionStatusMatches(allocation(deferred), semantic(deferred), context(semantic(deferred))), true)
    assert.equal(classConstructionStatusMatches(allocation(!deferred), semantic(deferred), context(semantic(deferred))), false)
  }
  assert.equal(classConstructionStatusMatches(allocation(true), null), false)
  assert.equal(classConstructionStatusMatches(allocation(true), { family: 'computation' } as SemanticOperation), false)
})

test('certification refuses forged, dropped and borrowed definition-only status', () => {
  for (const [operation, source] of [
    [allocation(true), semantic(false)],
    [allocation(false), semantic(true)],
    [allocation(true), null],
    [allocation(true), { family: 'allocation', allocated: 'function-object', classConstructionDeferred: true } as SemanticOperation]
  ] as const) {
    const refusal = capabilityKeysOf(operation, context(source)).find((item) => item.key === 'call-abi:class-construction-status')
    assert.equal(refusal?.verdict, 'missing')
  }
  for (const deferred of [false, true])
    assert.equal(
      capabilityKeysOf(allocation(deferred), context(semantic(deferred))).some((item) => item.verdict === 'missing'),
      false
    )
})

const allocationsOf = (source: string) => {
  const entry = resolve('test/fixtures/definition-only-class-entry.ts')
  const result = compile({ rootFileNames: [entry], projectFileName: null, includeIr: true, sourceOverlay: new Map([[entry, source]]) })
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals))
  const operations = result.irBodies!.flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
  return {
    result,
    allocations: operations.filter((operation): operation is AllocateConstructorOperation => operation.kind === 'allocate-constructor')
  }
}

test('static definition receiver retains evaluation identity without a dormant construct thunk', () => {
  const { result, allocations } = allocationsOf(`
    function effect(name:string){console.log(name);return 1}
    class Dormant { static ready=effect('definition'); value=effect('DORMANT_INSTANCE_MUST_NOT_RUN');
      constructor(){console.log('DORMANT_CONSTRUCTOR_MUST_NOT_RUN')} }
    console.log('entry')
  `)
  assert.equal(allocations.length, 1)
  assert.equal(allocations[0]!.constructionDeferred, true)
  assert.ok(result.source!.includes('{nullptr, gea::allocateNativeClassMethodEnvironment<'))
  assert.ok(!result.source!.includes('DORMANT_INSTANCE_MUST_NOT_RUN'))
  assert.ok(!result.source!.includes('DORMANT_CONSTRUCTOR_MUST_NOT_RUN'))
})

for (const [label, source] of [
  [
    'static new this',
    `class Live { static instance=new this(); value=1; constructor(){console.log('live')} } console.log(Live.instance.value)`
  ],
  [
    'static explicit construction',
    `class Live { static instance=new Live(); value=1; constructor(){console.log('live')} } console.log(Live.instance.value)`
  ],
  [
    'escaped constructor',
    `class Live { static ready=1;value=1;constructor(){console.log('live')} }
    function construct(C:typeof Live){return new C()} console.log(construct(Live).value)`
  ]
] as const)
  test(`${label} retains the real construct entry`, () => {
    const { result, allocations } = allocationsOf(source)
    assert.ok(allocations.length > 0)
    assert.ok(allocations.every((operation) => operation.constructionDeferred === undefined))
    assert.ok(!result.source!.includes('{nullptr, gea::allocateNativeClassMethodEnvironment<'))
    assert.ok(result.source!.includes('live'))
  })

test('definition-only static block receiver preserves the projected construction status', () => {
  const { result, allocations } = allocationsOf(`class Dormant {
    static { console.log(this.name) }
    constructor(){console.log('DORMANT_CONSTRUCTOR_MUST_NOT_RUN')}
  } console.log('entry')`)
  assert.ok(allocations.length > 0)
  assert.ok(allocations.every((operation) => operation.constructionDeferred === true))
  assert.ok(!result.source!.includes('DORMANT_CONSTRUCTOR_MUST_NOT_RUN'))
})

test('static block deferral cannot borrow another receiver or absent class layout', () => {
  const reference = {
    family: 'reference',
    form: 'this',
    operands: [{ role: 'static-class-receiver', source: { kind: 'receiver' }, type: 'class-type' }]
  } as unknown as SemanticOperation
  const classes = new Map([['class' as never, { constructionDeferred: true } as never]])
  const deriver = { derive: () => allocation().result.representation }
  const exact = { classes, deriver }
  assert.equal(classConstructionStatusMatches(allocation(true), reference, exact), true)
  assert.equal(classConstructionStatusMatches(allocation(), reference, exact), false)
  assert.equal(classConstructionStatusMatches(allocation(true), reference), false)
  assert.equal(classConstructionStatusMatches(allocation(true), reference, { ...exact, classes: new Map() }), false)
  assert.equal(classConstructionStatusMatches({ ...allocation(true), declaration: 'other' as never }, reference, exact), false)
  const wrongResult = {
    ...allocation(true),
    result: {
      id: 'other-result' as never,
      representation: {
        ...allocation().result.representation,
        kind: 'constructor-family' as const,
        members: ['other' as never],
        abi: { receiver: null, parameters: [], result: { kind: 'void' as const }, restFrom: null }
      }
    }
  }
  assert.equal(classConstructionStatusMatches(wrongResult, reference, exact), false)
  const wrongRole = {
    ...reference,
    operands: [{ role: 'receiver', source: { kind: 'receiver' }, type: 'class-type' }]
  } as unknown as SemanticOperation
  assert.equal(classConstructionStatusMatches(allocation(true), wrongRole, exact), false)
  assert.equal(
    classConstructionStatusMatches(allocation(true), reference, { ...exact, deriver: { derive: () => ({ kind: 'string' }) } }),
    false
  )
})

test('static block identity observation uses the one original constructor allocation', () => {
  const { allocations } = allocationsOf(`class IdentityObserved { static { console.log(this === IdentityObserved) } }`)
  assert.equal(allocations.length, 1, 'static block receiver comes from its actual callable ABI')
})

test('ordinary allocation cannot borrow a different class physical constructor identity', () => {
  const source = semantic(true)
  const ctx = context(source)
  for (const operation of [
    { ...allocation(true), declaration: 'other' as never },
    {
      ...allocation(true),
      result: {
        id: 'other-result' as never,
        representation: {
          ...allocation().result.representation,
          kind: 'constructor-family' as const,
          members: ['other' as never],
          abi: { receiver: null, parameters: [], result: { kind: 'void' as const }, restFrom: null }
        }
      }
    }
  ]) {
    const refusal = capabilityKeysOf(operation, ctx).find((item) => item.key === 'call-abi:class-construction-status')
    assert.equal(refusal?.verdict, 'missing')
  }
  assert.equal(classConstructionStatusMatches(allocation(true), source), false)
})

test('actual imported construction-effects fixture retains its exact deferred allocation', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/class-definition-construction-effects.runtime.ts')],
    projectFileName: null,
    includeIr: true
  })
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals))
  const allocations = result
    .irBodies!.flatMap((body) => [...body.blocks.values()].flatMap((block) => block.operations))
    .filter((operation): operation is AllocateConstructorOperation => operation.kind === 'allocate-constructor')
  assert.equal(allocations.filter((operation) => operation.constructionDeferred).length, 1)
  assert.ok(!result.source!.includes('DORMANT_CONSTRUCTOR_MUST_NOT_RUN'))
})

test('generic class copies authenticate their derived physical constructor rather than source spelling', () => {
  const { allocations } = allocationsOf(`class Box<T> {
    value:T; constructor(value:T){this.value=value}
  } console.log(new Box(1).value,new Box('two').value)`)
  assert.ok(allocations.length > 0)
  assert.ok(allocations.every((operation) => operation.constructionDeferred === undefined))
})
