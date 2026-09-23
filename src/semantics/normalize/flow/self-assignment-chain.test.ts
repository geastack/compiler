import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `v = v.concat([2])`, thirteen times: each call's receiver plan expands
 * through every write to `v`, so each question re-enters all the others, and a
 * refusal computed under that re-entry is conditional on the call guard that
 * handed it out. Kept only while that exact guard stayed open, the shared
 * answers were re-derived once per stack context -- 2^n of them -- and
 * fast-json-stringify's generated validator never finished compiling.
 *
 * In a child process because `compile` is synchronous: a test timeout never
 * interrupts it, so a regression would hang the suite instead of failing it.
 */
const compilerEntry = fileURLToPath(new URL('../../../compiler.js', import.meta.url))
const chain = resolve('test/fixtures/self-assignment-chain/chain.js')

const childScript = `
import { compile } from ${JSON.stringify(compilerEntry)}
const result = compile({ rootFileNames: [${JSON.stringify(chain)}], projectFileName: null, javaScriptSources: true, dynamicFallback: true })
const roots = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root').map((diagnostic) => diagnostic.message)
process.stdout.write(JSON.stringify(roots))
`

test('a chain of self-referential method-call assignments compiles in bounded time', () => {
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: childScript, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.signal, null, 'the compile did not finish within its budget')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [])
})
