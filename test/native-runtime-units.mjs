import { executableSuffix } from './executable-suffix.mjs'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

// Assertion-style runtime units under test/runtime/*.cpp that no other
// harness builds: each is a `main` over `gea_runtime.h` that asserts, so a
// non-zero exit is the failure. `allocation-runtime.mjs` owns the units whose
// point is the allocator and collector (they need the profiling flags); these
// need only the sanitizers. The `*-benchmark` and `array-store-hot-path` /
// `pcm-kernel` units measure rather than assert and are run by hand.
const units = [
  'array-incomplete-element',
  'dynamic-nominal-runtime',
  'dynamic-regexp-runtime',
  'dynamic-tonumber-runtime',
  'native-dynamic-equality-runtime',
  'native-integrity-runtime',
  'native-key-only-runtime',
  'native-method-cache',
  'native-record-property-runtime',
  'native-symbol-index-runtime',
  'numeric-conversion-runtime',
  'numeric-conversion-soft-double-runtime',
  'regexp-p1-runtime',
  'typed-array-copy-runtime'
]

const root = resolve(import.meta.dirname, '..')
const output = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'native-runtime-units-'))
const run = promisify(execFile)
const failures = []

const check = async (name) => {
  const binary = join(output, `${name}-test${executableSuffix}`)
  try {
    await run(
      process.env.CXX || 'clang++',
      [
        '-std=c++20',
        '-O1',
        '-g',
        '-fsanitize=address,undefined',
        `-I${resolve(root, 'src/targets/cpp/runtime')}`,
        resolve(root, 'test/runtime', `${name}.cpp`),
        '-o',
        binary
      ],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    await run(binary, [], { maxBuffer: 64 * 1024 * 1024 })
    console.log(`${name}: passed with ASan/UBSan`)
  } catch (error) {
    failures.push(name)
    console.error(`${name}: FAILED\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
}

// A few at a time: each is one translation unit over the 37k-line runtime header.
const queue = [...units]
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) await check(name)
  })
)
rmSync(output, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`${failures.length} native runtime unit(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
