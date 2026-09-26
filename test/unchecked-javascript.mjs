import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { createProgram } from '../dist/semantics/program.js'

// `PluginCapabilities.uncheckedJavaScript`: package file globs whose JavaScript
// reports no checker diagnostics, as `// @ts-nocheck` would, with the source
// left as written. Every JS file the entry imports has one JSDoc type error;
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

// `contradicted-jsdoc-types.ts`: in an unchecked file, a field `@type` that a
// value the program constructs and stores there contradicts is blanked before
// the checker the compilation keeps reads it; every other tag stays as written.
// `groups.js` has one of each kind; the checked copy in `strict-lib` keeps all.
const groups = (library) => resolve(fixture, `vendor/${library}/src/groups.js`)
const groupsProgram = () =>
  createProgram({
    rootFileNames: [groups('loose-lib'), groups('strict-lib')],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    options: {},
    uncheckedJavaScript: new Set(['loose-lib/src/**'])
  })

test('a field tag a constructed store contradicts is blanked in place, and no other tag is', () => {
  const compiled = groupsProgram()
  const onDisk = readFileSync(groups('loose-lib'), 'utf8')
  const compiledText = compiled.program.getSourceFile(groups('loose-lib'))?.text ?? ''
  assert.equal(compiledText.length, onDisk.length)
  const contradicted = '@type {Object<string,Object<string,Group>>}'
  const at = onDisk.indexOf(contradicted)
  assert.equal(compiledText.slice(at, at + contradicted.length), ' '.repeat(contradicted.length))
  // `this.current = null` under `@type {Group}` is the absence pass's, below.
  const restored = compiledText.slice(0, at) + contradicted + compiledText.slice(at + contradicted.length)
  assert.equal(restored.replace('@type{?Group}', '@type {Group}'), onDisk)
  // The checker the compilation keeps no longer reads a dictionary of groups
  // out of `byName[ name ]`.
  const read = compiled.program.getSourceFile(groups('loose-lib'))
  const initializer = read.statements
    .flatMap((statement) => (ts.isClassDeclaration(statement) ? [...statement.members] : []))
    .flatMap((member) => (ts.isMethodDeclaration(member) ? [...(member.body?.statements ?? [])] : []))
    .find(ts.isVariableStatement).declarationList.declarations[0].initializer
  assert.doesNotMatch(compiled.checker.typeToString(compiled.checker.getTypeAtLocation(initializer)), /\[x: string\]/)
})

test('a checked file keeps a contradicted tag, and reports it', () => {
  const compiled = groupsProgram()
  assert.equal(compiled.program.getSourceFile(groups('strict-lib'))?.text, readFileSync(groups('strict-lib'), 'utf8'))
  assert.ok(errorsIn(compiled, groups('strict-lib')).length > 0)
})

// `absent-jsdoc-tags.ts`: in an unchecked file, a tag that leaves `null` out of
// storage the program writes a literal `null` into is widened in place, `{T}`
// to `{?T}`, taking the space before the brace. `absent.js` has one of each
// kind (a `null` argument, a `null` default, a `null` store, a `return null`)
// beside tags the program never writes `null` into, or that already admit it.
const absent = (library) => resolve(fixture, `vendor/${library}/src/absent.js`)
const absentProgram = () =>
  createProgram({
    rootFileNames: [absent('loose-lib'), absent('strict-lib')],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    options: {},
    uncheckedJavaScript: new Set(['loose-lib/src/**'])
  })

test('a tag the program writes a literal null past is widened in place, and no other tag is', () => {
  const compiled = absentProgram()
  const onDisk = readFileSync(absent('loose-lib'), 'utf8')
  const compiledText = compiled.program.getSourceFile(absent('loose-lib'))?.text ?? ''
  assert.equal(compiledText.length, onDisk.length)
  const widened = [
    ['@param {string} name', '@param{?string} name'],
    ['@param {Set<string>} [seen=null]', '@param{?Set<string>} [seen=null]'],
    ['@type {string} */\n    this.uuid', '@type{?string} */\n    this.uuid'],
    ['@return {string} */\n  ternary', '@return{?string} */\n  ternary']
  ]
  let expected = onDisk
  for (const [before, after] of widened) {
    assert.ok(expected.includes(before), before)
    expected = expected.replace(before, after)
  }
  assert.equal(compiledText, expected)
  const file = compiled.program.getSourceFile(absent('loose-lib'))
  const attribute = file.statements.find(ts.isClassDeclaration)
  const ternary = attribute.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'ternary')
  assert.equal(compiled.checker.typeToString(compiled.checker.getSignatureFromDeclaration(ternary).getReturnType()), 'string | null')
})

test('a checked file keeps a tag that leaves null out, and reports the null', () => {
  const compiled = absentProgram()
  assert.equal(compiled.program.getSourceFile(absent('strict-lib'))?.text, readFileSync(absent('strict-lib'), 'utf8'))
  assert.ok(errorsIn(compiled, absent('strict-lib')).length > 0)
})

// `contradicted-jsdoc-parameters.ts`: in an unchecked file, a `@param` tag
// that an argument at a resolved call contradicts is blanked -- the whole tag,
// so the parameter is untagged -- and every other tag stays. `params.js`
// passes a `Uniform` where the tag states a `Node` (another class, however
// alike), a number where it states a number, a `string` where it states two
// string literals (a precision of the same domain, not a contradiction), and
// a `Stack`'s `this` where the tag states its base `Shape`.
const params = (library) => resolve(fixture, `vendor/${library}/src/params.js`)
const paramsProgram = () =>
  createProgram({
    rootFileNames: [params('loose-lib'), params('strict-lib')],
    projectFileName: resolve(fixture, 'tsconfig.json'),
    options: {},
    uncheckedJavaScript: new Set(['loose-lib/src/**'])
  })

test('a parameter tag a call contradicts is blanked in place, and no other tag is', () => {
  const compiled = paramsProgram()
  const onDisk = readFileSync(params('loose-lib'), 'utf8')
  const compiledText = compiled.program.getSourceFile(params('loose-lib'))?.text ?? ''
  const at = onDisk.indexOf('@param {Node} node')
  const next = onDisk.indexOf('@param {number} hash')
  assert.equal(compiledText.length, onDisk.length)
  assert.equal(compiledText.slice(at, next), onDisk.slice(at, next).replace(/[^\n\r]/g, ' '))
  assert.equal(compiledText.slice(0, at) + onDisk.slice(at, next) + compiledText.slice(next), onDisk)
  // A subclass passing `this` to its base's method is its base.
  assert.ok(compiledText.includes('@param {?(string|Shape)} [output=null]'))
})

test('a checked file keeps a parameter tag a call contradicts, and reports it', () => {
  const compiled = paramsProgram()
  assert.equal(compiled.program.getSourceFile(params('strict-lib'))?.text, readFileSync(params('strict-lib'), 'utf8'))
  assert.ok(errorsIn(compiled, params('strict-lib')).length > 0)
})
