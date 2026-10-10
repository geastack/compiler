import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import type { ConversionNode } from './algebra.js'
import { declarationId } from '../identity/ids.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createConversionNodes } from './nodes.js'
import { promiseAdoptionKindOf, promiseAdoptionPlanOf } from './promise-adoption.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const string: Representation = { kind: 'string' }
const nothing: Representation = { kind: 'void' }
const undefinedValue: Representation = { kind: 'undefined' }
const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const promise = (value: Representation): Representation => ({ kind: 'promise', value })
const never: Representation = { kind: 'void', bottom: true }

test('a never-fulfilling promise transfers rejection without demanding a void payload conversion', () => {
  for (const target of [number, string, nothing, undefinedValue, dynamic]) {
    assert.equal(promiseAdoptionKindOf(promise(never), promise(target)), 'rejection-only')
    const plan = promiseAdoptionPlanOf(promise(never), promise(target), () => {
      throw new Error('a rejection-only transfer has no fulfillment payload')
    })
    assert.deepEqual(plan, { kind: 'rejection-only' })
  }
})

test('unit completion transfer supplies or drops only exact undefined', () => {
  for (const [source, target, fulfillment] of [
    [nothing, undefinedValue, 'undefined'],
    [undefinedValue, nothing, 'void'],
    [nothing, dynamic, 'dynamic'],
    [nothing, nothing, 'void']
  ] as const) {
    const plan = promiseAdoptionPlanOf(promise(source), promise(target), () => {
      throw new Error('unit state transfer has no native payload to read')
    })
    assert.deepEqual(plan, { kind: 'unit-transfer', fulfillment })
  }
  assert.equal(promiseAdoptionKindOf(promise(nothing), promise(string)), null)
  assert.equal(promiseAdoptionKindOf(promise(number), promise(nothing)), null)
})

test('payload completion transfer cites the precise admitted leaf conversion', () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const plan = promiseAdoptionPlanOf(promise(number), promise(dynamic), census.nodeFor, census.nodeById)
  assert.ok(plan?.kind === 'payload-transfer')
  assert.equal(plan.conversion.source, number)
  assert.equal(plan.conversion.target, dynamic)
  assert.equal(promiseAdoptionPlanOf(promise(string), promise(number), census.nodeFor), null)
  assert.equal(promiseAdoptionKindOf(number, promise(number)), null)
})

test('future fulfillment cannot inherit an earlier source guard for a nominal downcast', () => {
  const declaration = declarationId('promise-future-guard', 0)
  const base: Representation = { kind: 'class-ref', declaration, shapeId: 'promise-base', ancestors: [], ownership: 'shared-refcount' }
  const derived: Representation = {
    ...base,
    declaration: declarationId('promise-future-guard', 1),
    shapeId: 'promise-derived',
    ancestors: [declaration]
  }
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  assert.notEqual(census.nodeFor(base, derived).capability.kind, 'never')
  assert.equal(promiseAdoptionPlanOf(promise(base), promise(derived), census.nodeFor, census.nodeById), null)
  assert.equal(census.nodeFor(promise(base), promise(derived)).capability.kind, 'never')
  assert.notEqual(census.nodeFor(promise(derived), promise(base)).capability.kind, 'never')
})

test('future fulfillment checks every sealed dependency without borrowing an unrelated guard', () => {
  const guarded: ConversionNode = {
    id: 'future-guarded-payload',
    source: number,
    target: dynamic,
    capability: { kind: 'static', materializer: { id: 'future-guarded', domain: 'test', allocates: false, requiresSourceGuard: true } }
  }
  const outer: ConversionNode = {
    id: 'future-payload',
    source: number,
    target: dynamic,
    capability: { kind: 'static', materializer: { id: 'future-outer', domain: 'test', allocates: false, dependencies: [guarded] } }
  }
  const nodes = new Map([
    [outer.id, outer],
    [guarded.id, guarded]
  ])
  assert.equal(
    promiseAdoptionPlanOf(
      promise(number),
      promise(dynamic),
      () => outer,
      (id) => nodes.get(id) ?? null
    ),
    null
  )
  const checked: ConversionNode = {
    ...guarded,
    capability: {
      kind: 'static',
      materializer: { id: 'future-checked', domain: 'test', allocates: false, requiresSourceGuard: true, executesSourceGuard: true }
    }
  }
  assert.ok(
    promiseAdoptionPlanOf(
      promise(number),
      promise(dynamic),
      () => checked,
      (id) => (id === checked.id ? checked : null)
    )
  )
})

test('promise conversion memoization never lends a never-fulfillment proof to a genuine void promise', () => {
  for (const neverFirst of [true, false]) {
    const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
    const source = promise(never)
    const ordinary = promise(nothing)
    const target = promise(string)
    const first = census.nodeFor(neverFirst ? source : ordinary, target)
    const second = census.nodeFor(neverFirst ? ordinary : source, target)
    const approved = neverFirst ? first : second
    const refused = neverFirst ? second : first
    assert.notEqual(approved.capability.kind, 'never')
    assert.equal(refused.capability.kind, 'never')
    assert.notEqual(approved.id, refused.id)
  }
})
