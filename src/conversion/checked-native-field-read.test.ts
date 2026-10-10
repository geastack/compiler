import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from './nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { CHECKED_NATIVE_FIELD_READ, checkedPrimitiveFieldReadOf } from './checked-native-field-read.js'
import { recipeClosureOf } from './recipe-closure.js'
import type { Representation } from '../representation/model.js'
import { defaultRecordLayoutPolicy } from '../representation/policies.js'
import { recipeText, type ConversionSite } from '../targets/cpp/emit-narrowing.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const text: Representation = { kind: 'string' }
const number: Representation = { kind: 'scalar', domain: 'number' }
const census = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })

test('a selected exact field reader licenses only its native primitive mismatch, with the checked child retained', () => {
  const conversions = census()
  const checked = conversions.nodeFor(dynamic, text)
  assert.equal(checkedPrimitiveFieldReadOf(checked), true)
  assert.equal(conversions.nodeFor(number, text).capability.kind, 'never')
  const selected = conversions.checkedFieldReadFor(number, text, checked)
  assert.ok(selected)
  assert.equal(selected.capability.kind, 'static')
  assert.equal(conversions.nodeFor(number, text).capability.kind, 'never')
  assert.equal(conversions.checkedFieldReadFor(number, text, { ...checked }), null)
  assert.equal(conversions.checkedFieldReadFor(number, text, conversions.nodeFor(dynamic, number)), null)
  assert.equal(conversions.checkedFieldReadFor(text, text, checked), null)
  assert.equal(conversions.checkedFieldReadFor(dynamic, text, checked), null)
  assert.equal(conversions.checkedFieldReadFor({ kind: 'void' }, text, checked), null)
  assert.equal(conversions.checkedFieldReadFor(number, text, conversions.coercionFor(dynamic, 'ToString')), null)
  const closure = recipeClosureOf([selected], conversions.nodeById)
  assert.equal(closure.get(checked.id), checked)
  assert.equal(selected.capability.kind === 'static' && selected.capability.materializer.id, CHECKED_NATIVE_FIELD_READ)
})

test('selected mismatch observes its native operand once and uses the exact dynamic-reader failure without boxing', () => {
  const conversions = census()
  const checked = conversions.nodeFor(dynamic, text)
  const source: Representation = { kind: 'undefined' }
  const selected = conversions.checkedFieldReadFor(source, text, checked)
  assert.ok(selected)
  const closure = recipeClosureOf([selected], conversions.nodeById)
  const site = {
    conversions,
    printerDrift: [],
    owner: 'checked-native-field-read-test',
    layouts: defaultRecordLayoutPolicy,
    classes: new Map(),
    captures: {},
    conversionIsCertified: (id: string) => closure.has(id)
  } as unknown as ConversionSite
  const emitted = recipeText(site, selected, 'originalGetter()')
  assert.ok(emitted)
  assert.equal(emitted.match(/originalGetter\(\)/g)?.length, 1)
  assert.ok(emitted.includes('gea::detail::refusePayloadMismatch('))
  assert.ok(emitted.includes('an assertion out of a dynamic value to std::string'))
  assert.ok(!emitted.includes('Value::box'))
  assert.ok(!emitted.includes('unreachableValue'))
})
