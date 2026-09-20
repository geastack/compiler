import assert from 'node:assert/strict'
import test from 'node:test'
import { compile } from '../../../compiler.js'

test('optional void methods retain a callable ABI compatible with their declared fields', () => {
  const result = compile({ rootFileNames: ['test/fixtures/optional-call.ts'], projectFileName: null })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
})

test('intrinsic prototype reads use the carrier stated by their host template', () => {
  const result = compile({ rootFileNames: ['test/runtime/static-intrinsic-reflection.runtime.js'], projectFileName: null })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
})

test('retaining a native superclass does not expose instance fields to boxed reflection', () => {
  const result = compile({
    rootFileNames: ['test/runtime/native-class-identity-upcast.ts'],
    projectFileName: 'test/runtime/tsconfig.json'
  })
  assert.ok(result.source, JSON.stringify(result.emissionRefusals))
  assert.ok(!result.source.includes('gea::Value::box'))
  assert.ok([...result.reflection!.classes.values()].every((demand) => demand.level === 'keys-only'))
})
