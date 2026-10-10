import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const binary = resolve(output, 'native-array-live-view')
const env = { ...process.env, TMPDIR: output }
execFileSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-g',
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    resolve(root, 'test/runtime/native-array-live-view.cpp'),
    '-o',
    binary
  ],
  { env, stdio: 'inherit' }
)
assert.equal(execFileSync(binary, { encoding: 'utf8', env: { ...env, ASAN_OPTIONS: 'detect_leaks=0' } }), 'NATIVE_ARRAY_LIVE_VIEW_OK\n')
console.log('PASS native array live views preserve storage, descriptors, and observation')
