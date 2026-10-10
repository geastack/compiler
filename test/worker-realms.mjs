import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const include = `-I${resolve(root, 'src/targets/cpp/runtime')}`
const binary = resolve(root, 'dist/worker-realms-test')
const flags = [
  '-std=c++20',
  ...nativeOptimization('correctness'),
  '-fsanitize=address,undefined',
  '-DGEA_RUNTIME_REALMS=1',
  '-DGEA_RUNTIME_SINGLE_THREADED=1',
  '-DGEA_RUNTIME_COMPACT_ALLOCATION=1',
  '-fsized-deallocation',
  include
]
const env = { ...process.env, TMPDIR: resolve(root, 'dist') }
execFileSync('clang++', [...flags, resolve(root, 'test/runtime/array-buffer-transfer.cpp'), '-o', binary], { stdio: 'inherit', env })
execFileSync(binary, { stdio: 'inherit', env })
execFileSync('clang++', [...flags, resolve(root, 'test/runtime/worker-realms.cpp'), '-o', binary], { stdio: 'inherit', env })
execFileSync(binary, { stdio: 'inherit', env })
execFileSync(
  'clang++',
  [...flags.filter((flag) => flag !== '-DGEA_RUNTIME_COMPACT_ALLOCATION=1'), resolve(root, 'test/runtime/worker-realms.cpp'), '-o', binary],
  { stdio: 'inherit', env }
)
execFileSync(binary, { stdio: 'inherit', env })

const result = compile({
  rootFileNames: [resolve(root, 'test/runtime/worker-module-realms.ts')],
  projectFileName: null,
  realmStorage: true,
  entrySymbol: 'worker_entry'
})
assert.ok(result.certificate, JSON.stringify(result.diagnostics))
assert.deepEqual(result.emissionRefusals, [])
assert.ok(result.source)
assert.match(result.source, /realmSlot<RealmTag/)
const source = `${result.source}
#include <thread>
int main() {
  gea::detail::RuntimeRealm a, b;
  { gea::detail::RuntimeRealmScope scope(a); worker_entry(); }
  { gea::detail::RuntimeRealmScope scope(b); worker_entry(); }
}
`
execFileSync('clang++', [...flags, '-x', 'c++', '-', '-o', binary], { input: source, stdio: ['pipe', 'inherit', 'inherit'], env })
assert.equal(execFileSync(binary, { encoding: 'utf8', env }), '1:1\n1:1\n')
console.log('Worker realm storage, root handoff, native allocations and promise isolation passed')
