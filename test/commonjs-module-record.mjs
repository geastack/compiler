import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'
import { noPluginCapabilities } from '../dist/plugins/model.js'
import { createCommonJsWrapperIdentity } from '../dist/semantics/commonjs-wrapper.js'
import { cxx } from '../scripts/cxx.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = (name) => resolve(root, 'test/fixtures/commonjs-module-record', name)
const nodeModuleDeclarations = resolve(root, 'node_modules/@types/node/module.d.ts')

const commonJsGlobals = () =>
  new Map(
    ['require', 'exports', 'module'].map((name) => [
      name,
      {
        global: name,
        declarationName: name,
        declarationFileName: fixture('host-wrapper.d.ts'),
        compatibleDeclarations: [{ declarationName: name, declarationFileName: nodeModuleDeclarations }]
      }
    ])
  )

// This fixture host states only wrapper authentication. The module-record
// behavior is compiler-owned; a host does not install an implementation or a
// manifest capability for it.
const commonJsHost = () => ({
  name: 'commonjs-test-host',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      commonJsGlobals: commonJsGlobals()
    }
  })
})

const hostWrapper = `
export {}
declare global {
  var require: (specifier: string) => any
  var exports: any
  var module: { exports: any }
}
`

const positiveRequireFixtures = [
  'require-alias-stable.ts',
  'require-bind-safe-callbacks-remain-static.ts',
  'require-safe-callbacks-remain-static.ts'
]

const negativeRequireFixtures = [
  { name: 'require-array-destructure-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-apply-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-bind-escape-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-bind-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-call-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-callable-alias-shadow-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-callable-destructure-shadow-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-container-escape-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-default-destructure-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-destructured-apply-global-taint-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-destructured-bind-global-taint-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-destructured-call-global-taint-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-extracted-apply-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-extracted-bind-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-extracted-call-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-factory-return-escape-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-alias-write-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-apply-define-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-assign-accessor-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-bind-delete-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-call-write-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-computed-write-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-function-prototype-define-properties-accessor-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-invocation-cycle-known-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-mutable-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-mutual-invocation-cycle-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-mutated-container-direct-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-mutated-container-escape-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-nested-destructure-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-object-destructure-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-ordinary-apply-method-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-ordinary-bind-method-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-ordinary-call-method-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-pattern-write-must-refuse.ts', accepted: 0, refused: 2 },
  { name: 'require-reassigned-must-refuse.ts', accepted: 1, refused: 1 },
  { name: 'require-rest-destructure-alias-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-shadowed-function-call-writer-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-shorthand-assignment-write-must-refuse.ts', accepted: 0, refused: 1 },
  { name: 'require-self-invocation-cycle-must-refuse.ts', accepted: 0, refused: 1 }
]

const files = {
  'host-wrapper.d.ts': hostWrapper,
  'entry.ts': `
const cacheOne = require('./cache')
const cacheTwo = require('./cache')
if (cacheOne !== cacheTwo || cacheOne.token !== cacheTwo.token) throw new Error('CommonJS cache identity')

const load = require
const aliasCache = load('./cache')
if (aliasCache !== cacheOne) throw new Error('CommonJS alias require owner')

function genericLoad<T>(value: T) { return require('./cache') }
if (genericLoad(1) !== cacheOne || genericLoad('two') !== cacheOne) throw new Error('CommonJS specialization ownership')

const cycleA = require('./cycle-a')
const cycleB = require('./cycle-b')
if (cycleA.observed !== 'b' || cycleB.observed !== 'a') throw new Error('CommonJS partial cycle exports')

const replacement = require('./replacement')
if (replacement.after !== 2 || replacement.before !== undefined || replacement.late !== undefined || replacement.lexical !== undefined)
  throw new Error('CommonJS exports alias')

const descriptor = require('./descriptor')
if (descriptor.direct !== 1 || descriptor.computed !== 2 || descriptor.deleted !== undefined || descriptor.described !== 4)
  throw new Error('CommonJS module.exports property cell')

const selfRecord = require('./self')
if (selfRecord.partial !== 'seed' || selfRecord.done !== true) throw new Error('CommonJS self require')

const strictDelete = require('./strict-delete-module-exports')
if (!strictDelete.threw || strictDelete.locked !== true) throw new Error('CommonJS strict module.exports delete')

const loaderSnapshot = require
require = (specifier) => ({ replacement: specifier })
const snapshotted = loaderSnapshot('./cache')
if (snapshotted !== cacheOne) throw new Error('CommonJS require snapshot')
`,
  'cache.ts': `
export {}
module.exports = { token: {} }
`,
  'cycle-a.ts': `
export {}
exports.name = 'a'
const peer = require('./cycle-b')
exports.observed = peer.name
`,
  'cycle-b.ts': `
export {}
exports.name = 'b'
const peer = require('./cycle-a')
exports.observed = peer.name
`,
  'replacement.ts': `
export {}
exports.before = 1
module.exports = { after: 2 }
exports.late = 3
exports = { lexical: 4 }
;({ exports } = { exports: { destructured: 5 } })
;[exports] = [{ arrayDestructured: 6 }]
for (exports of [{ loopAssigned: 7 }]) break
`,
  'descriptor.ts': `
export {}
module.exports = { direct: 1 }
const direct = module.exports.direct
module['exports'] = { computed: 2 }
const computed = module.exports.computed
delete module['exports']
const deleted = module.exports
Object.defineProperty(module, 'exports', { value: { described: 4 }, writable: true, enumerable: true, configurable: true })
module.exports = { direct, computed, deleted, described: module.exports.described }
`,
  'self.ts': `
export {}
exports.partial = 'seed'
const selfRecord = require('./self')
module.exports = { partial: selfRecord.partial, done: true }
`,
  'strict-delete-module-exports.ts': `
export {}
Object.defineProperty(module, 'exports', { value: { locked: true }, configurable: false })
let threw = false
try { delete module.exports } catch (error) { threw = error instanceof TypeError }
module.exports.threw = threw
`
}

const request = (sources = files) => ({
  rootFileNames: [
    fixture('entry.ts'),
    ...Object.keys(sources)
      .filter((name) => name.endsWith('.d.ts'))
      .map(fixture)
  ],
  projectFileName: null,
  sourceOverlay: new Map(Object.entries(sources).map(([name, text]) => [fixture(name), text])),
  plugins: [commonJsHost()]
})

const compileRequireFixture = (name) =>
  compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': readFileSync(fixture(name), 'utf8')
    })
  )

const compilePhysicalFixture = (name) =>
  compile({
    rootFileNames: [fixture(name)],
    projectFileName: null,
    javaScriptSources: true,
    plugins: [commonJsHost()]
  })

const compileAndRun = (result, binaryName) => {
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
  const binary = resolve(root, 'measurements', binaryName)
  execFileSync(
    cxx,
    ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { try { __gea_top_level(); } catch (...) { return 1; } }\n`,
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  execFileSync(binary, { stdio: ['ignore', 'pipe', 'inherit'] })
}

const staticRequiresOf = (result) =>
  [...result.graph.operations.values()].filter((operation) => operation.family === 'invocation' && operation.commonJsRequire !== undefined)

const reassignmentDiagnosticsOf = (result) =>
  result.diagnostics.diagnostics.filter((diagnostic) =>
    diagnostic.message.includes('CommonJS require may have been reassigned before this call')
  )

test('every physical require fixture has an explicit CommonJS soundness expectation', () => {
  const physical = readdirSync(resolve(root, 'test/fixtures/commonjs-module-record'))
    .filter((name) => /^require-.*\.ts$/.test(name))
    .sort()
  assert.deepEqual([...positiveRequireFixtures, ...negativeRequireFixtures.map(({ name }) => name)].sort(), physical)
})

for (const name of positiveRequireFixtures) {
  test(`${name} preserves static CommonJS dispatch`, () => {
    const result = compileRequireFixture(name)
    assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
    assert.equal(staticRequiresOf(result).length, 1)
    assert.equal(reassignmentDiagnosticsOf(result).length, 0)
  })
}

for (const { name, accepted, refused } of negativeRequireFixtures) {
  test(`${name} refuses possibly reassigned CommonJS dispatch`, () => {
    const result = compileRequireFixture(name)
    assert.equal(result.source, null)
    assert.equal(staticRequiresOf(result).length, accepted, 'unexpected number of accepted static require calls')
    assert.equal(reassignmentDiagnosticsOf(result).length, refused, 'unexpected number of refused reassigned require calls')
  })
}

test('cyclic Function.prototype receiver resolution terminates and fails closed', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
let recursive = () => undefined
recursive = recursive.call(null)
recursive.call(null)
require('./cache')
function replaceLoader() { require = (specifier: string) => ({ specifier }) }
`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  assert.equal(result.source, null)
  assert.equal(staticRequiresOf(result).length, 0)
  assert.equal(reassignmentDiagnosticsOf(result).length, 1)
})

test('wrapper var redeclarations directly retain require, exports, and module identity', () => {
  for (const name of ['wrapper-var-redeclarations.ts', 'wrapper-var-redeclarations.cjs']) {
    const fileName = fixture(name)
    const program = ts.createProgram({
      rootNames: [fileName, fixture('host-wrapper.d.ts')],
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        types: ['node']
      }
    })
    const sourceFile = program.getSourceFile(fileName)
    assert.ok(sourceFile, name)
    const identity = createCommonJsWrapperIdentity(program.getTypeChecker(), program.getSourceFiles(), commonJsGlobals())
    const authenticated = new Set()
    const visit = (node) => {
      if (ts.isVariableDeclaration(node)) {
        const bind = (binding) => {
          if (ts.isIdentifier(binding)) {
            const classified = identity.classify(binding)
            if (classified.kind === 'wrapper') authenticated.add(`${binding.text}:${classified.global}`)
            return
          }
          for (const element of binding.elements) if (!ts.isOmittedExpression(element)) bind(element.name)
        }
        bind(node.name)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    assert.deepEqual([...authenticated].sort(), ['exports:exports', 'module:module', 'require:require'], name)

    const result = compilePhysicalFixture(name)
    assert.equal(staticRequiresOf(result).length, 1, name)
    assert.equal(reassignmentDiagnosticsOf(result).length, 0, name)
  }
})

test('ESM source files never authenticate authored require redeclarations as a CommonJS wrapper', () => {
  for (const name of ['esm-local-wrapper.mjs', 'esm-package/local-wrapper.js']) {
    const result = compilePhysicalFixture(name)
    assert.equal(staticRequiresOf(result).length, 0, name)
  }
})

test('a physical CommonJS JavaScript Fastify require keeps exact host provenance end to end', () => {
  const result = compilePhysicalFixture('fastify-js/index.js')
  assert.equal(staticRequiresOf(result).length, 1)
  assert.doesNotMatch(JSON.stringify(result.manifest), /Require@1/)
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
})

test('authenticated callable and constructor exports emit matching native records and run without boxing', () => {
  const result = compilePhysicalFixture('record-native-runtime.js')
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const requireResults = staticRequiresOf(result)
  assert.equal(requireResults.length, 4)
  for (const operation of requireResults) {
    assert.equal(operation.commonJsRequire.nativeRecord, true)
    const value = operation.results.find((result) => result.role === 'value')
    assert.ok(value)
    assert.notEqual(result.representations.plan.selected.get(value.id)?.kind, 'dynamic')
  }
  const moduleBindings = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'binding' && operation.commonJs?.global === 'module'
  )
  const nativeModuleBindings = moduleBindings.filter((binding) => binding.commonJs.nativeRecord === true)
  assert.equal(nativeModuleBindings.length, 2)
  for (const binding of nativeModuleBindings) {
    const value = binding.results.find((result) => result.role === 'value')
    assert.ok(value)
    const representation = result.representations.plan.selected.get(value.id)
    assert.equal(representation?.kind, 'record')
    assert.equal(representation.ownership, 'shared-refcount')
    assert.deepEqual(
      representation.fields.map((field) => field.key),
      ['exports']
    )
  }
  assert.match(result.source, /enum class Phase \{ fresh, loading, loaded \}/)
  assert.match(result.source, /inline gea::Ref<gea_record_[^(]+> gea_commonjs_record_/)
  assert.match(result.source, /inline (?!gea::Value)[^\n]+ gea_commonjs_module_/)
  assert.doesNotMatch(result.source, /gea::CallableObject<[^;]+> [^=]+ = gea::Value/)

  compileAndRun(result, 'commonjs-native-module-record')
})

test('multiple CommonJS exports writers retain the dynamic record boundary', () => {
  const result = compilePhysicalFixture('record-ambiguous-require.js')
  const operation = staticRequiresOf(result)[0]
  assert.ok(operation)
  const value = operation.results.find((result) => result.role === 'value')
  assert.ok(value)
  const shape = result.graph.structuralTypes.get(value.type)?.shape
  assert.equal(shape?.kind, 'primitive')
  assert.equal(shape.primitive, 'any')
})

for (const name of [
  'record-early-read-export.js',
  'record-alias-writer-export.js',
  'record-compound-writer-export.js',
  'record-define-property-export.js',
  'record-nested-writer-export.js',
  'record-cycle-early-a.js'
]) {
  test(`${name} cannot promote an ambiguous CommonJS module record`, () => {
    const result = compilePhysicalFixture(name)
    const nativeBindings = [...result.graph.operations.values()].filter(
      (operation) => operation.family === 'binding' && operation.commonJs?.nativeRecord === true
    )
    assert.deepEqual(nativeBindings, [])
  })
}

test('a require cycle reached only after assignment retains the final callable export proof', () => {
  const result = compilePhysicalFixture('record-cycle-late-a.js')
  const nativeBindings = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'binding' && operation.commonJs?.nativeRecord === true
  )
  assert.equal(nativeBindings.length, 1)
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
  assert.match(result.source, /enum class Phase \{ fresh, loading, loaded \}/)
  compileAndRun(result, 'commonjs-native-module-record-cycle')
})

test('an ambient module shape alone never promotes a CommonJS carrier', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': `
export {}
declare global {
  function ambientExport(value: number): number
  var require: (specifier: string) => any
  var exports: any
  var module: { exports: typeof ambientExport }
}
`,
      'entry.ts': `const shapedOnly = module; void shapedOnly`
    })
  )
  const read = [...result.graph.operations.values()].find(
    (operation) => operation.family === 'binding' && operation.action === 'read' && operation.commonJs?.global === 'module'
  )
  assert.ok(read)
  assert.equal(read.commonJs.nativeRecord, undefined)
  const value = read.results.find((candidate) => candidate.role === 'value')
  assert.ok(value)
  assert.equal(result.representations.plan.selected.get(value.id)?.kind, 'dynamic')
})

test('exact host declarations lower CommonJS wrappers to compiler-owned module records', () => {
  const result = compile(request())
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const requires = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'invocation' && operation.commonJsRequire !== undefined
  )
  assert.ok(requires.length >= 10)
  assert.match(result.source, /gea::commonjs::evaluate/)
  assert.match(result.source, /gea::commonjs::Scope/)
  assert.match(result.source, /gea_commonjs_module_/)
  assert.doesNotMatch(result.source, /Require@1/)
  assert.doesNotMatch(JSON.stringify(result.manifest), /commonjs|Require@1/)

  const binary = resolve(root, `measurements/commonjs-module-record${executableSuffix}`)
  execFileSync(
    cxx,
    ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { try { __gea_top_level(); } catch (...) { return 1; } }\n`,
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  execFileSync(binary, { stdio: ['ignore', 'pipe', 'inherit'] })
})

// A static require's argument reaches String.prototype's component, and the
// ambient wrapper `require` states no host effect contract, so the global
// host-mutation census used to stamp `every` on the intrinsics that string
// reaches and re-run distrusting every intrinsic -- losing the
// `%TypedArray%.prototype[ Symbol.toStringTag ]` getter proof bson's
// `isUint8Array` depends on. The call is lowered to a module record with no
// operands and runs only the compiled module body, so it must not.
test('a static CommonJS require leaves the intrinsics the program relies on trusted', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
const record = require('./cache')
const tag = Object.prototype.toString.call(new Date(0))
const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
if (tag !== '[object Date]') throw new Error(tag)
if (getter.call(new Uint8Array(1)) !== 'Uint8Array') throw new Error('typed array tag')
if (record.value !== 1) throw new Error('record')
`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(staticRequiresOf(result).length, 1)
  compileAndRun(result, 'commonjs-require-intrinsics')
})

// A read of the wrapper `require` inside a function body the module never
// calls itself -- one only another module reaches, or a class method -- gets
// no entry state from the per-file reaching-definition pass. When the module
// never writes its `require` cell anywhere, that cell holds Node's loader for
// the module's whole lifetime, so those reads are static too. Before, they
// read as `ordinary`: a call of the ambient host `require`, which the global
// host-mutation census refused as a host native and answered by distrusting
// every intrinsic -- losing the typed-array tag getter proof below.
test('a require inside an uncalled function body is static when the module never writes require', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
const lib = require('./lib')
const tag = Object.prototype.toString.call(new Date(0))
const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
if (tag !== '[object Date]') throw new Error(tag)
if (getter.call(new Uint8Array(1)) !== 'Uint8Array') throw new Error('typed array tag')
if (lib.load().value !== 1 || lib.loader.get().value !== 1) throw new Error('function-body require')
`,
      'lib.ts': `
export {}
function load() { return require('./cache') }
class Loader { get() { return require('./cache') } }
module.exports = { load, loader: new Loader() }
`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.equal(staticRequiresOf(result).length, 3)
  compileAndRun(result, 'commonjs-require-function-body')
})

test('a module that writes require anywhere keeps its uncalled function-body requires off the static path', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `const lib = require('./lib'); lib.load()`,
      'lib.ts': `
export {}
function load() { return require('./cache') }
function replace() { require = (specifier: string) => ({ replaced: specifier }) }
module.exports = { load, replace }
`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  const admitted = staticRequiresOf(result).map((operation) => operation.commonJsRequire.target)
  assert.equal(admitted.length, 1, "only the entry module's require is static")
})

// Node throws a catchable `MODULE_NOT_FOUND` error for a package that is not
// installed, and optional-dependency probes (mongodb's `deps.ts`) rely on
// catching it. A compiled binary contains exactly the modules its build
// found, so a static require of a package absent from the build throws that
// same error instead of refusing the program.
// Node loads a `.json` module through the CommonJS loader: `module.exports` is
// the parsed document, so `require('./package.json').version` is the string.
// mongodb reads its own driver version this way (`client_metadata.ts`); the
// ES `export default` spelling left the required module's exports empty.
test('a static require of a JSON document answers the parsed document as module.exports', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'pkg.json': '{ "name": "demo", "version": "7.1.1", "nested": { "list": [1, 2, 3] } }',
      'entry.ts': `
const pkg = require('./pkg.json')
const again = require('./pkg.json')
if (pkg !== again) throw new Error('JSON module cache identity')
const version: string = pkg.version
if (version !== '7.1.1') throw new Error('JSON version ' + String(version))
if (pkg.nested.list[1] !== 2) throw new Error('JSON nested value')
`
    })
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  const requires = staticRequiresOf(result)
  assert.equal(requires.length, 2)
  compileAndRun(result, 'commonjs-require-json-module')
})

test('a static require of a package absent from the build throws a catchable MODULE_NOT_FOUND', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
function optional(): string {
  try {
    require('gea-definitely-absent-package/sub')
    return 'loaded'
  } catch (error) {
    const found = error as { code: string; message: string }
    return found.code + '|' + found.message
  }
}
const outcome = optional()
if (outcome !== "MODULE_NOT_FOUND|Cannot find module 'gea-definitely-absent-package/sub'") throw new Error(outcome)
const tag = Object.prototype.toString.call(new Date(0))
if (tag !== '[object Date]') throw new Error(tag)
`
    })
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  const requires = staticRequiresOf(result)
  assert.equal(requires.length, 1)
  assert.equal(requires[0].commonJsRequire.target, null)
  assert.equal(requires[0].commonJsRequire.absentPackage, 'gea-definitely-absent-package/sub')
  assert.match(result.source, /gea::commonjs::absentPackage/)
  compileAndRun(result, 'commonjs-require-absent-package')
})

// A package the build installs for its types only (an application's
// devDependency) is absent from the production install the binary stands in
// for, so its require throws MODULE_NOT_FOUND although it IS installed here --
// and its code never enters the program.
test('a static require of a types-only package throws MODULE_NOT_FOUND and compiles none of it', () => {
  const result = compile({
    ...request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
let outcome = 'loaded'
try {
  require('conditional-choice')
} catch (error) {
  outcome = (error as { code: string }).code
}
if (outcome !== 'MODULE_NOT_FOUND') throw new Error(outcome)
`
    }),
    typesOnlyPackages: new Set(['conditional-choice'])
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  const requires = staticRequiresOf(result)
  assert.equal(requires.length, 1)
  assert.equal(requires[0].commonJsRequire.target, null)
  assert.equal(requires[0].commonJsRequire.absentPackage, 'conditional-choice')
  assert.ok(![...result.sourceFileNames.values()].some((file) => file.includes('conditional-choice')))
  compileAndRun(result, 'commonjs-require-types-only-package')
})

// mongodb's `getGcpMetadata()` (src/deps.ts): the absent peer's require
// throws, so the probe's only value is its `catch` arm's stub, and a call
// typed by the peer's own declarations -- `peer.instance({ ... })` -- is made
// on that stub, not on host code. The census must not stamp `Object` or
// `Object.prototype` for it, or bson's typed-array brand check (the getter of
// `%TypedArray%.prototype[@@toStringTag]`, reached through
// `Object.getOwnPropertyDescriptor`) loses its proof.
test('an absent optional peer hands its probe no value, so a call typed by its declarations taints no intrinsic', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'peer.d.ts': `
declare module 'gea-definitely-absent-peer' {
  export function instance(options: { property: string }): Promise<{ token: string }>
}
`,
      'entry.ts': `
type Peer = typeof import('gea-definitely-absent-peer') | { kModuleError: string }
function loadPeer(): Peer {
  try {
    const peer = require('gea-definitely-absent-peer')
    return peer
  } catch {
    return { kModuleError: 'missing' }
  }
}
async function token(): Promise<string> {
  const peer = loadPeer()
  if ('kModuleError' in peer) return peer.kModuleError
  const { token } = await peer.instance({ property: 'token' })
  return token
}
const getTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
const tag = (value: unknown) => getTag.call(value)
if (tag(new Uint8Array(1)) !== 'Uint8Array' || tag([1]) !== undefined) throw new Error('typed-array brand')
token().then((value) => {
  if (value !== 'missing') throw new Error(value)
})
`
    })
  )
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  compileAndRun(result, 'commonjs-require-absent-peer-stub')
})

test('a relative require that resolves nothing stays a refusal rather than MODULE_NOT_FOUND', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `try { require('./not-here.json') } catch {}`
    })
  )
  assert.equal(result.source, null)
  assert.match(JSON.stringify(result.diagnostics), /a static CommonJS require resolved no compiled source module/)
})

// Wrapper bindings are lexical: a function body reading `exports` runs under
// its own module's record even when it is called after that module finished
// evaluating, or while a different module is evaluating.
test('a function body reads its own module record after load and during another module evaluation', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
const late = require('./late')
if (late.read() !== 5) throw new Error('after load')
const other = require('./other')
if (other.seen !== 5) throw new Error('during another module')
`,
      'late.ts': `
export {}
exports.value = 5
exports.read = function () { return exports.value }
`,
      'other.ts': `
export {}
exports.value = 9
exports.seen = require('./late').read()
`
    })
  )
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
  compileAndRun(result, 'commonjs-lexical-record')
})

test('dynamic CommonJS specifiers remain rejected instead of inventing a module record', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `const specifier = './cache'; require(specifier)`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  assert.equal(result.source, null)
  assert.match(JSON.stringify(result.diagnostics), /exactly one static string specifier/)
})

test('a direct require reached after reassignment fails closed while const snapshots remain static', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `
const snapshot = require
require = (specifier) => ({ replacement: specifier })
snapshot('./cache')
require('./cache')
`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  assert.equal(result.source, null)
  assert.match(JSON.stringify(result.diagnostics), /CommonJS require may have been reassigned before this call/)
})

test('caller ambient wrapper declarations are never authenticated by name', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'caller-ambient.d.ts': `declare var require: (specifier: string) => any`,
      'entry.ts': `const invalid = require; const value = invalid('./cache')`,
      'cache.ts': `export {}; module.exports = { value: 1 }`
    })
  )
  const requires = [...result.graph.operations.values()].filter(
    (operation) => operation.family === 'invocation' && operation.commonJsRequire !== undefined
  )
  assert.equal(requires.length, 0)
  assert.equal(result.source, null)
  assert.match(JSON.stringify(result.diagnostics), /provenance did not resolve to the host-owned wrapper declaration/)
})

test('static CommonJS require resolves package exports under the require condition', () => {
  const result = compile(
    request({
      'host-wrapper.d.ts': hostWrapper,
      'entry.ts': `const selected = require('conditional-choice'); if (selected.branch !== 'require-branch') throw new Error('require condition')`
    })
  )
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics))
  assert.match(result.source, /require-branch/)
  assert.doesNotMatch(result.source, /import-branch/)
})

test('the native module record retries failed initialization and preserves aliases and cycle state', () => {
  const binary = resolve(root, `measurements/commonjs-module-record-runtime${executableSuffix}`)
  execFileSync(
    cxx,
    ['-std=c++20', '-O0', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `
#include "gea_runtime.h"
#include <cassert>
int main() {
  gea::commonjs::ModuleRecord left;
  gea::commonjs::ModuleRecord right;
  gea::Value leftBefore;
  gea::commonjs::evaluate(left, [&] {
    leftBefore = gea::commonjs::exports();
    leftBefore.setProperty(gea::PropertyKey::string("name"), gea::Value::box(gea::Value::Tag::String, std::string("left")));
    gea::Value partial = gea::commonjs::evaluate(right, [&] {
      gea::Value peer = gea::commonjs::evaluate(left, [] {});
      assert(gea::Value::strictEquals(peer, leftBefore));
      gea::commonjs::module().setProperty(gea::PropertyKey::string("exports"), gea::Value::object());
    });
    (void)partial;
    gea::commonjs::module().setProperty(gea::PropertyKey::string("exports"), gea::Value::object());
    assert(gea::Value::strictEquals(gea::commonjs::exports(), leftBefore));
  });
  assert(left.state == gea::commonjs::ModuleRecord::State::loaded);
  assert(right.state == gea::commonjs::ModuleRecord::State::loaded);

  gea::commonjs::ModuleRecord retry;
  int attempts = 0;
  try {
    gea::commonjs::evaluate(retry, [&] { ++attempts; throw 7; });
    assert(false);
  } catch (int value) {
    assert(value == 7);
  }
  assert(retry.state == gea::commonjs::ModuleRecord::State::fresh);
  const gea::Value recovered = gea::commonjs::evaluate(retry, [&] {
    ++attempts;
    gea::commonjs::module().setProperty(gea::PropertyKey::string("exports"), gea::Value::box(gea::Value::Tag::Number, 42.0));
  });
  assert(attempts == 2);
  assert(retry.state == gea::commonjs::ModuleRecord::State::loaded);
  assert(recovered.tag() == gea::Value::Tag::Number && recovered.as<double>() == 42.0);
}
`,
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  execFileSync(binary, { stdio: ['ignore', 'pipe', 'inherit'] })
})
