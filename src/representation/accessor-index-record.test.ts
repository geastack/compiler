import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'

/**
 * pino's `prototype`: accessor pairs beside members keyed by symbols a
 * CommonJS module exports, which the checker types as plain `symbol` and so
 * as index storage. No native record holds both. That is the storage static
 * specialization cannot select -- boxed when the program opts in, refused by
 * name when it does not.
 */
const proto = resolve('test/fixtures/accessor-index-record/proto.js')
const refusal = 'no native record carrier preserves both index storage and accessor descriptors'

const refusalsOf = (dynamicFallback: boolean): readonly string[] =>
  compile({ rootFileNames: [proto], projectFileName: null, javaScriptSources: true, dynamicFallback })
    .diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root' && diagnostic.message.includes(refusal))
    .map((diagnostic) => diagnostic.message)

test('an accessor record with symbol index storage is boxed under the dynamic fallback', () => {
  assert.deepEqual(refusalsOf(true), [])
})

test('without the opt-in the same record still refuses by name', () => {
  assert.notDeepEqual(refusalsOf(false), [])
})
