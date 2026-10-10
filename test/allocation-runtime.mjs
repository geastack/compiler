import { nativeOptimization } from '../scripts/native-optimization.mjs'
import { mkdirSync } from 'node:fs'
import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

// Its own build directory, so the suite can run it beside the other native scripts.
mkdirSync(new URL('../measurements/cxx-allocation-runtime', import.meta.url), { recursive: true })

const root = resolve(import.meta.dirname, '..')
const run = promisify(execFile)
// Each unit is an independent sanitized build of the whole runtime (~30 s), so
// a serial loop made this script the suite's long pole by a factor of two.
const nativeJobs = Number(process.env.GEA_TEST_NATIVE_JOBS ?? '4')
if (!Number.isInteger(nativeJobs) || nativeJobs < 1) throw new Error('GEA_TEST_NATIVE_JOBS must be a positive integer')
const units = [
  'allocation-profile',
  'allocation-cycle-safepoint',
  'compact-cycle-collection',
  'weak-collection-update',
  'native-expando-reclaim',
  'promise-job-sink',
  'async-suspension',
  'promise-union-no-throwaway-state',
  'cycle-collector-generations',
  'cycle-collector-task-handoff',
  'cycle-collector-untraced-owner-cascade',
  'callable-identity-lazy',
  'function-properties-null-held',
  'allocation-hot-paths',
  'host-array-snapshot',
  'host-numeric-argument',
  'jsx-numeric-style',
  'native-view-json',
  'dictionary-read-snapshot',
  'compact-number-format',
  'callable-box-equality',
  'holder-and-shared-environment',
  'callable-pointer-adapters',
  'cycle-self-loop-reclaim',
  'cycle-dead-candidate-forgotten',
  'cycle-dip-cache',
  'cycle-graph-chunk-refusal',
  'cycle-trace-leaf-record',
  'cycle-trace-leaf-class',
  'borrowed-executor-environment',
  'optional-ref-one-word',
  'small-array-inline'
]
const check = async (name) => {
  const binary = resolve(root, 'measurements/cxx-allocation-runtime', `${name}-test${executableSuffix}`)
  const built = await run(
    process.env.CXX || 'clang++',
    [
      '-std=c++20',
      ...nativeOptimization('allocation'),
      '-g',
      '-fsanitize=address,undefined',
      '-DGEA_PROFILE_ALLOCATIONS=1',
      ...(name === 'cycle-collector-task-handoff' ? ['-pthread'] : []),
      // This test's mechanism is a stale-pointer write into a freed block's
      // bytes, which the pool's free-list recycling can mask from ASan (the
      // "freed" block stays a live allocation from the allocator's own view).
      // The pool-bypass mode gives every cell to `::operator new`/`delete`
      // individually so ASan's redzone actually sees the use-after-free.
      ...(name === 'cycle-collector-untraced-owner-cascade' || name === 'cycle-self-loop-reclaim'
        ? ['-DGEA_RUNTIME_COMPACT_ALLOCATION=1', '-fsized-deallocation']
        : []),
      `-I${resolve(root, 'src/targets/cpp/runtime')}`,
      resolve(root, 'test/runtime', name + '.cpp'),
      '-o',
      binary
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const ran = await run(binary, { maxBuffer: 64 * 1024 * 1024 })
  process.stdout.write(built.stdout + built.stderr + ran.stdout + ran.stderr)
  if (name === 'host-array-snapshot' || name === 'host-numeric-argument') {
    const sparse = spawnSync(binary, ['hole'], { encoding: 'utf8' })
    assert.notEqual(sparse.status, 0)
    assert.match(sparse.stderr, /array with a hole at index (1|3)/)
  }
  if (name === 'async-suspension') {
    // A blocking await inside a Promise job is a nested pump; it must abort, never pump.
    const reentrant = spawnSync(binary, ['reentrant'], { encoding: 'utf8' })
    assert.notEqual(reentrant.status, 0)
    assert.match(reentrant.stderr, /blocking await .* entered inside a Promise job/)
  }
  console.log(name + ': passed with ASan/UBSan')
}

const failures = []
const queue = [...units]
await Promise.all(
  Array.from({ length: Math.min(nativeJobs, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift()
      try {
        await check(name)
      } catch (error) {
        failures.push(name)
        console.error(`${name}: FAILED\n${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`)
      }
    }
  })
)
assert.deepEqual(failures, [], 'allocation runtime units failed')
