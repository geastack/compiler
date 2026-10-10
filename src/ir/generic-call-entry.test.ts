import assert from 'node:assert/strict'
import test from 'node:test'
import { compile } from '../compiler.js'
import { declarationId, functionId, type FunctionId } from '../identity/ids.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { CallOperation, IrBody } from './model.js'
import { nativeGenericCallEntriesOf, nativeGenericSelectorMatches } from './generic-call-entry.js'

const first = declarationId('generic-entry', 0)
const second = declarationId('generic-entry', 1)
const sourceIds = new Set([functionId(first), functionId(second)])
const firstCopy = `${functionId(first)}@0` as FunctionId
const secondCopy = `${functionId(second)}@0` as FunctionId
const number: Representation = { kind: 'scalar', domain: 'number' }
const optional: Representation = { kind: 'optional', payload: number, absence: 'undefined' }
const selector: Representation = { kind: 'generic-function-set', members: [first, second] }
const frame = (parameters: readonly Representation[]): CallableAbi => ({
  receiver: null,
  parameters: parameters.map((value) => ({ value, ownership: 'owned', passing: 'by-value' })),
  result: number,
  restFrom: null
})
const body = (id: FunctionId, abi: CallableAbi): IrBody => ({
  sourceOwner: id,
  owner: `body|${id}` as never,
  abi,
  construct: null,
  entry: 'entry' as never,
  blocks: new Map(),
  blockOrder: [],
  values: new Map(),
  tryRegions: []
})
const bodies = new Map([
  [firstCopy, body(firstCopy, frame([number]))],
  [secondCopy, body(secondCopy, frame([number, optional]))]
])
const call: CallOperation = {
  kind: 'call',
  lineage: 'generic-call-entry-test' as never,
  callee: { value: 'selector' as never, representation: selector },
  receiver: null,
  arguments: ['left', 'right'].map((value) => ({ value: value as never, representation: number })),
  result: { id: 'called' as never, representation: number },
  family: [
    { member: first, functionId: firstCopy },
    { member: second, functionId: secondCopy }
  ]
}
const conversions = () => {
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  census.nodeFor(number, optional)
  return census
}
const callFor = (census: ReturnType<typeof conversions>): CallOperation => ({
  ...call,
  conversionRecipes: [{ role: 'call-argument', source: number, target: optional, conversion: census.nodeFor(number, optional).id }]
})

test('a complete generic selector retains each selected physical prefix and its native argument conversions', () => {
  const census = conversions()
  const complete = callFor(census)
  const entries = nativeGenericCallEntriesOf(complete, sourceIds, (id) => bodies.get(id), census)
  assert.deepEqual(
    entries?.map((entry) => [entry.functionId, entry.arguments.length]),
    [
      [firstCopy, 1],
      [secondCopy, 2]
    ]
  )
  assert.equal(
    nativeGenericCallEntriesOf(complete, sourceIds, (id) => bodies.get(id)),
    null,
    'the optional edge needs its canonical recipe'
  )
  assert.equal(
    nativeGenericCallEntriesOf(call, sourceIds, (id) => bodies.get(id), census),
    null,
    'the actual call must cite that recipe'
  )
})

test('incomplete families, unrelated sources, specialized substitutions and wrong physical frames stay open', () => {
  const census = conversions()
  const complete = callFor(census)
  const entries = (one: CallOperation, origins = sourceIds, lookup = (id: FunctionId) => bodies.get(id)) =>
    nativeGenericCallEntriesOf(one, origins, lookup, census)
  assert.equal(entries({ ...complete, family: call.family!.slice(0, 1) }), null)
  assert.equal(entries({ ...complete, family: [call.family![0]!, call.family![0]!] }), null)
  assert.equal(entries(complete, new Set([functionId(declarationId('unrelated', 0))])), null)
  assert.equal(entries(complete, new Set([`${functionId(first)}@1` as FunctionId])), null)
  assert.equal(entries({ ...complete, argumentsAreSpread: true }), null)
  assert.equal(entries({ ...complete, receiver: { value: 'receiver' as never, representation: number } }), null)
  assert.equal(
    entries(complete, sourceIds, (id) => (id === secondCopy ? body(id, frame([{ kind: 'string' }])) : bodies.get(id))),
    null
  )
  assert.equal(
    entries(complete, sourceIds, (id) => (id === firstCopy ? body(secondCopy, frame([number])) : bodies.get(id))),
    null
  )
  assert.equal(
    entries(complete, sourceIds, () => undefined),
    null
  )
})

test('native selector transport authenticates the actual canonical source and destination index spaces', () => {
  const census = conversions()
  const singleton: Representation = { kind: 'generic-function-set', members: [first] }
  const node = census.nodeFor(singleton, selector)
  assert.equal(nativeGenericSelectorMatches(singleton, selector, node), true)
  assert.equal(nativeGenericSelectorMatches(selector, singleton, node), false)
  assert.equal(nativeGenericSelectorMatches(singleton, selector, { ...node, target: singleton }), false)
  assert.equal(nativeGenericSelectorMatches(singleton, selector, undefined), false)
  assert.equal(nativeGenericSelectorMatches({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, selector, node), false)
})

test('the real generic binding corpus remains native through selected calls and generated record support', () => {
  const result = compile({ rootFileNames: ['test/fixtures/generic-function-in-binding.ts'], closedScriptScope: true, includeIr: true })
  assert.equal(result.diagnostics.clean, true)
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.equal(
    [...result.reflection!.records.values()].some((demand) => demand.level === 'full'),
    false
  )
  assert.equal(result.slotDrift.length, 0)
})
