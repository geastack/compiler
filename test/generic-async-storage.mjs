import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { compile } from '../dist/compiler.js'
import { nativeCallableFlowOf } from '../dist/ir/callable-class-flow.js'
import { classAllocationDomainOf } from '../dist/ir/class-allocation-domain.js'

const fixture = resolve('test/runtime/generic-async-iterator-yields-narrowed-composite-filling.runtime.ts')
const specificProject = fixture.replace(/\.(?:tsx?|(?:runtime\.)?js)$/, '.tsconfig.json')
const project = existsSync(specificProject) ? specificProject : resolve('test/runtime/tsconfig.json')
const assertEmitted = (result) => {
  assert.equal(result.diagnostics.diagnostics.filter(({ id }) => id.startsWith('checker/')).length, 0)
  assert.ok(result.source !== null, result.refusals.map(({ key, reason }) => `${key}: ${reason}`).join('\n'))
  assert.ok(result.certificate !== null)
  assert.equal(result.slotDrift.length, 0)
  assert.equal(result.emissionRefusals.length, 0)
}

test('a composite generic async cursor keeps its closed array field storage', () => {
  assertEmitted(compile({ rootFileNames: [fixture], projectFileName: project, closedScriptScope: true }))
})

test('actual writes through a closed generic array-field alias remain native', () => {
  const result = compile({
    rootFileNames: [fixture],
    projectFileName: project,
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([
      [
        fixture,
        `class Cell<T> { items: T[] = []; }
           const original = new Cell<string>();
           const unrelated = new Cell<boolean>();
           const view: { items: string[] | number[] } = original;
           view.items = [42];
           console.log(original.items.join(','), unrelated.items.length);`
      ]
    ])
  })
  assertEmitted(result)
  const constructions = result.irBodies.flatMap((body) =>
    [...body.blocks.values()].flatMap((block) => block.operations.filter((operation) => operation.kind === 'construct'))
  )
  assert.equal(constructions.length, 2)
  for (const operation of constructions) {
    assert.equal(operation.target.kind, 'exact')
    assert.equal(operation.target.target.kind, 'implicit-source-constructor')
    assert.equal(operation.target.target.classDeclaration, operation.result.representation.declaration)
  }
  const allocations = classAllocationDomainOf(
    result.irBodies,
    result.projection.classes,
    result.projection.placements,
    result.representations.deriver,
    nativeCallableFlowOf(
      result.irBodies,
      result.projection.placements,
      result.projection.classes,
      result.conversionCensus,
      undefined,
      result.representations.deriver
    )
  )
  for (const operation of constructions) assert.ok(allocations.has(operation.result.representation.declaration))
})
