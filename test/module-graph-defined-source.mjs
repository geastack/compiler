import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/module-graph-defined-source')
const compile = (graph) =>
  spawnSync(
    process.execPath,
    [
      resolve(root, 'dist/cli.js'),
      'compile-module-graph',
      graph,
      '--entry',
      'entry.ts',
      '--project',
      'tsconfig.json',
      '--out-dir',
      resolve(root, 'measurements/module-graph-defined-source')
    ],
    { cwd: fixture, encoding: 'utf8', timeout: 120000 }
  )

// `lib.ts` reads `process.env.NODE_ENV`, which a bundler defines and this
// program never declares. The build states the text it defined for that module.
test('a disk module is compiled from the text the build states for it', () => {
  const result = compile('graph.json')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^compile: .*entry\.cpp \(\d+ lines\)$/m)
})

test('a disk module the build states no text for is compiled from disk', () => {
  const result = compile('graph-disk.json')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /lib\.ts:2:7: Cannot find name 'process'/)
})
