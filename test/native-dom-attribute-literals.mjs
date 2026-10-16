import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, 'measurements/cxx-allocation-runtime')
mkdirSync(output, { recursive: true })
const binary = resolve(output, 'native-dom-attribute-literals-test')
const args = [
  '-std=c++20',
  '-O1',
  '-g',
  '-fsanitize=address,undefined',
  '-I',
  resolve(root, 'src/targets/cpp/runtime'),
  resolve(root, 'test/runtime/native-dom-attribute-literals.cpp'),
  '-o',
  binary
]
const env = { ...process.env, GEA_AUDIO_DISABLED: '1' }
for (const [command, argv, timeout] of [
  [process.env.CXX || 'clang++', args, 180000],
  [binary, [], 10000]
]) {
  const r = spawnSync(command, argv, { encoding: 'utf8', env, timeout })
  process.stdout.write((r.stdout || '') + (r.stderr || ''))
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0)
}
