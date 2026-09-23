import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'

/**
 * fast-uri's `/** @type {SchemeFn} *\/ function httpParse (component)`: the
 * declaration's stated type calls it with two arguments and its body reads one.
 * The frame the body binds is a leading prefix of the one the ABI declares, and
 * the language itself pushes the surplus and never binds it. The other
 * direction -- a body binding a position no caller pushes -- still blocks.
 */
const directory = resolve('test/fixtures/abi-leading-prefix')

const compiled = (file: string) =>
  compile({ rootFileNames: [resolve(directory, file)], projectFileName: null, javaScriptSources: true, dynamicFallback: true })

test('a body binding a leading prefix of its declared frame takes the declared convention', () => {
  const result = compiled('shorter-body.js')
  assert.deepEqual(
    result.abiBlockers.map((blocker) => blocker.reason),
    []
  )
  assert.notEqual(result.certificate, null)
})

test('a body binding more positions than its declared frame still blocks', () => {
  const result = compiled('longer-body.js')
  assert.ok(
    result.abiBlockers.some((blocker) => /binds 2 physical parameter\(s\) but the ABI declares 1/.test(blocker.reason)),
    JSON.stringify(result.abiBlockers)
  )
})
