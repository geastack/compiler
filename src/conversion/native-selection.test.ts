import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../representation/model.js'
import {
  nativeSelectionGuardContractOf,
  nativeSelectionPreservesPayload,
  nativeSelectionRecipeOf,
  nativeSubsetSelectionRecipeOf,
  nativeTotalSelectionRecipeOf,
  nativeTotalSelectionStepOf
} from './native-selection.js'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { classDocumentViewText } from '../targets/cpp/emit-narrowing.js'
import { nativeSelectionBody, nativeSelectionText } from '../targets/cpp/emit-native-selection.js'
import { nativeSumPlan, nativeSumPreservesPayload } from './native-sum.js'
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

test('an open Document conversion retains both native record and dictionary alternatives', () => {
  const document: Representation = {
    kind: 'dictionary',
    key: 'string',
    value: { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
    ownership: 'shared-refcount'
  }
  const record: Representation = {
    kind: 'record',
    shapeId: 'document-source',
    fields: [{ key: 'authSource', value: text, required: true }],
    accessors: [],
    ownership: 'shared-refcount'
  }
  const source = sum(record, document)
  const registry = createCppConversionRegistry()
  const census = createConversionNodes({ registry, nodes: new Map() })
  const node = census.nodeFor(source, document)
  assert.equal(registry.narrowing(source, document), null)
  assert.ok(node.capability.kind === 'static')
  assert.equal(node.capability.materializer.id, 'chain:class-document-view')
  const emitted = classDocumentViewText(source, document, 'readOnce()')
  assert.ok(emitted)
  assert.match(emitted, /aliasOf\(gea_source.template get<0>\(\)\)/)
  assert.match(emitted, /gea_source.template get<1>\(\)/)
  assert.equal(emitted.split('readOnce()').length - 1, 1)
  assert.doesNotMatch(emitted, /Value::box|refusePayloadMismatch/)
  assert.equal(classDocumentViewText(sum(record, document, { kind: 'symbol' }), document, 'source'), null)
})

test('integer storage enters the numeric arm of optional CSS unions without boxing', () => {
  for (const integerWidth of ['int32', 'int64'] as const) {
    const source: Representation = { kind: 'scalar', domain: 'number', integerWidth }
    const target: Representation = { kind: 'optional', payload: sum(number, text), absence: 'undefined' }
    const plan = nativeSumPlan(source, target)
    assert.ok(plan?.kind === 'wrap' && plan.payload.kind === 'wrap')
    assert.equal(plan.payload.index, 0)
    assert.equal(plan.payload.payload.kind, 'number-storage')
    assert.equal(nativeSumPreservesPayload(plan), false)
    const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
    const node = census.nodeFor(source, target)
    assert.ok(node.capability.kind === 'atom')
    assert.equal(node.capability.materializer.nativeFieldProtocol, 'unused')
    assert.equal(node.capability.materializer.allocates, false)
    assert.equal(node.capability.materializer.nativePayloadTransport, undefined)
    const emitted = widenedNativeSumText(source, target, 'readOnce()')
    assert.ok(emitted)
    assert.match(emitted, /static_cast<double>/)
    assert.equal(emitted.split('readOnce()').length - 1, 1)
    assert.doesNotMatch(emitted, /Value|unbox|nativeDynamic|OwnField/)
  }
})

test('numeric sum conversion retains optional absence and every live union alternative', () => {
  const integer: Representation = { kind: 'scalar', domain: 'number', integerWidth: 'int32' }
  const source: Representation = { kind: 'optional', payload: sum(integer, text), absence: 'undefined' }
  const target: Representation = { kind: 'optional', payload: sum(text, sum(number, { kind: 'null' })), absence: 'undefined' }
  const plan = nativeSumPlan(source, target)
  assert.ok(plan?.kind === 'optional' && plan.present.kind === 'dispatch')
  assert.equal(plan.absent.kind, 'empty')
  assert.equal(plan.present.arms.length, 2)
  assert.equal(nativeSumPreservesPayload(plan), false)
  const selection = nativeTotalSelectionRecipeOf(source, target)
  assert.ok(selection)
  assert.equal(nativeSelectionPreservesPayload(selection), false)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const conversion = census.nodeFor(source, target)
  assert.ok(conversion.capability.kind === 'atom')
  assert.equal(conversion.capability.materializer.nativeFieldProtocol, 'unused')
  assert.equal(conversion.capability.materializer.nativePayloadTransport, undefined)
  assert.equal(nativeSumPlan(source, { kind: 'optional', payload: number, absence: 'undefined' }), null, 'a live string cannot disappear')
  const emitted = widenedNativeSumText(source, target, 'readOnce()')
  assert.ok(emitted)
  assert.match(emitted, /has_value\(\)/)
  assert.match(emitted, /static_cast<double>/)
  assert.equal(emitted.split('readOnce()').length - 1, 1)
})

test('numeric unions prefer exact storage and refuse multiple non-exact numeric homes', () => {
  const narrow: Representation = { kind: 'scalar', domain: 'number', integerWidth: 'int32' }
  const wide: Representation = { kind: 'scalar', domain: 'number', integerWidth: 'int64' }
  const exact = nativeSumPlan(narrow, sum(number, wide, narrow))
  assert.ok(exact?.kind === 'wrap')
  assert.equal(exact.index, 2)
  assert.equal(exact.payload.kind, 'identity')
  assert.equal(nativeSumPreservesPayload(exact), true)
  assert.equal(nativeSumPlan(number, sum(narrow, wide)), null)
  assert.equal(nativeSumPlan(wide, sum(narrow, number)), null)
  assert.equal(nativeSumPlan(narrow, sum(text)), null)
  assert.equal(nativeSumPlan({ kind: 'scalar', domain: 'boolean' }, sum(number, text)), null)
  const conversion = widenedNativeSumText(number, sum(text, narrow), 'readOnce()')
  assert.ok(conversion)
  assert.match(conversion, /toDeclaredInteger<int32_t>/)
  assert.equal(conversion.split('readOnce()').length - 1, 1)
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

test('an admitted exact native subset checks omitted opaque tags and preserves Optional absence', () => {
  const module: Representation = { kind: 'native-record-ref', shapeId: 'module', native: null, ownership: 'shared-refcount' }
  const error: Representation = {
    kind: 'record',
    shapeId: 'module-error',
    ownership: 'shared-refcount',
    fields: [{ key: 'error', value: point, required: true }],
    accessors: []
  }
  const proxy: Representation = { kind: 'proxy-object', target: module, handler: error }
  const source: Representation = { kind: 'optional', payload: sum(module, error, proxy), absence: 'undefined' }
  const target: Representation = { kind: 'optional', payload: sum(module, proxy), absence: 'undefined' }
  assert.equal(nativeSelectionRecipeOf(source, target), null, 'category analysis cannot exclude an opaque object')
  const recipe = nativeSubsetSelectionRecipeOf(source, target)
  assert.ok(recipe?.step.kind === 'optional')
  assert.ok(recipe.step.present?.kind === 'dispatch')
  assert.equal(recipe.step.present.arms[1], null)
  assert.ok(recipe.step.absent?.kind === 'transfer' && recipe.step.absent.plan.kind === 'empty')
  assert.deepEqual(nativeSelectionGuardContractOf(recipe), { requiresSourceGuard: true, executesSourceGuard: true })
  assert.equal(nativeSelectionPreservesPayload(recipe), true)
  assert.equal(nativeTotalSelectionRecipeOf(source, target), null, 'this is checked selection, never a total store')

  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, target)
  assert.ok(node.capability.kind === 'atom')
  const materializer = node.capability.materializer
  assert.deepEqual(materializer.nativeSelection, recipe)
  assert.equal(materializer.nativePayloadTransport, 'preserved')
  assert.equal(materializer.nativeFieldProtocol, 'unused')
  assert.equal(materializer.recordView, undefined)
  assert.equal(materializer.allocates, false)
  const body = nativeSelectionBody(recipe, source, target)
  assert.ok(body)
  assert.match(body, /has_value\(\)/)
  assert.match(body, /is<0>/)
  assert.match(body, /is<2>/)
  assert.doesNotMatch(body, /is<1>/)
  assert.match(body, /native sum selection has no matching alternative/)
  assert.doesNotMatch(body, /makeRef|makeViewWithOrigin|Value::box|unbox|OwnField/)
})

test('an exact reordered record subset rejects Optional absence without rebuilding either native arm', () => {
  const record: Representation = {
    kind: 'record',
    shapeId: 'constructor-options',
    ownership: 'shared-refcount',
    fields: [{ key: 'offset', value: number, required: true }],
    accessors: []
  }
  const named: Representation = { kind: 'native-record-ref', shapeId: 'constructor-options', native: null, ownership: 'shared-refcount' }
  const source: Representation = { kind: 'optional', payload: sum(record, named), absence: 'undefined' }
  const target = sum(named, record)
  const recipe = nativeSubsetSelectionRecipeOf(source, target)
  assert.ok(recipe?.step.kind === 'optional' && recipe.step.present?.kind === 'dispatch')
  assert.equal(recipe.step.absent, null)
  for (const [index, arm] of recipe.step.present.arms.entries()) {
    assert.ok(arm?.kind === 'transfer' && arm.plan.kind === 'wrap')
    assert.equal(arm.plan.index, 1 - index)
    assert.equal(arm.plan.payload.kind, 'identity')
  }
  assert.deepEqual(nativeSelectionGuardContractOf(recipe), { requiresSourceGuard: true, executesSourceGuard: true })
  const body = nativeSelectionBody(recipe, source, target)
  assert.ok(body)
  assert.match(body, /else \{\s*\}/)
  assert.match(body, /native sum selection has no matching alternative/)
  assert.doesNotMatch(body, /makeRef|makeViewWithOrigin|Value::box|unbox|OwnField/)
})

test('an admitted bare record arm retains the exact native allocation and rejects omitted tags', () => {
  const legacy: Representation = { kind: 'native-record-ref', shapeId: 'legacy', native: null, ownership: 'shared-refcount' }
  const modern: Representation = { kind: 'native-record-ref', shapeId: 'modern', native: null, ownership: 'shared-refcount' }
  const source = sum(legacy, modern)
  const recipe = nativeSubsetSelectionRecipeOf(source, legacy)
  assert.ok(recipe?.step.kind === 'dispatch')
  assert.equal(recipe.step.arms[0]?.kind, 'identity')
  assert.equal(recipe.step.arms[1], null)
  assert.deepEqual(nativeSelectionGuardContractOf(recipe), { requiresSourceGuard: true, executesSourceGuard: true })
  const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = conversions.nodeFor(source, legacy)
  assert.equal(node.capability.kind, 'atom')
  assert.ok('materializer' in node.capability)
  assert.deepEqual(node.capability.materializer.nativeSelection, recipe)
  assert.equal(node.capability.materializer.nativePayloadTransport, 'preserved')
  assert.equal(node.capability.materializer.allocates, false)
  const emitted = nativeSelectionBody(recipe, source, legacy)
  assert.ok(emitted)
  assert.match(emitted, /is<0>/)
  assert.doesNotMatch(emitted, /is<1>|makeRef|makeLiveView|Value|OwnField/)
  assert.match(emitted, /native sum selection has no matching alternative/)
})

test('exact subset selection does not invent reconstructed or downcast destination homes', () => {
  const record = (shapeId: string): Representation => ({
    kind: 'record',
    shapeId,
    ownership: 'shared-refcount',
    fields: [{ key: 'x', value: number, required: true }],
    accessors: []
  })
  assert.equal(nativeSubsetSelectionRecipeOf(sum(record('source'), text), sum(record('target'), text)), null)
  assert.equal(nativeSubsetSelectionRecipeOf(sum(record('source'), text), record('target')), null)
  const child = { ...point, declaration: 'child' as never, ancestors: [point.declaration] }
  assert.equal(nativeSubsetSelectionRecipeOf(sum(point, text), sum(child, text)), null)
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

test('a null-only native reference selection rejects the distinct undefined sentinel', () => {
  const source = sum(point, number)
  const target: Representation = { kind: 'null' }
  const recipe = nativeSelectionRecipeOf(source, target)
  assert.ok(recipe?.step.kind === 'dispatch')
  const selected = recipe.step.arms[0]
  assert.ok(selected?.kind === 'reference-null')
  assert.equal(selected.undefined, undefined)
  const body = nativeSelectionBody(recipe, source, target)
  assert.ok(body)
  assert.match(body, /&& !\([^;]+\)\.isUndefined\(\)/)
  assert.match(body, /native sum selection has no matching alternative/)
})

test('a checked native reference absence uses an admitted undefined home independently of null', () => {
  const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
  const source = sum(point, boolean)
  const target = sum({ kind: 'undefined' }, boolean)
  const recipe = nativeSelectionRecipeOf(source, target)
  assert.ok(recipe?.step.kind === 'dispatch')
  const selected = recipe.step.arms[0]
  assert.ok(selected?.kind === 'reference-null')
  assert.equal(selected.absent, null, 'null has no admitted destination')
  assert.ok(selected.undefined?.kind === 'transfer')
  const body = nativeSelectionBody(recipe, source, target)
  assert.ok(body)
  assert.match(body, /isUndefined\(\)\) \{ return GeaSelectionTarget::ofArm<0>\(std::move\(gea::Undefined\{\}\)/)
  assert.match(body, /native sum selection has no matching alternative/)
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

test('native reference sum transport keeps undefined distinct from null in every admitted envelope', () => {
  const optional: Representation = { kind: 'optional', payload: sum(point, number), absence: 'undefined' }
  const explicit = nativeSumPlan(point, optional)
  assert.ok(explicit?.kind === 'nullable-reference')
  assert.equal(explicit.undefined.value, 'undefined')
  assert.equal(explicit.undefined.plan.kind, 'empty')
  const explicitText = widenedNativeSumText(point, optional, 'selfOnce()')
  assert.ok(explicitText)
  assert.match(explicitText, /isUndefined\(\) \? GeaSumTarget\{\}/)
  assert.equal(explicitText.split('selfOnce()').length - 1, 1)

  const nullOptional: Representation = { kind: 'optional', payload: point, absence: 'null' }
  const retained = nativeSumPlan(point, nullOptional)
  assert.ok(retained?.kind === 'nullable-reference')
  assert.equal(retained.undefined.value, 'source')
  assert.equal(retained.undefined.plan, retained.present, 'the existing reference home retains Ref::undefined as a present payload')
  const retainedText = widenedNativeSumText(point, nullOptional, 'selfOnce()')
  assert.ok(retainedText)
  assert.match(retainedText, /isUndefined\(\) \? GeaSumTarget\{std::move\(__gea_sum_value\)\}/)

  const target = sum(point, { kind: 'null' })
  const tagged = nativeSumPlan(point, target)
  assert.ok(tagged?.kind === 'nullable-reference')
  assert.equal(tagged.undefined.value, 'source')
  assert.ok(tagged.absent.kind === 'wrap')
  assert.equal(tagged.absent.index, 1)
  const taggedText = widenedNativeSumText(point, target, 'selfOnce()')
  assert.ok(taggedText)
  assert.match(taggedText, /isUndefined\(\) \? GeaSumTarget::ofArm<0>\(std::move\(__gea_sum_value\)\)/)
  assert.match(taggedText, /GeaSumTarget::ofArm<1>\(std::move\(nullptr\)\)/)
  assert.equal(nativeSumPlan({ kind: 'undefined' }, target), null, 'preserving a native sentinel does not admit a new undefined atom home')
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
