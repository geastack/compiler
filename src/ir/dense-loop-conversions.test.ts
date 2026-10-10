import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { declarationId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { representationKey, type Representation } from '../representation/model.js'
import { denseLoopConversionsOf, denseLoopPlanMatches, type DenseArray, type DenseLoopPlan, type DenseReference } from './dense-loops.js'
import type { IrBody, GetOperation } from './model.js'
import { createConversionNodes } from '../conversion/nodes.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { nativeArrayViewPlansOf } from '../conversion/array-view.js'
import { recipeClosureOf } from '../conversion/recipe-closure.js'

const array: Representation = {
  kind: 'array-object',
  element: { kind: 'scalar', domain: 'number' },
  ownership: 'shared-refcount',
  extension: null
}
const optional: Representation = { kind: 'optional', payload: array, absence: 'undefined' }
const cell = declarationId('dense-array-cell', 0)
const conversion: ConversionNode = {
  id: `${representationKey(optional)}->${representationKey(array)}`,
  source: optional,
  target: array,
  capability: {
    kind: 'static',
    materializer: { id: 'test:checked-presence', domain: 'test:checked-presence', allocates: false }
  }
}
const census = { nodeById: (id: string) => (id === conversion.id ? conversion : null) } as ConversionCensus
const placements = new Map([[cell, { representation: optional } as BindingPlacement]])
const body = { blocks: new Map(), values: new Map() } as unknown as IrBody
const planFor = (...references: DenseReference[]): DenseLoopPlan => ({
  arrays: references.map((reference) => ({ reference }) as DenseArray),
  groups: [],
  accesses: new Map(),
  lengths: new Map()
})

test('dense preheader publication preserves the census node instead of asking the printer to select a conversion', () => {
  const plan = planFor({ kind: 'cell', declaration: cell, representation: array, conversion })
  assert.equal(denseLoopPlanMatches(body, plan, placements, census), true)
  assert.deepEqual(denseLoopConversionsOf(plan), [conversion])
})

test('dense preheader certification rejects an unproved or retargeted cell read', () => {
  assert.equal(denseLoopPlanMatches(body, planFor({ kind: 'cell', declaration: cell, representation: array }), placements, census), false)
  assert.equal(
    denseLoopPlanMatches(
      body,
      planFor({ kind: 'cell', declaration: cell, representation: { kind: 'string' }, conversion }),
      placements,
      census
    ),
    false
  )
})

test('dense preheader certification rejects a forged node with the same id', () => {
  assert.equal(
    denseLoopPlanMatches(
      body,
      planFor({ kind: 'cell', declaration: cell, representation: array, conversion: { ...conversion } }),
      placements,
      census
    ),
    false
  )
})

test('nested dense rows demand their holder conversion once', () => {
  const holder: DenseReference = { kind: 'cell', declaration: cell, representation: array, conversion }
  const row = { kind: 'element', holder } as DenseReference
  const plan = planFor(holder, row)
  assert.equal(denseLoopPlanMatches(body, plan, placements, census), true)
  assert.equal(denseLoopConversionsOf(plan).length, 1)
})

test('dense certification rejects access identities replaced after the plan was published', () => {
  const access = { kind: 'get' } as GetOperation
  const liveBody = { ...body, blocks: new Map([['entry', { operations: [access] }]]) } as unknown as IrBody
  const plan: DenseLoopPlan = { ...planFor(), accesses: new Map([[access, { array: 0, flag: 0, signed: false }]]) }
  assert.equal(denseLoopPlanMatches(liveBody, plan, placements, census), true)
  const changedBody = { ...body, blocks: new Map([['entry', { operations: [{ ...access }] }]]) } as unknown as IrBody
  assert.equal(denseLoopPlanMatches(changedBody, plan, placements, census), false)
})

test('dense preheaders cannot obtain raw storage through a selected live array view or its nested holder', () => {
  const source: Representation = { ...array, element: { kind: 'dynamic', reason: 'declared-any-never-narrowed' } }
  const selected = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = selected.nodeFor(source, array)
  assert.notEqual(node.capability.kind, 'never')
  assert.ok(nativeArrayViewPlansOf(recipeClosureOf([node], selected.nodeById).values()).length > 0)
  const holder: DenseReference = { kind: 'cell', declaration: cell, representation: array, conversion: node }
  const storage = new Map([[cell, { representation: source } as BindingPlacement]])
  assert.equal(denseLoopPlanMatches(body, planFor(holder), storage, selected), false)
  assert.equal(denseLoopPlanMatches(body, planFor({ kind: 'element', holder } as DenseReference), storage, selected), false)
  const value = 'live-array-view' as import('../identity/ids.js').IrValueId
  const local = { ...body, values: new Map([[value, source]]) }
  assert.equal(
    denseLoopPlanMatches(
      local,
      planFor({ kind: 'value', operand: { value, representation: array }, storage: source, conversion: node }),
      storage,
      selected
    ),
    false
  )
})
