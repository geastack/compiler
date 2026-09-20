import assert from 'node:assert/strict'
import test from 'node:test'
import type { Representation } from '../../representation/model.js'
import { createConversionNodes } from '../../conversion/nodes.js'
import { createCppConversionRegistry } from './conversions.js'
import { nativeSelectionHelpersForUses } from './native-selection-helpers.js'

const sum = (values: readonly Representation[]): Representation => ({
  kind: 'tagged-union',
  arms: values.map((value, index) => ({
    tag: String(index),
    value,
    semanticType: `type-${index}` as never,
    runtimeDiscriminator: { kind: 'carrier' }
  }))
})

test('repeated large certified selections share one typed body without changing admission', () => {
  const alternatives: Representation[] = Array.from({ length: 30 }, (_, index) => ({
    kind: 'class-ref',
    declaration: `class-${index}` as never,
    shapeId: `shape-${index}`,
    ownership: 'shared-refcount',
    ancestors: []
  }))
  const source = sum([{ kind: 'undefined' }, ...alternatives])
  const target = sum(alternatives)
  const census = createConversionNodes({ registry: createCppConversionRegistry(), nodes: new Map() })
  const node = census.nodeFor(source, target)
  const helpers = nativeSelectionHelpersForUses([node, node, node])
  assert.equal(helpers.size, 1)
  const helper = helpers.get(node.id)
  assert.ok(helper)
  assert.ok(helper.definition.length > 1024)
  assert.ok(helper.declaration.includes('& gea_selection'))
  assert.ok(helper.definition.includes('refusePayloadMismatch'))
  assert.equal(nativeSelectionHelpersForUses([node]).size, 0)
  const invalid = census.nodeFor({ kind: 'dynamic', reason: 'declared-any-never-narrowed' }, target)
  assert.equal(nativeSelectionHelpersForUses([invalid, invalid]).size, 0)
})
