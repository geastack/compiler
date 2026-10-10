import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const projectFileName = resolve('test/runtime/tsconfig.json')
for (const name of ['class-trace-leaf-root.runtime.ts', 'for-let-per-iteration-binding-closures.runtime.ts'])
  test(`native array insertion retains callable source provenance in ${name}`, () => {
    const result = compile({ rootFileNames: [resolve('test/runtime', name)], projectFileName, closedScriptScope: true })
    const checkerErrors = result.diagnostics.diagnostics.filter(({ id }) => id.startsWith('checker/'))
    assert.equal(checkerErrors.length, 0, checkerErrors.map(({ id, message }) => `${id}: ${message}`).join('\n'))
    assert.ok(result.source !== null, result.refusals.map(({ key, reason }) => `${key}: ${reason}`).join('\n'))
    assert.ok(result.certificate !== null)
    assert.equal(result.slotDrift.length, 0)
    assert.equal(result.emissionRefusals.length, 0)
  })
