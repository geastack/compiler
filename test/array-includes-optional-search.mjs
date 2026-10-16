import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
test('optional primitive includes search preserves native presence, SameValueZero and fromIndex', () => {
  const result = compile({
    rootFileNames: [resolve('test/runtime/array-includes-optional-search.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true
  })
  assert.equal(result.diagnostics.diagnostics.length, 0, result.diagnostics.diagnostics.map((x) => x.message).join('\n'))
  assert.ok(result.certificate, result.refusals.map((x) => `${x.key}: ${x.reason}`).join('\n'))
  assert.equal(result.emissionRefusals.length, 0, result.emissionRefusals.map((x) => `${x.key}: ${x.reason}`).join('\n'))
  assert.ok(result.source)
  assert.match(result.source, /gea_search\.has_value\(\)/)
  assert.match(result.source, /gea::sameValueZero/)
  assert.match(result.source, /gea::runtime::array::relativeIndex/)
})
test('optional search with a different payload keeps the existing fail-closed comparison boundary', () => {
  const result = compile({
    rootFileNames: [resolve('test/fixtures/array-includes-optional-search-mismatch.ts')],
    projectFileName: resolve('test/runtime/tsconfig.json'),
    closedScriptScope: true
  })
  assert.equal(result.source, null)
  assert.ok(
    result.emissionRefusals.some((x) => String(x.reason).includes("receiver's own element carrier")),
    result.emissionRefusals.map((x) => x.reason).join('\n')
  )
})
