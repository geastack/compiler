import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConversionNode } from '../conversion/algebra.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { declarationId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { representationKey, type Representation } from '../representation/model.js'
import { denseLoopConversionsOf, denseLoopPlanMatches, type DenseArray, type DenseLoopPlan, type DenseReference } from './dense-loops.js'
import type { IrBody } from './model.js'

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
const body = { blocks: new Map(), values: new Map() } as IrBody
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
