import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import { nativeSelectionRecipeOf, nativeTotalSelectionRecipeOf, nativeTotalSelectionStepOf } from './native-selection.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeSelectionText } from '../targets/cpp/emit-native-selection.js'
import { nativeSumPlan } from './native-sum.js'
import { widenedNativeSumText } from '../targets/cpp/emit-sum-widening.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const text: Representation = { kind: 'string' }
const point: Extract<Representation, { kind: 'class-ref' }> = {
  kind: 'class-ref',
  declaration: 'point' as never,
  shapeId: 'point-shape',
  ownership: 'shared-refcount',
  ancestors: []
}
const array: Representation = { kind: 'array-object', element: number, ownership: 'shared-refcount', extension: null }
const sum = (...values: Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})

test('mixed nested native sums publish a sealed field-free selection recipe', () => {
  const source = sum({ kind: 'undefined' }, { kind: 'null' }, sum(number, text, point, array))
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, point)
  assert.equal(node.capability.kind, 'atom')
  assert.ok(node.capability.kind === 'atom')
  assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
  const recipe = node.capability.materializer.nativeSelection
  assert.ok(recipe)
  assert.equal(recipe.step.kind, 'dispatch')
  const emitted = nativeSelectionText(recipe, source, point, 'readSourceOnce()')
  assert.ok(emitted)
  assert.equal(emitted.split('readSourceOnce()').length - 1, 1)
  assert.doesNotMatch(emitted, /Value|unbox|nativeDynamic|OwnField/)
  assert.equal(nativeSelectionText(recipe, source, text, 'value'), null)
})

test('a potentially adapting or dynamic alternative cannot be omitted from native selection', () => {
  const unknowns: Representation[] = [
    { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    { kind: 'record', shapeId: 'structural-point', ownership: 'shared-refcount', fields: [], accessors: [] },
    { kind: 'native-record-ref', shapeId: 'host-point', ownership: 'shared-refcount', native: 'HostPoint' }
  ]
  for (const unknown of unknowns) assert.equal(nativeSelectionRecipeOf(sum(point, unknown), point), null, unknown.kind)
  assert.equal(nativeSelectionRecipeOf(sum(number, text), point), null)
})

test('native subset selection retains target arm injection and optional absence', () => {
  const source = sum({ kind: 'undefined' }, number, text, array)
  const target = sum(text, array)
  assert.ok(nativeSelectionRecipeOf(source, target))
  const optional: Representation = { kind: 'optional', absence: 'undefined', payload: target }
  assert.ok(nativeSelectionRecipeOf(source, optional))
  const conflictingArray: Representation = { kind: 'array-object', element: text, ownership: 'shared-refcount', extension: null }
  assert.equal(nativeSelectionRecipeOf(sum(array, conflictingArray), array), null)
})

test('class selections preserve inherited handle casts and collapsed null alternatives', () => {
  const child = { ...point, declaration: 'child' as never, shapeId: 'child-shape', ancestors: [point.declaration] }
  const other = { ...point, declaration: 'other' as never, shapeId: 'other-shape' }
  const recipe = nativeSelectionRecipeOf(sum(point, other, { kind: 'null' }, number), child)
  assert.ok(recipe?.step.kind === 'dispatch')
  assert.equal(recipe.step.arms[0]?.kind, 'class-cast')
  assert.equal(recipe.step.arms[1]?.kind, 'reference-null')
  assert.equal(recipe.step.arms[2]?.kind, 'null')
  assert.equal(recipe.step.arms[3], null)
  assert.ok(nativeSelectionRecipeOf(sum(point, { kind: 'undefined' }), { kind: 'null' }))
  const excludesPoint = sum(number, text, array, { kind: 'null' }, { kind: 'undefined' })
  assert.ok(nativeSelectionRecipeOf(sum(point, number, text, array, { kind: 'null' }, { kind: 'undefined' }), excludesPoint))
  const alias = { ...point, shapeId: 'another-point-shape' }
  const aliases = nativeSelectionRecipeOf(sum(point, alias, number), point)
  assert.ok(aliases?.step.kind === 'dispatch')
  assert.equal(aliases.step.arms[1]?.kind, 'identity')
  const ownedBase = { ...point, ownership: 'owned' as const }
  assert.equal(nativeSelectionRecipeOf(sum(ownedBase, number), { ...child, ownership: 'owned' }), null)
})

test('a union of class descendants widens through a total native identity-preserving selection', () => {
  const left = { ...point, declaration: 'left' as never, ancestors: [point.declaration] }
  const right = { ...point, declaration: 'right' as never, ancestors: [point.declaration] }
  const source = sum(left, right)
  const recipe = nativeTotalSelectionRecipeOf(source, point)
  assert.ok(recipe)
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, point)
  assert.ok(node.capability.kind === 'atom')
  assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
  assert.deepEqual(node.capability.materializer.nativeSelection, recipe)
  const emitted = nativeSelectionText(recipe, source, point, 'chooseOnce()')
  assert.ok(emitted)
  assert.equal(emitted.split('chooseOnce()').length - 1, 1)
  assert.doesNotMatch(emitted, /Value|unbox|nativeDynamic|OwnField/)
  assert.equal(nativeTotalSelectionRecipeOf(sum(point, right), left), null, 'downcasts are not total widening')
  assert.equal(nativeTotalSelectionRecipeOf(sum(left, text), point), null, 'widening cannot discard a live string')
  assert.equal(nativeTotalSelectionRecipeOf(sum(left, { ...point, declaration: 'unrelated' as never }), point), null)
})

test('native sum widening preserves explicit null inside nullable handles without spending undefined absence', () => {
  const child = { ...point, declaration: 'child' as never, ancestors: [point.declaration] }
  const source: Representation = { kind: 'optional', payload: sum(point, array), absence: 'null' }
  const target: Representation = { kind: 'optional', payload: sum(child, point, array), absence: 'undefined' }
  const plan = nativeSumPlan(source, target)
  assert.ok(plan?.kind === 'optional')
  assert.equal(plan.absence, 'null')
  assert.ok(plan.absent.kind === 'wrap', 'null must remain present under the undefined optional')
  assert.ok(plan.absent.payload.kind === 'wrap')
  assert.equal(plan.absent.payload.payload.kind, 'null-reference')
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, target)
  assert.ok(node.capability.kind === 'atom' || node.capability.kind === 'static')
  assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
  const emitted = widenedNativeSumText(source, target, 'readOnce()')
  assert.ok(emitted)
  assert.equal(emitted.split('readOnce()').length - 1, 1)
  assert.doesNotMatch(emitted, /Value|unbox|nativeDynamic|OwnField/)
  assert.equal(nativeSumPlan({ kind: 'undefined' }, sum(point, child)), null)
  assert.equal(nativeSumPlan({ kind: 'null' }, sum({ ...point, ownership: 'owned' })), null)
  const explicitNull = nativeSumPlan({ kind: 'null' }, sum(child, point, { kind: 'null' }))
  assert.ok(explicitNull?.kind === 'wrap')
  assert.equal(explicitNull.index, 2, 'an explicit null arm takes precedence over nullable handle storage')
  assert.equal(explicitNull.payload.kind, 'identity')
  const descendant = { ...point, declaration: 'descendant' as never, ancestors: [child.declaration, point.declaration] }
  assert.equal(nativeSumPlan(descendant, sum(child, point)), null, 'multiple non-null nominal homes remain ambiguous')
})

test('a live leaf alternative selects only total steps, including null into a shared handle', () => {
  const child = { ...point, declaration: 'child' as never, shapeId: 'child-shape', ancestors: [point.declaration] }
  assert.equal(nativeTotalSelectionStepOf(point, point)?.kind, 'identity')
  assert.equal(nativeTotalSelectionStepOf({ kind: 'null' }, point)?.kind, 'null')
  const upcast = nativeTotalSelectionStepOf(child, point)
  assert.ok(upcast?.kind === 'class-cast')
  assert.equal(upcast.down, false)
  assert.equal(nativeTotalSelectionStepOf(number, sum(number, text))?.kind, 'transfer')
  assert.equal(nativeTotalSelectionStepOf(point, child), null, 'a downcast is not total')
  assert.equal(nativeTotalSelectionStepOf({ kind: 'undefined' }, point), null, 'undefined has no home in a bare handle')
  assert.equal(nativeTotalSelectionStepOf({ ...point, declaration: 'other' as never, shapeId: 'other-shape' }, point), null)
  assert.equal(nativeTotalSelectionStepOf({ kind: 'null' }, { ...point, ownership: 'owned' }), null)
  assert.equal(nativeTotalSelectionStepOf(array, number), null)
})
