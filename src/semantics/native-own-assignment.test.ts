import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { callableWriteTargetsOf } from './callable-origins.js'

const entry = resolve('test/runtime/object-assign-literal-target-merges-optional-options.runtime.ts')
const compileSource = (source?: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    ...(source === undefined ? {} : { sourceOverlay: new Map([[entry, source]]) })
  })

test('native bulk writers retain the actual source slot and source argument order', () => {
  const result = compileSource()
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const operation = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'invocation' && operation.intrinsicMutation === 'object-assign'
  )
  assert.ok(operation?.family === 'invocation')
  assert.ok(operation.nativeOwnAssignment)
  assert.deepEqual(
    operation.nativeOwnAssignment.sources.map((source) => source.ordinal),
    [1, 2]
  )
  assert.equal(operation.nativeOwnAssignment.targets.length, 1)
  for (const resultId of [
    ...operation.nativeOwnAssignment.targets,
    ...operation.nativeOwnAssignment.sources.flatMap((source) => source.roots.map((root) => root.allocation))
  ]) {
    const origin = result.graph.operations.get(result.graph.results.get(resultId)!)
    assert.equal(origin?.family, 'allocation', 'storage names the allocation, rather than its final initialization result')
    assert.equal(origin?.family === 'allocation' && origin.allocated, 'object-literal')
  }
  const targetOperand = operation.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 0)
  assert.notEqual(
    targetOperand?.source.kind === 'result' ? targetOperand.source.result : null,
    operation.nativeOwnAssignment.targets[0],
    'the executable target operand still waits for initialization'
  )
  const depth = callableWriteTargetsOf(result.graph).filter((writer) => writer.operation === operation && writer.key === 'depth')
  assert.equal(depth.length, 1)
  assert.equal(depth[0]!.value, null, 'copying a source slot does not evaluate its initializer again')
  assert.equal(depth[0]!.copiedSlot?.ordinal, 2)
  assert.equal(
    depth[0]!.copiedSlot?.values.some(
      (value) => value.source.kind === 'constant' && value.source.literal === 'number' && value.source.text === '1'
    ),
    true
  )
  assert.equal(depth[0]!.resultContract, 'receiver')
})

test('an opaque bulk source remains an unknown-key mutation rather than a partial typed inventory', () => {
  const result = compileSource(`
    export {};
    declare const source: Record<string, number>;
    const target = { label: 'before' };
    Object.assign(target, source);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const operation = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'invocation' && operation.intrinsicMutation === 'object-assign'
  )
  assert.ok(operation?.family === 'invocation')
  assert.equal(operation.nativeOwnAssignment === undefined, true)
  const writers = callableWriteTargetsOf(result.graph).filter((writer) => writer.operation === operation)
  assert.equal(writers.length, 1)
  assert.equal(writers[0]!.key, null)
  assert.equal(writers[0]!.copiedSlot, undefined)
})
