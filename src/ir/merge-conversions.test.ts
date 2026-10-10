import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversionNodes } from '../conversion/nodes.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { emitMergeLiveArmRebuild } from '../targets/cpp/emit-narrowing.js'
import { capabilityKeysOf, type CertifyContext } from './certify.js'
import { mergeConversionPlanMatches, mergeConversionPlanOf } from './merge-conversions.js'
import type { IrOperation, MergeLiveArmRebuildOperation } from './model.js'

const string: Representation = { kind: 'string' }
const boolean: Representation = { kind: 'scalar', domain: 'boolean' }
const array: Representation = { kind: 'array-object', element: string, extension: null, ownership: 'shared-refcount' }
const sum: Representation = {
  kind: 'tagged-union',
  arms: [string, array].map((value, index) => ({
    tag: String(index),
    value,
    semanticType: String(index) as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
}
const optional = (payload: Representation): Representation => ({ kind: 'optional', payload, absence: 'undefined' })
const operationOf = (source: Representation = sum, target: Representation = boolean): MergeLiveArmRebuildOperation => ({
  kind: 'merge-live-arm-rebuild',
  lineage: 'merge-lineage' as never,
  source: { value: 'source' as never, representation: source },
  result: { id: 'result' as never, representation: target },
  liveArms: [0],
  sourceAbsenceLive: source.kind === 'optional'
})
const semanticOf = (operator = '&&', lineage = 'merge-lineage'): SemanticOperation =>
  ({
    family: 'computation',
    form: 'logical',
    operator,
    caller: { kind: 'region', regionId: 'module' },
    operands: [{ role: 'left', ordinal: 0, source: { kind: 'result', result: 'left-lineage' } }],
    results: [{ id: lineage }]
  }) as unknown as SemanticOperation
const definitionsOf = (operation: MergeLiveArmRebuildOperation) => {
  const source: IrOperation = {
    kind: 'binding-read',
    lineage: 'left-lineage' as never,
    declaration: 'left-binding' as never,
    result: { id: operation.source.value, representation: operation.source.representation }
  }
  return (value: typeof operation.source.value): IrOperation | null => (value === source.result.id ? source : null)
}
const censusOf = () => createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
const planned = (operation: MergeLiveArmRebuildOperation, conversions = censusOf(), semantic = semanticOf()) => {
  const mergeConversionPlan = mergeConversionPlanOf(operation, semantic, conversions, definitionsOf(operation))
  assert.ok(mergeConversionPlan)
  return { ...operation, mergeConversionPlan }
}

test('the kept falsy string becomes boolean through an explicit && truthiness recipe', () => {
  const conversions = censusOf()
  const operation = planned(operationOf(), conversions)
  assert.equal(conversions.nodeFor(string, boolean).capability.kind, 'never')
  assert.equal(operation.mergeConversionPlan.arms[0]?.mode, 'truthiness')
  const node = conversions.nodeById(operation.mergeConversionPlan.arms[0]!.conversion)
  assert.equal(representationKey(node!.source), representationKey(boolean))
  assert.equal(node!.capability.kind, 'identity')
  assert.equal(mergeConversionPlanMatches(operation, semanticOf(), conversions, definitionsOf(operation)), true)
})

test('optional absence is cited independently from the present truthiness and its wrapper', () => {
  const conversions = censusOf()
  const operation = planned(operationOf(optional(sum), optional(boolean)), conversions)
  const arm = conversions.nodeById(operation.mergeConversionPlan.arms[0]!.conversion)
  const absence = conversions.nodeById(operation.mergeConversionPlan.absence!)
  assert.equal(arm!.source.kind, 'scalar')
  assert.equal(absence!.source.kind, 'undefined')
  assert.equal(representationKey(arm!.target), representationKey(optional(boolean)))
  assert.equal(representationKey(absence!.target), representationKey(optional(boolean)))
  assert.equal(mergeConversionPlanMatches(operation, semanticOf(), conversions, definitionsOf(operation)), true)
})

test('??, an unrelated && lineage and a forged live split cannot borrow the truthiness recipe', () => {
  const conversions = censusOf()
  const operation = operationOf()
  const definitionOf = definitionsOf(operation)
  assert.equal(mergeConversionPlanOf(operation, semanticOf('??'), conversions, definitionOf), undefined)
  assert.equal(mergeConversionPlanOf(operation, semanticOf('&&', 'another-merge'), conversions, definitionOf), undefined)
  assert.equal(mergeConversionPlanOf({ ...operation, liveArms: [0, 1] }, semanticOf(), conversions, definitionOf), undefined)
  assert.equal(mergeConversionPlanOf({ ...operation, sourceAbsenceLive: true }, semanticOf(), conversions, definitionOf), undefined)
  const published = planned(operation, conversions)
  assert.equal(mergeConversionPlanMatches(published, semanticOf('??'), conversions, definitionOf), false)
})

test('ordinary live values keep their canonical conversion without requiring a logical operator', () => {
  const conversions = censusOf()
  const operation = planned(operationOf(sum, optional(string)), conversions)
  assert.equal(operation.mergeConversionPlan.arms[0]?.mode, 'value')
  assert.equal(mergeConversionPlanMatches(operation, null, conversions), true)
  assert.equal(
    mergeConversionPlanOf(operationOf(sum, { kind: 'array-buffer', ownership: 'shared-refcount' }), null, conversions),
    undefined
  )
})

test('missing, forged and noncanonical merge citations fail authentication', () => {
  const conversions = censusOf()
  const operation = planned(operationOf(optional(sum), optional(boolean)), conversions)
  const definitionOf = definitionsOf(operation)
  assert.equal(mergeConversionPlanMatches(operationOf(optional(sum), optional(boolean)), semanticOf(), conversions, definitionOf), false)
  assert.equal(
    mergeConversionPlanMatches(
      { ...operation, mergeConversionPlan: { ...operation.mergeConversionPlan, arms: [] } },
      semanticOf(),
      conversions,
      definitionOf
    ),
    false
  )
  const wrong = conversions.nodeFor(string, string)
  assert.equal(
    mergeConversionPlanMatches(
      {
        ...operation,
        mergeConversionPlan: {
          ...operation.mergeConversionPlan,
          arms: [{ index: 0, mode: 'truthiness', conversion: wrong.id }]
        }
      },
      semanticOf(),
      conversions,
      definitionOf
    ),
    false
  )
  assert.equal(
    mergeConversionPlanMatches(
      operation,
      semanticOf(),
      {
        nodeFor: conversions.nodeFor,
        nodeById: (id) => {
          const node = conversions.nodeById(id)
          return node === null ? null : { ...node }
        }
      },
      definitionOf
    ),
    false
  )
})

test('certification demands ToBoolean and every recipe, and refuses a missing or wrong-operation plan', () => {
  const conversions = censusOf()
  const operation = planned(operationOf(optional(sum), optional(boolean)), conversions)
  const context = (semantic = semanticOf()): CertifyContext =>
    ({
      conversions,
      semanticOperationOf: () => semantic,
      definitionOf: definitionsOf(operation),
      deriver: {},
      classes: new Map(),
      body: { tryRegions: [] }
    }) as unknown as CertifyContext
  const keys = capabilityKeysOf(operation, context()).map((demand) => demand.key)
  assert.equal(keys.includes('runtime-helper:conversion:to-boolean:string'), true)
  assert.equal(keys.includes(`conversion:${operation.mergeConversionPlan.arms[0]!.conversion}`), true)
  assert.equal(keys.includes(`conversion:${operation.mergeConversionPlan.absence}`), true)
  for (const [candidate, semantic] of [
    [operationOf(), semanticOf()],
    [operation, semanticOf('??')]
  ] as const) {
    const refused = capabilityKeysOf(candidate, context(semantic)).find(
      (demand) => demand.key === 'runtime-helper:merge-live-arm-rebuild:conversion-plan'
    )
    assert.equal(refused?.verdict, 'missing')
  }
})

test("an unrelated same-shaped SSA value cannot borrow another left operand's && proof", () => {
  const conversions = censusOf()
  const operation = planned(operationOf(), conversions)
  const unrelated: IrOperation = {
    kind: 'binding-read',
    lineage: 'unrelated-lineage' as never,
    declaration: 'unrelated-binding' as never,
    result: { id: 'unrelated-value' as never, representation: sum }
  }
  const actual = { ...operation, source: { value: unrelated.result.id, representation: sum } }
  const known = definitionsOf(operation)
  const definitionOf = (value: typeof operation.source.value) => (value === unrelated.result.id ? unrelated : known(value))
  assert.equal(mergeConversionPlanOf(actual, semanticOf(), conversions, definitionOf), undefined)
  assert.equal(mergeConversionPlanMatches(actual, semanticOf(), conversions, definitionOf), false)
})

test('the IR renderer cannot fall through to a raw conversion without its published plan', () => {
  assert.throws(() => emitMergeLiveArmRebuild({} as never, [], operationOf()), /a merge has no matching certified arm plan/)
})
