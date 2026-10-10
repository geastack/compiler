import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { allOperationsOf } from './model.js'
import { publishNativeArrayDescriptorSnapshots, type NativeArrayDescriptorSnapshotInput } from './native-array-descriptor-snapshot.js'

const entry = resolve('test/runtime/native-array-descriptor-snapshot.runtime.ts')
const run = (source: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true,
    includeIr: true,
    sourceOverlay: new Map([[entry, source]])
  })

test('a live numeric descriptor owns an immutable capture and projects its checked value only when read', () => {
  const result = run(`
    const original: any = JSON.parse('[2]');
    const values: number[] = original;
    const descriptor = Object.getOwnPropertyDescriptor(values, '0');
    original[0] = 9;
    console.log(descriptor?.enumerable, descriptor?.value, values[0]);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)]))
  const capture = operations.find((operation) => operation.kind === 'call' && operation.nativeArrayDescriptorSnapshot)
  assert.ok(capture?.kind === 'call' && capture.nativeArrayDescriptorSnapshot)
  const captureNode = result.conversionCensus.nodeById(capture.nativeArrayDescriptorSnapshot.conversion)
  assert.ok(captureNode && 'materializer' in captureNode.capability && captureNode.capability.materializer.nativeDescriptorSnapshot)
  for (const field of captureNode.capability.materializer.nativeDescriptorSnapshot.fields)
    if (field.field.key === 'get' || field.field.key === 'set') {
      assert.equal(field.retainedAccessor, true)
      assert.equal(field.reads.length, 0)
    }
  assert.ok(result.source!.includes('captureNativeArrayDescriptor('))
  assert.equal(result.source!.split('captureNativeArrayDescriptor(').length, 2)
  assert.ok(result.source!.includes('if (!gea_snapshot_capture.has_value()) return gea::Optional<'))
  assert.ok(result.source!.includes('(std::move(*gea_snapshot_capture))'))
  assert.ok(result.source!.includes('makeDescriptorSnapshotViewWithOrigin<'))
  assert.ok(operations.some((operation) => operation.kind === 'get' && operation.nativeFieldViewRead?.key === 'value'))
})

test('reinstallation consumes the copied descriptor after source mutation without a later owner/key relookup', () => {
  const result = run(`
    const original: any = JSON.parse('[3]');
    const values: number[] = original;
    const descriptor = Object.getOwnPropertyDescriptor(values, '0');
    original[0] = 7;
    if (descriptor) Object.defineProperty(values, '0', descriptor);
    console.log(values[0]);
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  assert.ok(result.source!.includes('nativeDescriptorSnapshotDefinitionFromView('))
  assert.ok(result.source!.includes('gea::nativeDynamicDefineProperty(__gea_target,'))
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)]))
  assert.ok(operations.some((operation) => operation.kind === 'call' && operation.nativeArrayDescriptorReinstallation))
})

test('unselected snapshot publication preserves operation identities and removes stale receipts without a source call authority', () => {
  const result = run('console.log(1);')
  assert.notEqual(result.source, null, JSON.stringify(result.refusals))
  const bodies = new Map((result.irBodies ?? []).map((body) => [body.owner, body]))
  const input: NativeArrayDescriptorSnapshotInput = {
    bodies,
    placements: result.projection.placements,
    classes: result.projection.classes,
    conversions: result.conversionCensus,
    deriver: result.representations.deriver,
    calleeRendering: undefined
  }
  assert.equal(publishNativeArrayDescriptorSnapshots(input), bodies)
  const contaminated = new Map(
    [...bodies].map(([id, body]) => [
      id,
      {
        ...body,
        blocks: new Map(
          [...body.blocks].map(([blockId, block]) => [
            blockId,
            {
              ...block,
              operations: block.operations.map((operation) => {
                const operand = operation.kind === 'call' ? operation.arguments[0] : undefined
                if (operation.kind !== 'call' || !operand) return operation
                return {
                  ...operation,
                  nativeArrayDescriptorSnapshot: {
                    receiver: operand,
                    key: operand,
                    keyText: '0',
                    originalSources: [],
                    conversion: result.conversionCensus.nodeFor(operand.representation, operand.representation).id
                  },
                  nativeArrayDescriptorReinstallation: { receiver: operand, key: operand, descriptor: operand, captures: [operand.value] }
                }
              })
            }
          ])
        )
      }
    ])
  )
  const cleared = publishNativeArrayDescriptorSnapshots({ ...input, bodies: contaminated })
  const calls = [...cleared.values()].flatMap((body) => [...body.blocks.values()].flatMap((block) => [...allOperationsOf(block)]))
  assert.ok(calls.some((operation) => operation.kind === 'call'))
  assert.ok(
    calls.every(
      (operation) =>
        operation.kind !== 'call' || (!operation.nativeArrayDescriptorSnapshot && !operation.nativeArrayDescriptorReinstallation)
    )
  )
})

test('snapshot writes, opaque escapes, foreign reinstallation owners and inherited value hooks stay refused', () => {
  const cases = [
    `if (descriptor) descriptor.value = 4;`,
    `console.log(descriptor?.get);`,
    `console.log(descriptor?.set);`,
    `declare function observe(value: unknown): void; observe(descriptor);`,
    `const other: number[] = [8]; if (descriptor) Object.defineProperty(other, '0', descriptor);`,
    `Object.defineProperty(Object.prototype, 'value', {get() { return 12; }, configurable: true}); console.log(descriptor?.value);`
  ]
  for (const suffix of cases) {
    const result = run(
      `const values: number[] = JSON.parse('[1]'); const descriptor = Object.getOwnPropertyDescriptor(values, '0'); ${suffix}`
    )
    assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
    assert.equal(result.source, null, suffix)
    assert.ok(
      result.refusals.some((refusal) => refusal.key === 'runtime-helper:native-array-descriptor-snapshot'),
      JSON.stringify(result.refusals)
    )
  }
})
