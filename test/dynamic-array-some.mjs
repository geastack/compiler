import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { executableSuffix } from './executable-suffix.mjs'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/cxx-allocation-runtime')
mkdirSync(output, { recursive: true })
const binary = resolve(output, `dynamic-array-some-test${executableSuffix}`)
const env = { ...process.env, GEA_AUDIO_DISABLED: '1' }
let calls = 0
const sparse = [, 7]
assert.equal(
  sparse.some(function (v, i, receiver) {
    calls++
    assert.equal(this, 42)
    assert.equal(v, 7)
    assert.equal(i, 1)
    assert.equal(receiver, sparse)
    return true
  }, 42),
  true
)
assert.equal(calls, 1)
for (const receiver of [null, undefined]) assert.throws(() => Array.prototype.some.call(receiver, () => true), TypeError)
assert.throws(() => [].some(1), TypeError)
const changed = { 0: 1, 1: 2, length: 2 }
calls = 0
assert.equal(
  Array.prototype.some.call(changed, (_, i) => {
    calls++
    if (!i) {
      delete changed[1]
      changed[2] = 99
      changed.length = 3
    }
    return false
  }),
  false
)
assert.equal(calls, 1)
let reads = 0
assert.equal(
  Array.prototype.some.call(
    {
      0: 1,
      get length() {
        reads++
        return Infinity
      }
    },
    () => 'truthy'
  ),
  true
)
assert.equal(reads, 1)
const oldIndex = Object.getOwnPropertyDescriptor(Array.prototype, '1')
const oldLength = Array.prototype.length
try {
  Object.defineProperty(Array.prototype, '1', { value: 7, configurable: true })
  const nativeSparse = new Array(2)
  assert.equal(1 in nativeSparse, true)
  assert.equal(nativeSparse[1], 7)
  assert.equal(
    nativeSparse.some((v) => v === 7),
    true
  )
  let inheritedReads = 0
  Object.defineProperty(Array.prototype, '1', {
    configurable: true,
    get() {
      inheritedReads++
      assert.equal(this, nativeSparse)
      return 7
    }
  })
  assert.equal(1 in nativeSparse, true)
  assert.equal(inheritedReads, 0)
  assert.equal(nativeSparse[1], 7)
  Object.defineProperty(nativeSparse, '1', { value: undefined, configurable: true })
  assert.equal(nativeSparse[1], undefined)
  assert.equal(inheritedReads, 1)
  delete nativeSparse[1]
  delete Array.prototype[1]
  assert.equal(1 in nativeSparse, false)
} finally {
  if (oldIndex) Object.defineProperty(Array.prototype, '1', oldIndex)
  else delete Array.prototype[1]
  Array.prototype.length = oldLength
}
const { proxy, revoke } = Proxy.revocable((v) => !!v, {})
assert.equal(sparse.some(proxy), true)
revoke()
assert.equal([].some(proxy), false)
assert.throws(() => sparse.some(proxy), TypeError)
assert.equal(
  sparse.some(
    new Proxy(() => false, {
      apply(target, self, args) {
        assert.equal(self, 42)
        assert.deepEqual(args, [7, 1, sparse])
        return true
      }
    }),
    42
  ),
  true
)
let nested = 0
assert.equal(
  sparse.some((v, i, receiver) => {
    nested++
    return receiver.some(() => true)
  }),
  true
)
assert.equal(nested, 1)
const inherited = { 1: 7 }
const traced = Object.assign(Object.create(inherited), { 0: 1, 2: 9, length: 4 })
let trace = '',
  count = 0
const answer = Array.prototype.some.call(traced, (v, i) => {
  count++
  trace += `${i}:${v},`
  return v > 5
})
const expected = `${trace};${answer};${count}\n`
const compile = spawnSync(
  process.env.CXX || 'clang++',
  [
    '-std=c++20',
    '-O1',
    '-g',
    '-fsanitize=address,undefined',
    '-I',
    resolve(root, 'src/targets/cpp/runtime'),
    resolve(root, 'test/runtime/dynamic-array-some.cpp'),
    '-o',
    binary
  ],
  { env, encoding: 'utf8', timeout: 180000 }
)
process.stdout.write((compile.stdout || '') + (compile.stderr || ''))
assert.equal(compile.error, undefined)
assert.equal(compile.status, 0)
const run = spawnSync(binary, [], { env, encoding: 'utf8', timeout: 10000 })
process.stdout.write((run.stdout || '') + (run.stderr || ''))
assert.equal(run.error, undefined)
assert.equal(run.status, 0)

assert.equal(run.stdout, expected)
