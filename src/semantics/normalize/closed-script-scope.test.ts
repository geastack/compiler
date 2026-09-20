import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

test('the compile request carries its script lexical boundary through every inference round', () => {
  const entry = resolve('test/fixtures/closed-script-scope.ts')
  // Like native-stored-event-callback, exercise geatsc's inferred parameter
  // carrier independently of TypeScript's noImplicitAny diagnostic.
  const source = `// @ts-nocheck
    class Recorder { amount = 0; record(value) { this.amount = value } }
    const recorder = new Recorder(); recorder.record(7); console.log(recorder.amount);
  `
  for (const closedScriptScope of [false, true, false]) {
    const result = compile({
      rootFileNames: [entry],
      projectFileName: null,
      sourceOverlay: new Map([[entry, source]]),
      plugins: [],
      closedScriptScope
    })
    assert.ok(result.units.length > 0, JSON.stringify(result.diagnostics))
    const emitted = result.units
      .filter((unit) => unit.role !== 'runtime-header')
      .map((unit) => unit.source)
      .join('\n')
    assert.equal(emitted.includes('gea::Value::box'), !closedScriptScope)
  }
})
