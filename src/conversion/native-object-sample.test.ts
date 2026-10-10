import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import type { NativeObjectSampleField, NativeObjectSamplePlan } from './native-object-sample.js'
import { recipeClosureOf } from './recipe-closure.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'
import { defaultRecordLayoutPolicy } from '../representation/policies.js'
import type { Representation } from '../representation/model.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const maybeNumber: Representation = { kind: 'optional', absence: 'undefined', payload: number }
const source: NativeObjectSamplePlan['source'] = {
  kind: 'record',
  shapeId: 'sample-source',
  fields: [],
  accessors: [],
  ownership: 'shared-refcount'
}
const targetOf = (value: Representation, required = true): NativeObjectSamplePlan['target'] => ({
  kind: 'record',
  shapeId: 'sample-target',
  fields: [{ key: 'value', value, required }],
  accessors: [],
  ownership: 'owned'
})
const census = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const planOf = (conversions: ReturnType<typeof census>, optional = false): NativeObjectSamplePlan => {
  const target = targetOf(optional ? maybeNumber : number, !optional)
  return {
    source,
    target,
    fields: [
      {
        field: target.fields[0]!,
        from: 'extension',
        storage: number,
        presence: optional ? 'optional' : 'proven',
        present: conversions.nodeFor(number, target.fields[0]!.value),
        absent: optional ? conversions.nodeFor({ kind: 'undefined' }, maybeNumber) : null
      }
    ]
  }
}

test('a closed native slot schema grants a contextual sample without admitting ordinary sidecar inference', () => {
  const conversions = census()
  const plan = planOf(conversions)
  assert.equal(conversions.nodeFor(source, plan.target).capability.kind, 'never')
  const selected = conversions.nativeObjectSampleFor('allocation:one:writer-state:one', plan)
  assert.ok(selected)
  assert.equal(conversions.nodeFor(source, plan.target).capability.kind, 'never')
  assert.equal(conversions.nativeObjectSampleFor('', plan), null)
  assert.equal(conversions.nativeObjectSampleFor('allocation:one:writer-state:one', plan), selected)
  assert.notEqual(conversions.nativeObjectSampleFor('allocation:two:writer-state:one', plan), selected)
  const held = { ...plan, fields: plan.fields.map((field) => ({ ...field, from: 'held' as const })) }
  assert.notEqual(conversions.nativeObjectSampleFor('allocation:one:writer-state:one', held), selected)
})

test('samples retain the exact canonical present and absent conversions and reject detached children', () => {
  const conversions = census()
  const plan = planOf(conversions, true)
  const selected = conversions.nativeObjectSampleFor('allocation:optional', plan)
  assert.ok(selected)
  const closure = recipeClosureOf([selected], conversions.nodeById)
  assert.equal(closure.get(plan.fields[0]!.present.id), plan.fields[0]!.present)
  assert.equal(closure.get(plan.fields[0]!.absent!.id), plan.fields[0]!.absent)
  const foreign: NativeObjectSampleField = { ...plan.fields[0]!, present: { ...plan.fields[0]!.present } }
  assert.equal(conversions.nativeObjectSampleFor('allocation:foreign-child', { ...plan, fields: [foreign] }), null)
})

test('a required target type never proves the current source property is present', () => {
  const conversions = census()
  const plan = planOf(conversions)
  const field = plan.fields[0]!
  const absent = conversions.nodeFor({ kind: 'undefined' }, number)
  assert.equal(
    conversions.nativeObjectSampleFor('allocation:missing', {
      ...plan,
      fields: [{ ...field, presence: 'optional', absent }]
    }),
    null
  )
  assert.equal(
    conversions.nativeObjectSampleFor('allocation:unproved', {
      ...plan,
      fields: [{ ...field, presence: 'optional' }]
    }),
    null
  )
  const optional = planOf(conversions, true)
  const requiredOptional = targetOf(maybeNumber)
  assert.equal(
    conversions.nativeObjectSampleFor('allocation:required-missing', {
      ...optional,
      target: requiredOptional,
      fields: [{ ...optional.fields[0]!, field: requiredOptional.fields[0]! }]
    }),
    null
  )
  assert.equal(
    conversions.nativeObjectSampleFor('allocation:shared-target', {
      ...plan,
      target: { ...plan.target, ownership: 'shared-refcount' } as unknown as NativeObjectSamplePlan['target']
    }),
    null
  )
})

test('a native sample observes its receiver once and reads authenticated native storage without boxing', () => {
  const conversions = census()
  const plan = planOf(conversions, true)
  const selected = conversions.nativeObjectSampleFor('allocation:rendered', plan)
  assert.ok(selected)
  const closure = recipeClosureOf([selected], conversions.nodeById)
  const site = {
    conversions,
    printerDrift: [],
    owner: 'native-object-sample-test',
    layouts: defaultRecordLayoutPolicy,
    classes: new Map(),
    captures: {},
    conversionIsCertified: (id: string) => closure.has(id)
  } as unknown as ConversionSite
  const emitted = recipeText(site, selected, 'sourceWithEffects()')
  assert.ok(emitted)
  assert.equal(emitted.match(/sourceWithEffects\(\)/g)?.length, 1)
  assert.match(emitted, /nativeObjectDataGet<double/)
  assert.doesNotMatch(emitted, /Value::box|unboxedLoad|unreachableValue/)
  assert.match(emitted, /gea_present_value = false/)
})
