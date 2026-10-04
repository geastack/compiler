import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { createProgram } from '../dist/semantics/program.js'
import { cxx } from '../scripts/cxx.mjs'

// A scoped `ambientTypeRealizations` row: inside `node-lib/src/**`, a JSDoc
// `Node` the file does not import names node-lib's own class, as three's
// `NodeFrame.js` means it to. `Frame.js` keys a `WeakMap<Node, number>` by it
// and imports nothing; `extra/dom.js` is outside the scope; `probe.ts` is
// TypeScript; `own-node.js` declares its own `Node`; `value-use.js` also uses
// `Node` as a value.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'test/fixtures/scoped-type-realization')
const at = (file) => resolve(fixture, file)
const nodeClass = at('vendor/node-lib/src/core/Node.js')
const frame = at('vendor/node-lib/src/core/Frame.js')
const valueUse = at('vendor/node-lib/src/probe/value-use.js')
const ownNode = at('vendor/node-lib/src/probe/own-node.js')
const dom = at('vendor/node-lib/extra/dom.js')
const probe = at('probe.ts')
const realizeNode = { name: 'Node', type: 'default', importedFrom: 'node-lib/src/core/Node.js', within: new Set(['node-lib/src/**']) }

const programWith = (scopedTypeRealizations) =>
  createProgram({
    rootFileNames: [at('entry.ts'), probe, valueUse, ownNode, dom],
    projectFileName: at('tsconfig.json'),
    options: {},
    ...(scopedTypeRealizations ? { scopedTypeRealizations } : {})
  })

const find = (node, predicate) => (predicate(node) ? node : ts.forEachChild(node, (child) => find(child, predicate)))

/** The file declaring the type of the first parameter named `node` in `file`. */
const parameterTypeFile = (compiled, file) => {
  const source = compiled.program.getSourceFile(file)
  const parameter = find(source, (node) => ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'node')
  const declaration = compiled.checker.getTypeAtLocation(parameter).getSymbol()?.declarations?.[0]
  return declaration ? resolve(declaration.getSourceFile().fileName) : null
}
const isLibDom = (file) => file !== null && /lib\.dom\.d\.ts$/.test(file)

test('without the row, an unimported JSDoc Node is lib.dom Node everywhere', () => {
  const compiled = programWith(null)
  for (const file of [frame, valueUse, dom, probe]) assert.ok(isLibDom(parameterTypeFile(compiled, file)), file)
})

test('inside the scope it is the package class; outside, in TypeScript and where declared, it is not', () => {
  const compiled = programWith([realizeNode])
  assert.equal(parameterTypeFile(compiled, frame), nodeClass)
  assert.equal(parameterTypeFile(compiled, valueUse), nodeClass)
  assert.ok(isLibDom(parameterTypeFile(compiled, dom)), 'outside the scope')
  assert.ok(isLibDom(parameterTypeFile(compiled, probe)), 'a TypeScript file')
  assert.equal(parameterTypeFile(compiled, ownNode), ownNode)

  // The WeakMap's key type is the class too.
  const source = compiled.program.getSourceFile(frame)
  const visits = find(source, (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'visits')
  const [key] = compiled.checker.getTypeArguments(compiled.checker.getTypeAtLocation(visits))
  assert.equal(resolve(key.getSymbol().declarations[0].getSourceFile().fileName), nodeClass)

  // Types only: `instanceof Node` still reads the global value.
  const value = compiled.program.getSourceFile(valueUse)
  const instanceOf = find(value, (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
  assert.ok(isLibDom(resolve(compiled.checker.getSymbolAtLocation(instanceOf.right).declarations[0].getSourceFile().fileName)))

  // Nothing was written into the file and it imports nothing it did not.
  assert.equal(source.text, readFileSync(frame, 'utf8'))
  assert.deepEqual(source.imports, [])
  assert.deepEqual(compiled.diagnostics, [])
})

// The CommonJS require census types every assignment's value while it decides
// which `require` calls are static, and it runs on each program the build
// makes before keeping one. The checker caches a JSDoc type reference the
// first time it resolves one, so a census that ran before the row was installed
// pinned `Frame.js`'s `WeakMap<Node, number>` to lib.dom for good.
test('the row holds when the CommonJS require census asks the checker first', () => {
  const wrapper = at('commonjs-wrapper.d.ts')
  const commonJsGlobals = new Map(
    ['require', 'exports', 'module'].map((name) => [name, { global: name, declarationName: name, declarationFileName: wrapper }])
  )
  const compiled = createProgram({
    rootFileNames: [at('entry.ts'), probe, valueUse, ownNode, dom],
    projectFileName: at('tsconfig.json'),
    options: {},
    commonJsGlobals,
    scopedTypeRealizations: [realizeNode]
  })
  assert.equal(parameterTypeFile(compiled, frame), nodeClass)
  const source = compiled.program.getSourceFile(frame)
  const visits = find(source, (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'visits')
  const [key] = compiled.checker.getTypeArguments(compiled.checker.getTypeAtLocation(visits))
  assert.equal(resolve(key.getSymbol().declarations[0].getSourceFile().fileName), nodeClass)
})

test('a row that cannot be realized is an error, not lib.dom', () => {
  assert.throws(() => programWith([{ ...realizeNode, type: 'Missing' }]), /exports no 'Missing'/)
  assert.throws(() => programWith([{ ...realizeNode, importedFrom: 'node-lib/src/core/Absent.js' }]), /does not resolve/)
  assert.throws(
    () => programWith([realizeNode, { ...realizeNode, within: new Set(['node-lib/src/core/*.js']) }]),
    /two scoped realizations of 'Node'/
  )
})

const output = resolve(root, 'measurements/scoped-type-realization')
const invoke = (flags) =>
  spawnSync(
    process.execPath,
    [resolve(root, 'dist/cli.js'), 'compile', 'entry.ts', '--project', 'tsconfig.json', '--out-dir', output, ...flags],
    { cwd: fixture, encoding: 'utf8', timeout: 120000 }
  )

test('a plugin states the row through compile --plugin, and the WeakMap keyed by Node certifies and runs', () => {
  const refused = invoke([])
  assert.ifError(refused.error)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /weak-map key .*has no reference identity/)

  const compiled = invoke(['--plugin', './realize-plugin.mjs'])
  assert.ifError(compiled.error)
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`)
  const sources = readFileSync(resolve(output, 'geatsc-sources.txt'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(output, file))
  // The entry point `scripts/run-emitted.mjs` links every emitted program with.
  const main = resolve(output, 'main_shim.cpp')
  writeFileSync(main, 'extern void __gea_top_level();\nint main() { __gea_top_level(); return 0; }\n')
  const binary = resolve(output, `scoped-type-realization${executableSuffix}`)
  const built = spawnSync(cxx, ['-std=c++20', '-O0', `-I${output}`, ...sources, main, '-o', binary], { encoding: 'utf8', timeout: 180000 })
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`)
  const ran = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 })
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(ran.stdout.trim(), '103 203 105')
})
