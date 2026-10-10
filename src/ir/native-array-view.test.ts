import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { createConversionNodes } from '../conversion/nodes.js'
import type { Representation } from '../representation/model.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { createCppConversionRegistry } from '../targets/cpp/conversions.js'
import { createIrBodyBuilder } from './build.js'
import { nativeCallableFlowOf } from './callable-class-flow.js'
import { allOperationsOf } from './model.js'

const dynamic: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
const target: Representation = {
  kind: 'array-object',
  element: { kind: 'scalar', domain: 'number' },
  ownership: 'shared-refcount',
  extension: null
}

test('possible live array storage follows exact installed conversion and local alias edges even with an ordinary writer', () => {
  const census = createConversionNodes({ nodes: new Map(), registry: createCppConversionRegistry() })
  const node = census.nodeFor(dynamic, target)
  assert.ok('materializer' in node.capability && node.capability.materializer.nativeArrayView)
  const build = (mixed: boolean) => {
    const builder = createIrBodyBuilder('module' as never, 'module' as never, null)
    const block = builder.openBlock()
    const lineage = 'array-source' as never
    const unknown = builder.bindingRead(block, lineage, 'external-array' as never, dynamic)
    const installed = builder.convert(block, lineage, node.id, { value: unknown, representation: dynamic }, target)
    const binding = 'held-array' as never
    builder.bindingWrite(block, lineage, binding, { value: installed, representation: target })
    if (mixed) {
      const ordinary = builder.bindingRead(block, lineage, 'ordinary-array' as never, target)
      builder.bindingWrite(block, lineage, binding, { value: ordinary, representation: target })
    }
    const alias = builder.bindingRead(block, lineage, binding, target)
    builder.return(block, null, null)
    const placements = new Map([[binding, { storage: { kind: 'local' }, representation: target } as BindingPlacement]])
    return { body: builder.seal(), alias, installed, placements }
  }
  for (const mixed of [false, true]) {
    const value = build(mixed)
    const flow = nativeCallableFlowOf([value.body], value.placements, new Map(), census)
    assert.equal(flow.nativeArrayViewValues?.has(value.installed), true)
    assert.equal(flow.nativeArrayViewValues?.has(value.alias), true)
    const unselected = { ...census, nodeById: (id: string) => (id === node.id ? null : census.nodeById(id)) }
    assert.equal(nativeCallableFlowOf([value.body], value.placements, new Map(), unselected).nativeArrayViewValues?.has(value.alias), false)
  }
})

test('a live array descriptor captures original storage without sampling target cells, while ordinary capture stays admitted', () => {
  const entry = resolve('test/runtime/json-parse-any-array-into-declared-record-element.runtime.ts')
  const run = (argument: string) =>
    compile({
      rootFileNames: [entry],
      projectFileName: resolve('test/runtime/tsconfig.json'),
      closedScriptScope: true,
      includeIr: true,
      sourceOverlay: new Map([
        [
          entry,
          `function describe(values: number[]): boolean | undefined {
             return Object.getOwnPropertyDescriptor(values, '0')?.enumerable
           }
           console.log(describe(${argument}))`
        ]
      ])
    })
  const live = run(`JSON.parse('[1]')`)
  assert.equal(live.diagnostics.clean, true, JSON.stringify(live.diagnostics.diagnostics))
  assert.notEqual(live.source, null, JSON.stringify(live.refusals))
  const ordinary = run('[1]')
  assert.equal(ordinary.diagnostics.clean, true, JSON.stringify(ordinary.diagnostics.diagnostics))
  assert.notEqual(ordinary.source, null, JSON.stringify(ordinary.refusals))
  for (const [result, originalAny] of [
    [live, true],
    [ordinary, false]
  ] as const) {
    const capture = (result.irBodies ?? [])
      .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
      .find((operation) => operation.kind === 'call' && operation.nativeArrayDescriptorSnapshot !== undefined)
    assert.ok(capture?.kind === 'call' && capture.nativeArrayDescriptorSnapshot)
    const node = result.conversionCensus.nodeById(capture.nativeArrayDescriptorSnapshot.conversion)
    assert.ok(node && 'materializer' in node.capability && node.capability.materializer.nativeDescriptorSnapshot)
    assert.equal(node.capability.materializer.nativeDescriptorSnapshot.originalAny, originalAny)
    assert.equal(result.certificate?.conversionNodeIds.includes(node.id), true)
    assert.equal(capture.nativeArrayDescriptorSnapshot.originalSources.length > 0, originalAny)
    assert.ok(result.source!.includes('captureNativeArrayDescriptor('))
    assert.ok(result.source!.includes('makeDescriptorSnapshotViewWithOrigin<'))
  }
})
