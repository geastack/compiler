import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

/**
 * fast-json-stringify's `cloneOriginSchema` starts from
 * `Array.isArray(schema) ? [] : {}`. The checker reduces that join to `{}`,
 * which states nothing, while the return census keeps both arms; the
 * parameter census publishing the reduced `{}` for the call gave the
 * invocation two result types.
 */
const conditional = resolve('test/fixtures/vacuous-inferred-return/conditional.js')

test('a call whose inferred return reduces to a vacuous {} publishes one result type', () => {
  const roots = compile({ rootFileNames: [conditional], projectFileName: null, javaScriptSources: true, dynamicFallback: true })
    .diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
    .map((diagnostic) => diagnostic.message)
  assert.deepEqual(
    roots.filter((message) => message.includes('disagrees with selected return type')),
    []
  )
})
