import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from '../../plugins/model.js'

const entry = resolve('test/runtime/dynamic-host-argument-waiver-probe.ts')
const host: CompilerPlugin = {
  name: 'generic-ambient-binding-test',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      hostFunctions: new Map([['nativeEcho', 'test::native_echo']])
    }
  })
}

const compileSource = (source: string) =>
  compile({
    rootFileNames: [entry],
    projectFileName: null,
    includeIr: true,
    plugins: [host],
    sourceOverlay: new Map([[entry, source]])
  })

test('generic ambient calls share their installed host binding while concrete source frames stay specialized', () => {
  const result = compileSource(`export {}
    declare function nativeEcho<T>(value: T): T
    function forward<T>(value: T): T { return nativeEcho(value) }
    console.log(forward(7), forward('native'))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const bindings = [...result.projection.placements].filter(
    ([, placement]) => placement.storage.kind === 'host-function' && placement.storage.linkageName === 'nativeEcho'
  )
  assert.equal(bindings.length, 1)
  const declaration = bindings[0]![0]
  const reads = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'binding' && operation.action === 'read' && operation.declaration === declaration
  )
  assert.equal(reads.length, 2)
  assert.deepEqual(
    reads
      .map((read) => result.representations.plan.selected.get(read.results.find((value) => value.role === 'value')!.id)!)
      .map((carrier) => {
        assert.equal(carrier.kind, 'function-value-dispatch')
        return carrier.kind === 'function-value-dispatch' ? carrier.abi.parameters[0]!.value.kind : null
      })
      .sort(),
    ['scalar', 'string']
  )
  const frames = (result.irBodies ?? []).flatMap((body) => (body.abi === null ? [] : [body.abi]))
  assert.deepEqual(frames.map((frame) => frame.parameters[0]!.value.kind).sort(), ['scalar', 'string'])
  assert.ok(frames.every((frame) => frame.result.kind === frame.parameters[0]!.value.kind))
  assert.match(result.source!, /test::native_echo/)
})

test('a same-named ordinary generic definition keeps its source copies instead of borrowing the ambient host', () => {
  const result = compileSource(`export {}
    function nativeEcho<T>(value: T): T { return value }
    console.log(nativeEcho(7), nativeEcho('local'))
  `)
  assert.equal(result.diagnostics.clean, true, JSON.stringify(result.diagnostics.diagnostics))
  assert.notEqual(result.certificate, null, JSON.stringify(result.refusals))
  assert.notEqual(result.source, null, JSON.stringify(result.emissionRefusals))
  const frames = (result.irBodies ?? []).flatMap((body) => (body.abi === null ? [] : [body.abi]))
  assert.deepEqual(frames.map((frame) => frame.parameters[0]!.value.kind).sort(), ['scalar', 'string'])
  assert.doesNotMatch(result.source!, /test::native_echo/)
})
