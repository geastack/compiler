import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const list = (...args) => spawnSync(process.execPath, ['scripts/run-oracle-tests.mjs', ...args, '--list-json'], { cwd: root, encoding: 'utf8' })
test('ordinary oracle selection stays in its existing domain', () => {
  const result = list()
  assert.equal(result.status, 0, result.stderr)
  assert.ok(JSON.parse(result.stdout).selected > 0)
  assert.ok(!JSON.parse(result.stdout).candidates.includes('class-definition-phase-order.runtime.ts'))
})
test('runtime selection names actual canonical entries without copies or native execution', () => {
  const names = ['class-definition-phase-order.runtime.ts', 'class-static-block-capture-identity.runtime.ts', 'class-computed-key-abrupt.runtime.ts', 'class-computed-key-binding-tdz.runtime.ts']
  const result = list('--runtime-files', names.join(','))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).candidates, names)
})
test('runtime selection rejects outside entries and ambiguous domains', () => {
  assert.equal(list('--runtime-files', '../fixtures/async-iteration-class.ts').status, 2)
  assert.notEqual(list('--runtime-files', 'class-definition-phase-order.runtime.ts', '--files', 'other.ts').status, 0)
})
