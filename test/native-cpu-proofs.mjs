import { nativeOptimization } from '../scripts/native-optimization.mjs'
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Its own build directory, so the suite can run it beside the other native scripts.
mkdirSync(new URL('../measurements/cxx-native-cpu-proofs', import.meta.url), { recursive: true })

const root = resolve(import.meta.dirname, '..')
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0 || result.error) {
    if (result.error) process.stderr.write(`${result.error}\n`)
    process.exit(1)
  }
}
// These selections contain standalone programs. Each is emitted,
// linked and run serially against dist; no service or database is involved.
for (const name of [
  'type-query-',
  'borrow-helper-',
  'borrow-guarded-field.ts',
  'borrow-effectful-private-actual.ts',
  'owned-string-dynamic-transfer.ts',
  'typed-array-loop-',
  'array-multiple-windows.ts',
  'typeof-runtime-string.ts',
  'native-error-descriptor-inheritance.ts',
  'string-invariant-char-code.ts',
  'string-shared-layout.ts'
])
  run(process.execPath, ['scripts/run-runtime-tests.mjs', '--only', name, '--out-dir', 'measurements/cxx-native-cpu-proofs'])

for (const name of [
  'dense-index-window-runtime',
  'typed-array-window-runtime',
  'borrowed-call-runtime',
  'borrowed-entry-runtime',
  'allocation-cycle-safepoint',
  'callable-static-initialization',
  'string-access-runtime',
  'dynamic-array-runtime',
  'dynamic-iterator-runtime',
  'native-record-enumeration-runtime'
]) {
  const binary = resolve(root, 'measurements/cxx-native-cpu-proofs', name)
  run(process.env.CXX ?? 'clang++', [
    '-std=c++20',
    ...nativeOptimization('aggressive'),
    '-fstrict-aliasing',
    '-fsanitize=address,undefined',
    '-I',
    resolve(root, 'src/targets/cpp/runtime'),
    resolve(root, 'test/runtime', `${name}.cpp`),
    '-o',
    binary
  ])
  run(binary, [])
  process.stdout.write(`ok    ${name}.cpp (O3, strict aliasing, ASan/UBSan)\n`)
}
