import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(root, 'measurements/native-document-view-contracts')
execFileSync(process.env.CXX ?? 'clang++', [
  '-std=c++20',
  ...nativeOptimization('correctness'),
  '-g',
  '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all',
  `-I${resolve(root, 'src/targets/cpp/runtime')}`,
  resolve(root, 'test/runtime/native-document-view-runtime.cpp'),
  '-o',
  executable
])
const output = execFileSync(executable, [], {
  encoding: 'utf8',
  env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' }
})
assert.equal(output, 'Native Document owner contracts passed\n')
process.stdout.write(output)
