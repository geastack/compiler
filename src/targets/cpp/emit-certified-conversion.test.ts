import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../../conversion/nodes.js'
import { recipeClosureOf } from '../../conversion/recipe-closure.js'
import type { Representation } from '../../representation/model.js'
import { defaultRecordLayoutPolicy } from '../../representation/policies.js'
import { createCppConversionRegistry } from './conversions.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'

const number: Representation = { kind: 'scalar', domain: 'number' }
const conversions = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const exactRecipeRequired = (error: unknown): boolean => error instanceof Error && error.message.includes('exact certified recipe')
const site = (certified?: ReadonlySet<string>): ConversionSite =>
  ({
    conversions,
    printerDrift: [],
    owner: 'certified-recipe-test',
    layouts: defaultRecordLayoutPolicy,
    classes: new Map(),
    captures: {},
    ...(certified === undefined ? {} : { conversionIsCertified: (id: string) => certified.has(id) })
  }) as unknown as ConversionSite

test('the dispatcher requires the exact canonical citation even for an identity recipe', () => {
  const node = conversions.nodeFor(number, number)
  assert.equal(recipeText(site(new Set([node.id])), node, 'value'), 'value')
  assert.throws(() => recipeText(site(new Set([node.id])), { ...node }, 'value'), exactRecipeRequired)
  assert.throws(() => recipeText(site(new Set()), node, 'value'), exactRecipeRequired)
})

test('a certified promise root cannot render an unpublished payload conversion', () => {
  const source: Representation = { kind: 'promise', value: number }
  const target: Representation = { kind: 'promise', value: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  const node = conversions.nodeFor(source, target)
  const closure = recipeClosureOf([node], conversions.nodeById)
  assert.ok(closure.size > 1)
  assert.throws(() => recipeText(site(new Set([node.id])), node, 'promise'), exactRecipeRequired)
  assert.ok(recipeText(site(new Set(closure.keys())), node, 'promise'))
})

test('certificate-free registry probes remain supported', () => {
  assert.equal(recipeText(site(), conversions.nodeFor(number, number), 'probe'), 'probe')
})
