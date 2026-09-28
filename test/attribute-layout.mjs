import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compile } from '../dist/compiler.js'
import { inertPluginInstance } from '../dist/plugins/model.js'

// A render object's attribute list, gathered from a geometry that holds a plain
// and an interleaved attribute, and a vertex-layout loop that reads `offset`
// only behind `isInterleavedBufferAttribute === true`. The package's JSDoc
// states `Array<BufferAttribute>` for a list that also holds the interleaved
// attribute, and names classes its files never import. Every step of the
// chain must type from the program's own writes and tests, so the program
// certifies and lowers with no capability refusal.

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/attribute-layout')

const uncheckedPackage = {
  name: 'unchecked-attrlib',
  instantiate: () => ({
    ...inertPluginInstance,
    capabilities: { ...inertPluginInstance.capabilities, uncheckedJavaScript: new Set(['attrlib/src/**']) }
  })
}

test('the attribute list and its layout loop certify and lower', () => {
  const result = compile({
    rootFileNames: [resolve(fixture, 'entry.ts')],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    plugins: [uncheckedPackage]
  })
  const certify = result.refusals.filter((refusal) => refusal.stage === 'certify').map((refusal) => refusal.key)
  assert.deepEqual(certify, [])
  assert.deepEqual(result.loweringBlockers, [])
  assert.ok(result.certificate)
})
