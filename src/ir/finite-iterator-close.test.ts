import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { finiteIteratorCloseRegionMatches } from './finite-iterator-close.js'
import { allOperationsOf } from './model.js'
import { resultOfIrOperation } from './queries.js'
import { operationOfResult } from '../identity/ids.js'
test('finite close completion is required by source authority and exact cursor lineage', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/dynamic-finite-destructuring-close.ts')],
    projectFileName: null,
    includeIr: true
  })
  assert.ok(result.certificate && result.source, JSON.stringify(result.refusals))
  const bodies = result.irBodies!
  const regions = bodies.flatMap((body) => body.iteratorCloseRegions ?? []).filter((region) => region.completeOnStepAbrupt)
  assert.ok(regions.length > 0)
  const definitions = new Map(
    bodies
      .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
      .flatMap((op) => {
        const result = resultOfIrOperation(op)
        return result ? [[result.id, op] as const] : []
      })
  )
  for (const region of regions) {
    const semantic = result.graph.operations.get(region.loop)!
    const definitionOf = (id: Parameters<typeof definitions.get>[0]) => definitions.get(id) ?? null
    const operationOf = (id: Parameters<typeof operationOfResult>[0]) => result.graph.operations.get(operationOfResult(id)) ?? null
    assert.equal(finiteIteratorCloseRegionMatches(region, semantic, definitionOf, operationOf), true)
    const { completeOnStepAbrupt: _, ...missing } = region
    assert.equal(finiteIteratorCloseRegionMatches(missing, semantic, definitionOf, operationOf), false)
    assert.equal(finiteIteratorCloseRegionMatches(region, null, definitionOf, operationOf), false)
    assert.equal(
      finiteIteratorCloseRegionMatches(
        { ...region, iterator: { ...region.iterator, value: 'forged' as never } },
        semantic,
        definitionOf,
        operationOf
      ),
      false
    )
    assert.equal(finiteIteratorCloseRegionMatches({ ...region, onlyIfOpen: false }, semantic, definitionOf, operationOf), false)
  }
  assert.ok(result.source.includes('= true;\nthrow;'))
})
for (const name of [
  'finite-destructuring-abrupt-phase.runtime.ts',
  'array-pattern-over-generator.ts',
  'array-pattern-elision-over-generator.ts',
  'generator-finite-destructuring-close.ts',
  'generator-throws-before-first-yield.ts'
])
  test(`abrupt phase control certifies: ${name}`, () => {
    const result = compile({ rootFileNames: [resolve('test/runtime', name)], projectFileName: null, includeIr: true })
    assert.ok(result.certificate && result.source, JSON.stringify({ refusals: result.refusals, diagnostics: result.diagnostics }))
  })

test('typed custom-cursor destructuring retains its existing unsupported carrier boundary', () => {
  const result = compile({ rootFileNames: [resolve('test/runtime/finite-destructuring-typed-abrupt.runtime.ts')], projectFileName: null })
  assert.equal(result.source, null)
  assert.ok(
    result.refusals.some((refusal) => refusal.key === 'lower:blocked' && refusal.reason.includes('record layout has no field keyed "0"'))
  )
})
