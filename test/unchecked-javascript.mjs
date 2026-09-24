import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createProgram } from '../dist/semantics/program.js'

// `PluginCapabilities.uncheckedJavaScript`: package file globs whose JavaScript
// reports no checker diagnostics, as `// @ts-nocheck` would, with the source
// left as written. Every JS file in the fixture has one JSDoc type error;
// `loose-lib/src/**` covers two of them (one nested), and `loose-lib/extra`
// and `strict-lib/src` stay checked.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/unchecked-js')
const covered = ['vendor/loose-lib/src/scale.js', 'vendor/loose-lib/src/nested/deep.js'].map((file) => resolve(fixture, file))
const uncovered = ['vendor/loose-lib/extra/other.js', 'vendor/strict-lib/src/scale.js'].map((file) => resolve(fixture, file))
const entry = resolve(fixture, 'entry.ts')

const programWith = (uncheckedJavaScript) =>
  createProgram({
    rootFileNames: [entry],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    options: {},
    ...(uncheckedJavaScript ? { uncheckedJavaScript } : {})
  })

const errorsIn = (compiled, file) =>
  compiled.diagnostics.filter((diagnostic) => diagnostic.file && resolve(diagnostic.file.fileName) === file)

test('without the policy every JS file in the fixture reports its type error', () => {
  const compiled = programWith(null)
  for (const file of [...covered, ...uncovered]) assert.equal(errorsIn(compiled, file).length, 1, file)
})

test('covered files report no checker errors, keep their text, and still type their callers', () => {
  const compiled = programWith(new Set(['loose-lib/src/**']))
  for (const file of covered) {
    assert.deepEqual(errorsIn(compiled, file), [], file)
    // Nothing was inserted: the checker read the file exactly as it is on disk.
    assert.equal(compiled.program.getSourceFile(file)?.text, readFileSync(file, 'utf8'), file)
  }
  for (const file of uncovered) assert.equal(errorsIn(compiled, file).length, 1, file)
  // `scale`'s `@returns {number}` still types the call in the checked entry.
  const entryErrors = errorsIn(compiled, entry).map((diagnostic) => diagnostic.messageText)
  assert.deepEqual(entryErrors, ["Type 'number' is not assignable to type 'string'."])
})

test('the policy reports what a literal // @ts-nocheck prefix reports', () => {
  const summary = (compiled) =>
    compiled.diagnostics.map((diagnostic) => `${diagnostic.file ? resolve(diagnostic.file.fileName) : ''}|${diagnostic.code}`).sort()
  const prefixed = createProgram({
    rootFileNames: [entry],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    options: {},
    sourceTransforms: [({ fileName, text }) => (covered.includes(resolve(fileName)) ? `// @ts-nocheck\n${text}` : null)]
  })
  assert.deepEqual(summary(programWith(new Set(['loose-lib/src/**']))), summary(prefixed))
})

test('a pattern names a package, not a path', () => {
  const compiled = programWith(new Set(['src/**']))
  for (const file of [...covered, ...uncovered]) assert.equal(errorsIn(compiled, file).length, 1, file)
  assert.throws(() => programWith(new Set(['*/src/**'])), /does not start with a package name/)
})

test('a plugin states the policy through compile --plugin', () => {
  const invoke = (flags) =>
    spawnSync(
      process.execPath,
      [
        resolve(root, 'dist/cli.js'),
        'compile',
        'entry.ts',
        '--project',
        'tsconfig.json',
        '--out-dir',
        resolve(root, 'measurements/unchecked-js'),
        ...flags
      ],
      { cwd: fixture, encoding: 'utf8', timeout: 120000 }
    )
  const reported = (result) => {
    assert.ifError(result.error)
    return (file) => result.stderr.includes(`${file}:`)
  }
  const withPlugin = reported(invoke(['--plugin', './unchecked-plugin.mjs']))
  for (const file of covered) assert.ok(!withPlugin(file), file)
  for (const file of uncovered) assert.ok(withPlugin(file), file)
  const withoutPlugin = reported(invoke([]))
  for (const file of [...covered, ...uncovered]) assert.ok(withoutPlugin(file), file)
})
