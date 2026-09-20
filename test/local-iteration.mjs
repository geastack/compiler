import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

test('private native cursors preserve key deletion, snapshots, live array growth, holes, and generator state', () => {
  const root = resolve(import.meta.dirname, '..')
  const fixture = resolve(root, 'test/runtime/local-iteration.ts')
  const result = compile({ rootFileNames: [fixture] })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  assert.match(result.source, /gea::LocalDictionaryCursor<std::string>/)
  assert.match(result.source, /gea::LocalArrayCursor<std::string>/)
  const binary = resolve(root, `measurements/local-iteration${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-O2', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    { input: `${result.source}\nint main() { __gea_top_level(); }\n` }
  )
  const expected = execFileSync(process.execPath, ['--experimental-strip-types', fixture], { encoding: 'utf8' }).trim()
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), expected)
})
