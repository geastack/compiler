import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { allOperationsOf } from './model.js'

const entry = resolve('test/fixtures/owned-record-union.ts')
const compiledSource = (source: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([[entry, source]]),
    closedScriptScope: true,
    includeIr: true
  })

test('the standard Math singleton remains native when carried through a source function and identity comparison', () => {
  const result = compiledSource(`export {};
    function retain(value: Math): Math { return value; }
    const same = retain(Math);
    console.log(same === Math, same.PI);`)
  const details = JSON.stringify({
    diagnostics: result.diagnostics.diagnostics,
    refusals: result.refusals,
    emission: result.emissionRefusals
  })
  assert.equal(result.diagnostics.clean, true, details)
  assert.ok(result.source, details)
  const operations = (result.irBodies ?? []).flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
  const reads = operations.filter(
    (operation) =>
      operation.kind === 'binding-read' &&
      operation.result.representation.kind === 'native-handle' &&
      operation.result.representation.protocol === 'Math'
  )
  assert.ok(reads.length)
  const singletons = reads.filter(
    (read) => read.kind === 'binding-read' && result.projection.placements.get(read.declaration)?.storage.kind === 'host-singleton'
  )
  assert.ok(singletons.length, 'the actual standard library binding supplies the native singleton identity')
  for (const read of singletons) {
    assert.ok(read.kind === 'binding-read')
    const storage = result.projection.placements.get(read.declaration)?.storage
    assert.ok(storage?.kind === 'host-singleton')
    assert.deepEqual(storage.nativeIdentity, { protocol: 'Math', version: 1, identity: 0 })
  }
  for (const read of reads.filter((one) => !singletons.includes(one))) {
    assert.ok(read.kind === 'binding-read')
    const storage = result.projection.placements.get(read.declaration)?.storage
    assert.ok(storage?.kind === 'local' || storage?.kind === 'region', 'an application alias remains an ordinary native binding')
  }
  assert.match(result.source, /gea::NativeHandle<gea_native_protocol_Math_v1>\(0\)/)
  assert.doesNotMatch(result.source, /gea::Value::box\([^\n]*NativeHandle<gea_native_protocol_Math_v1>/)
})

test('an exported ambient Math handle retains its external cell and acquires no standard singleton identity', () => {
  const result = compiledSource('export declare const Math: Math; console.log(Math.PI);')
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  const reads = (result.irBodies ?? [])
    .flatMap((body) => [...body.blocks.values()].flatMap(allOperationsOf))
    .filter(
      (operation) =>
        operation.kind === 'binding-read' &&
        operation.result.representation.kind === 'native-handle' &&
        operation.result.representation.protocol === 'Math'
    )
  assert.ok(reads.length)
  for (const read of reads) {
    assert.ok(read.kind === 'binding-read')
    assert.equal(result.projection.placements.get(read.declaration)?.storage.kind, 'external')
  }
})
