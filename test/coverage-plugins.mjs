import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/coverage-plugins')
const invoke = (flags) =>
  spawnSync(process.execPath, [resolve(root, 'dist/cli.js'), 'coverage', 'entry.ts', '--no-project', '--json', ...flags], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 120000
  })

const accepted = [
  ['no explicit plugin', []],
  ['default object export', ['--plugin', './object.mjs']],
  ['default factory export', ['--plugin', './factory.mjs']],
  [
    'repeated flags with a duplicate path',
    ['--plugin', './object.mjs', '--plugin', './factory.mjs', '--plugin', resolve(fixture, 'object.mjs'), '--plugin-option', 'k=v']
  ]
]
for (const [label, flags] of accepted) {
  test(`coverage: ${label}`, () => {
    const result = invoke(flags)
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout)
    assert.equal(typeof report.summary, 'object')
    assert.equal(report.summary.certified, true)
  })
}

const rejected = [
  // Only a loaded built-in can collide, so this proves an explicit plugin no
  // longer replaces the built-in set.
  ['a plugin named like a built-in', ['--plugin', './builtin-conflict.mjs'], /duplicate plugin name "gea" conflicts with built-in/],
  ['a missing module', ['--plugin', './missing.mjs'], /missing\.mjs.*ENOENT/],
  // Measuring without the named plugin would report another build's numbers.
  ['a flag with no module', ['--plugin', '--json'], /requires a module path or specifier/]
]
for (const [label, flags, diagnostic] of rejected) {
  test(`coverage: rejects ${label}`, () => {
    const result = invoke(flags)
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, '')
    const lines = result.stderr.trimEnd().split(/\r?\n/)
    assert.equal(lines.length, 1, result.stderr)
    assert.match(lines[0], /^coverage: --plugin /)
    assert.match(lines[0], diagnostic)
  })
}
