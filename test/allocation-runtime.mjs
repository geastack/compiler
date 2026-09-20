import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
for (const name of [
  'allocation-profile',
  'allocation-cycle-safepoint',
  'weak-collection-update',
  'native-expando-reclaim',
  'promise-job-sink',
  'cycle-collector-generations',
  'cycle-collector-untraced-owner-cascade',
  'callable-identity-lazy',
  'function-properties-null-held',
  'allocation-hot-paths',
  'host-array-snapshot',
  'host-numeric-argument',
  'dictionary-read-snapshot'
]) {
  const binary = resolve(root, 'measurements/cxx', `${name}-test${executableSuffix}`)
  execFileSync(
    process.env.CXX || 'clang++',
    [
      '-std=c++20',
      '-O1',
      '-g',
      '-fsanitize=address,undefined',
      '-DGEA_PROFILE_ALLOCATIONS=1',
      // This test's mechanism is a stale-pointer write into a freed block's
      // bytes, which the pool's free-list recycling can mask from ASan (the
      // "freed" block stays a live allocation from the allocator's own view).
      // The pool-bypass mode gives every cell to `::operator new`/`delete`
      // individually so ASan's redzone actually sees the use-after-free.
      ...(name === 'cycle-collector-untraced-owner-cascade' ? ['-DGEA_RUNTIME_COMPACT_ALLOCATION=1'] : []),
      `-I${resolve(root, 'src/targets/cpp/runtime')}`,
      resolve(root, 'test/runtime', name + '.cpp'),
      '-o',
      binary
    ],
    { stdio: 'inherit' }
  )
  execFileSync(binary, { stdio: 'inherit' })
  if (name === 'host-array-snapshot' || name === 'host-numeric-argument') {
    const sparse = spawnSync(binary, ['hole'], { encoding: 'utf8' })
    assert.notEqual(sparse.status, 0)
    assert.match(sparse.stderr, /array with a hole at index (1|3)/)
  }
  console.log(name + ': passed with ASan/UBSan')
}
