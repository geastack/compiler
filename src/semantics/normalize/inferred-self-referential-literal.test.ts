import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../compiler.js'

/**
 * toad-cache's and fastify's linked records: an anonymous object literal whose
 * field reads the binding the same function then assigns that literal to. The
 * checker infers a genuinely self-referential type for it, and the same shape
 * written as an interface was already carried -- only the inferred spelling
 * reached representation with no shape at all.
 */
const directory = resolve('test/fixtures/inferred-self-referential-literal')

const compiled = (file: string) =>
  compile({ rootFileNames: [resolve(directory, file)], projectFileName: null, javaScriptSources: true, dynamicFallback: true })

const rootsOf = (result: ReturnType<typeof compile>): readonly string[] =>
  result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root').map((diagnostic) => diagnostic.message)

test('an inferred self-referential object literal is carried like its declared twin', () => {
  const result = compiled('feedback.js')
  assert.deepEqual(rootsOf(result), [])
  assert.notEqual(result.certificate, null)
})

test('the declared shape of the same cycle certifies', () => {
  const result = compiled('declared.ts')
  assert.deepEqual(rootsOf(result), [])
  assert.notEqual(result.certificate, null)
})
