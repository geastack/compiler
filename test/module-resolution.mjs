import { executableSuffix } from './executable-suffix.mjs'
import { appsRoot, nodeCompatRoot } from './corpus-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createModuleResolver, mappedTypeScriptSource } from '../dist/semantics/module-resolution.js'
import { createProgram, defaultCompilerOptions } from '../dist/semantics/program.js'
import { compile } from '../dist/compiler.js'

const compiler = resolve(import.meta.dirname, '..')
const home = resolve(compiler, 'test/fixtures/module-resolution')
const path = (file) => resolve(home, file)
const options = { ...defaultCompilerOptions, types: [] }
const json = JSON.stringify
const virtual = (files) => {
  const overlay = new Map(Object.entries(files).map(([file, text]) => [path(file), text]))
  const directories = new Set()
  for (const file of overlay.keys()) {
    for (let dir = dirname(file); !directories.has(dir); dir = dirname(dir)) {
      directories.add(dir)
      if (dir === dirname(dir)) break
    }
  }
  return {
    overlay,
    host: {
      ...ts.sys,
      fileExists: (file) => overlay.has(resolve(file)) || ts.sys.fileExists(file),
      readFile: (file) => overlay.get(resolve(file)) ?? ts.sys.readFile(file),
      directoryExists: (dir) => directories.has(resolve(dir)) || ts.sys.directoryExists(dir),
      realpath: (file) => (overlay.has(resolve(file)) ? resolve(file) : ts.sys.realpath(file))
    }
  }
}
const resolveIn = (files, specifier = 'sample', extra = {}) => {
  const { host } = virtual(files)
  return createModuleResolver(host, { ...options, ...extra.options }, extra.native, extra.packageSources).resolve(
    specifier,
    path(extra.from ?? 'main.ts'),
    extra.mode ?? ts.ModuleKind.ESNext,
    extra.stated
  )
}

test('package checkouts map sibling runtime and declaration outputs to their shared TypeScript source', () => {
  const installed = 'node_modules/sample'
  const checkout = 'checkouts/sample'
  const manifest = {
    name: 'sample',
    exports: {
      '.': { types: './dist/types/index.d.ts', import: './dist/index.js', require: './dist/cjs/index.js' },
      './feature/*': { types: './dist/types/feature/*.d.ts', import: './dist/feature/*.js' }
    }
  }
  const files = {
    [`${installed}/package.json`]: json(manifest),
    [`${installed}/dist/types/index.d.ts`]: 'export const value: number',
    [`${installed}/dist/index.js`]: 'export const value = 1',
    [`${installed}/dist/cjs/index.js`]: 'exports.value = 1',
    [`${installed}/dist/types/feature/one.d.ts`]: 'export const value: number',
    [`${installed}/dist/feature/one.js`]: 'export const value = 1',
    [`${checkout}/package.json`]: json(manifest),
    [`${checkout}/tsconfig.build.json`]: json({ compilerOptions: { rootDir: './src', outDir: './dist/types' }, include: ['src/**/*.ts'] }),
    [`${checkout}/src/index.ts`]: 'export const value: number = 1',
    [`${checkout}/src/feature/one.ts`]: 'export const value: number = 1'
  }
  const packageSources = [{ root: path(checkout), origin: path(installed) }]
  assert.equal(selected(resolveIn(files, 'sample', { packageSources })), path(`${checkout}/src/index.ts`))
  assert.equal(selected(resolveIn(files, 'sample/feature/one', { packageSources })), path(`${checkout}/src/feature/one.ts`))
})
const selected = (result) => result.implementation?.resolvedFileName

test('same-package declarations and JS are resolved independently', () => {
  const result = resolveIn({
    'node_modules/sample/package.json': json({ main: 'index.js', types: 'public.d.ts' }),
    'node_modules/sample/index.js': 'exports.value = 42',
    'node_modules/sample/public.d.ts': 'export const value: number'
  })
  assert.equal(selected(result), path('node_modules/sample/index.js'))
  assert.equal(result.declaration?.resolvedFileName, path('node_modules/sample/public.d.ts'))
})

test('DefinitelyTyped declarations do not replace the package implementation', () => {
  const result = resolveIn({
    'node_modules/sample/package.json': json({ main: 'index.js' }),
    'node_modules/sample/index.js': 'export const value = 42',
    'node_modules/@types/sample/index.d.ts': 'export const value: number'
  })
  assert.equal(selected(result), path('node_modules/sample/index.js'))
  assert.equal(result.typeDeclaration?.resolvedFileName, path('node_modules/@types/sample/index.d.ts'))
  assert.equal(result.declaration, undefined)
})

const conditional = {
  'node_modules/sample/package.json': json({
    exports: {
      '.': { types: './types/index.d.ts', import: './esm.mjs', require: './common.cjs' },
      './feature/*': { types: './types/*.d.ts', import: './esm/*.mjs', require: './common/*.cjs' },
      './private': null
    }
  }),
  'node_modules/sample/types/index.d.ts': 'export const value: number',
  'node_modules/sample/types/one.d.ts': 'export const value: number',
  'node_modules/sample/esm.mjs': 'export const value = 1',
  'node_modules/sample/common.cjs': 'exports.value = 2',
  'node_modules/sample/esm/one.mjs': 'export const value = 3',
  'node_modules/sample/common/one.cjs': 'exports.value = 4',
  'node_modules/sample/private.js': 'exports.value = 5'
}
for (const [mode, extension, stem] of [
  [ts.ModuleKind.ESNext, 'mjs', 'esm'],
  [ts.ModuleKind.CommonJS, 'cjs', 'common']
]) {
  test(`conditional exports select ${stem}, including wildcard subpaths`, () => {
    assert.equal(selected(resolveIn(conditional, 'sample', { mode })), path(`node_modules/sample/${stem}.${extension}`))
    assert.equal(selected(resolveIn(conditional, 'sample/feature/one', { mode })), path(`node_modules/sample/${stem}/one.${extension}`))
  })
}
test('exports exclusions and unexported subpaths are not bypassed', () => {
  for (const name of ['sample/private', 'sample/esm.mjs']) assert.equal(selected(resolveIn(conditional, name)), undefined)
})
test('custom conditions and their declared order survive type lookup removal', () => {
  const files = {
    ...conditional,
    'node_modules/sample/package.json': json({ exports: { types: './types/index.d.ts', custom: './common.cjs', default: './esm.mjs' } })
  }
  assert.equal(selected(resolveIn(files)), path('node_modules/sample/esm.mjs'))
  assert.equal(selected(resolveIn(files, 'sample', { options: { customConditions: ['custom'] } })), path('node_modules/sample/common.cjs'))
})
test('package imports and self references use package metadata', () => {
  const files = {
    'package.json': json({ name: 'sample', type: 'module', exports: { '.': './source.ts' }, imports: { '#inside': './inside.ts' } }),
    'source.ts': 'export const value = 1',
    'inside.ts': 'export const value = 2'
  }
  assert.equal(selected(resolveIn(files)), path('source.ts'))
  assert.equal(selected(resolveIn(files, '#inside')), path('inside.ts'))
})
test('nested installations keep their own dependency version', () => {
  const files = {
    'node_modules/sample/index.js': 'exports.version = 1',
    'node_modules/parent/node_modules/sample/index.js': 'exports.version = 2'
  }
  assert.equal(selected(resolveIn(files)), path('node_modules/sample/index.js'))
  assert.equal(
    selected(resolveIn(files, 'sample', { from: 'node_modules/parent/index.js' })),
    path('node_modules/parent/node_modules/sample/index.js')
  )
})
test('paths aliases and explicit module graph targets remain authoritative', () => {
  const files = { 'source.ts': 'export const value = 1', ...conditional }
  assert.equal(selected(resolveIn(files, 'alias', { options: { paths: { alias: [path('source.ts')] } } })), path('source.ts'))
  assert.equal(selected(resolveIn(files, 'sample', { stated: path('source.ts') })), path('source.ts'))
  const declarations = resolveIn(files, 'native', { stated: path('native.d.ts') })
  assert.equal(declarations.native, true)
  assert.equal(declarations.declaration?.resolvedFileName, path('native.d.ts'))
})
test('native registrations select declarations even when a bundler supplied JavaScript', () => {
  const result = resolveIn(conditional, 'sample', { native: new Set(['sample']), stated: path('node_modules/sample/esm.mjs') })
  assert.equal(result.native, true)
  assert.equal(result.implementation, undefined)
  assert.equal(result.declaration?.resolvedFileName, path('node_modules/sample/types/index.d.ts'))
  assert.equal(resolveIn(conditional, 'sample/feature/one', { native: new Set(['sample/*']) }).native, true)
})
test('typesVersions affects declarations without redirecting executable code', () => {
  const result = resolveIn({
    'node_modules/sample/package.json': json({ main: './index.js', types: './index.d.ts', typesVersions: { '*': { '*': ['types/*'] } } }),
    'node_modules/sample/index.js': 'export const value = 1',
    'node_modules/sample/types/index.d.ts': 'export const value: number'
  })
  assert.equal(selected(result), path('node_modules/sample/index.js'))
  assert.equal(result.declaration?.resolvedFileName, path('node_modules/sample/types/index.d.ts'))
})
for (const [source, declaration] of [
  ['entry.mjs', 'entry.d.mts'],
  ['entry.cjs', 'entry.d.cts']
]) {
  test(`${declaration} never replaces ${source}`, () => {
    const result = resolveIn({ [source]: 'export const value = 1', [declaration]: 'export const value: number' }, `./${source}`)
    assert.equal(selected(result), path(source))
    assert.equal(result.declaration?.resolvedFileName, path(declaration))
  })
}
test('resolution caches belong to each compilation', () => {
  assert.equal(selected(resolveIn({ 'node_modules/sample/index.js': 'exports.value = 1' })), path('node_modules/sample/index.js'))
  assert.equal(selected(resolveIn({ 'node_modules/sample/index.ts': 'export const value = 2' })), path('node_modules/sample/index.ts'))
})
test('source maps select only an available single TypeScript source', () => {
  const { host } = virtual({
    'dist/index.js': 'export const value = 1',
    'dist/index.js.map': json({ version: 3, sources: ['../source.ts'] }),
    'source.ts': 'export const value: number = 1'
  })
  assert.equal(mappedTypeScriptSource(path('dist/index.js'), host), path('source.ts'))
  for (const sources of [['missing.ts'], ['../source.ts', '../other.ts'], ['https://example.com/source.ts'], ['../types.d.ts']]) {
    const { host: other } = virtual({ 'dist/index.js.map': json({ version: 3, sources }), 'source.ts': '', 'types.d.ts': '' })
    assert.equal(mappedTypeScriptSource(path('dist/index.js'), other), undefined)
  }
})

const programIn = (files, extra = {}) =>
  createProgram({
    rootFileNames: [path('main.ts')],
    options,
    projectFileName: null,
    sourceOverlay: virtual(files).overlay,
    ...extra
  })
const pathMappedSourceFixture = resolve(compiler, 'test/fixtures/path-mapped-source-module')

test('an exact tsconfig source path wins over only its competing ambient module declaration', () => {
  const result = createProgram({
    rootFileNames: [join(pathMappedSourceFixture, 'main.ts')],
    options,
    projectFileName: join(pathMappedSourceFixture, 'tsconfig.json')
  })
  assert.deepEqual(result.diagnostics, [])

  const source = result.program.getSourceFile(join(pathMappedSourceFixture, 'main.ts'))
  assert.ok(source)
  let reference
  const visit = (node) => {
    if (reference === undefined && ts.isIdentifier(node) && node.text === 'EventEmitter' && ts.isNewExpression(node.parent))
      reference = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(reference)
  const local = result.checker.getSymbolAtLocation(reference)
  assert.ok(local)
  const symbol = (local.flags & ts.SymbolFlags.Alias) !== 0 ? result.checker.getAliasedSymbol(local) : local
  assert.deepEqual(
    new Set((symbol.declarations ?? []).map((declaration) => resolve(declaration.getSourceFile().fileName))),
    new Set([join(pathMappedSourceFixture, 'runtime-events.ts')])
  )

  const ambient = result.program.getSourceFile(join(pathMappedSourceFixture, 'ambient-node.d.ts'))
  assert.ok(ambient)
  assert.doesNotMatch(ambient.text, /node:events/)
  assert.match(ambient.text, /node:untouched/)
})

const pathMappedAugmentationFixture = resolve(compiler, 'test/fixtures/path-mapped-source-augmentation')

// The mirror of the test above, and the distinction it turns on: a `declare
// module` block in a file that is itself a MODULE is an augmentation, which
// TypeScript merges into the module the specifier already resolves to. It
// shadows nothing, so blanking it only deletes what the application declared --
// `notes-jsx` augments the path-mapped `@geastack/core` with the macOS shell's
// JSX tags, and every `<glass-pane>` was then reported as not existing on
// `JSX.IntrinsicElements`.
test('an exact tsconfig source path keeps the module AUGMENTATION that extends it', () => {
  const result = createProgram({
    rootFileNames: [join(pathMappedAugmentationFixture, 'main.ts')],
    options,
    projectFileName: join(pathMappedAugmentationFixture, 'tsconfig.json')
  })
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(
    result.program.getSemanticDiagnostics().map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
    []
  )

  const augmentation = result.program.getSourceFile(join(pathMappedAugmentationFixture, 'augments-tags.d.ts'))
  assert.ok(augmentation)
  assert.match(augmentation.text, /declare module 'gea:tags'/)
})

const packageFiles = {
  'package.json': json({ type: 'module' }),
  'node_modules/sample/package.json': json({ main: './index.js', types: './index.d.ts' }),
  'node_modules/sample/index.d.ts': 'export const value: number',
  'node_modules/sample/index.js': 'export const value = 42'
}
test('the program automatically admits a JS package without flags or source mappings', () => {
  const result = programIn({ ...packageFiles, 'main.ts': "import { value } from 'sample'; console.log(value)" })
  assert.deepEqual(
    result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    []
  )
  assert.ok(result.sourceFiles.some((file) => file.fileName === path('node_modules/sample/index.js')))
})
test('the program loads transitive literal require dependencies', () => {
  const result = programIn(
    {
      ...packageFiles,
      'main.ts': "import { value } from 'sample'; console.log(value)",
      'node_modules/sample/index.js': "exports.value = require('nested').value",
      'node_modules/sample/node_modules/nested/index.js': 'exports.value = 7'
    },
    { dynamicFallback: true }
  )
  assert.ok(result.sourceFiles.some((file) => file.fileName === path('node_modules/sample/node_modules/nested/index.js')))
})
test('the program distinguishes require and import conditions in one graph', () => {
  const result = programIn({
    ...conditional,
    'main.ts': "import { value } from 'sample'; import './consumer.cjs'; console.log(value)",
    'consumer.cjs': "exports.value = require('sample').value"
  })
  const files = new Set(result.sourceFiles.map((file) => file.fileName))
  assert.ok(files.has(path('node_modules/sample/esm.mjs')))
  assert.ok(files.has(path('node_modules/sample/common.cjs')))
})
test('the program uses source map provenance without requiring caller paths', () => {
  const result = programIn({
    ...packageFiles,
    'main.ts': "import { value } from 'sample'; console.log(value)",
    'node_modules/sample/index.js.map': json({ version: 3, sources: ['./source.ts'] }),
    'node_modules/sample/source.ts': 'export const value: number = 42'
  })
  assert.ok(result.sourceFiles.some((file) => file.fileName === path('node_modules/sample/source.ts')))
  assert.ok(!result.sourceFiles.some((file) => file.fileName === path('node_modules/sample/index.js')))
})
test('missing implementation is a resolution error, while type-only imports remain legal', () => {
  const files = { 'node_modules/sample/index.d.ts': 'export interface Shape { value: number }; export const value: number' }
  for (const source of ["import { value } from 'sample'; console.log(value)", "import 'sample'"]) {
    const result = programIn({ ...files, 'main.ts': source })
    assert.ok(result.diagnostics.some((d) => d.code === 95001))
  }
  for (const source of [
    "import type { Shape } from 'sample'; export const value: Shape = { value: 1 }",
    "import { Shape } from 'sample'; export const value: Shape = { value: 1 }",
    "import { type Shape } from 'sample'; export const value: Shape = { value: 1 }"
  ]) {
    const result = programIn({ ...files, 'main.ts': source })
    assert.deepEqual(result.diagnostics, [])
  }
})
test('type-only imports preserve interfaces absent from the JavaScript implementation', () => {
  const result = programIn({
    ...packageFiles,
    'node_modules/sample/index.d.ts': 'export interface Shape { value: number }; export const value: number',
    'main.ts': "import type { Shape } from 'sample'; const value: Shape = { value: 1 }; console.log(value.value)"
  })
  assert.deepEqual(result.diagnostics, [])
})
test('explicit source mappings also preserve class identity in type-only imports', () => {
  const result = programIn(
    {
      ...packageFiles,
      'main.ts': "import type { Widget } from 'sample'; export const value: Widget = {}",
      'node_modules/sample/index.js': 'export class Widget {}',
      'node_modules/sample/index.d.ts': 'export class Widget {}'
    },
    { moduleResolution: new Map([[path('main.ts'), new Map([['sample', path('node_modules/sample/index.js')]])]]) }
  )
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.sourceFiles.some((file) => file.fileName === path('node_modules/sample/index.js')))
})
test('the Apple plugin explicitly registers its native package', () => {
  const entry = resolve(compiler, 'test/runtime/module-resolution-apple.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    sourceOverlay: new Map([[entry, "import { NSView } from '@geastack/apple/AppKit'; export const view = new NSView()"]])
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics.filter((d) => d.severity === 'root')))
  assert.ok(![...result.sourceFileNames.values()].some((file) => file.endsWith('/runtime/AppKit.js')))
})
test('an automatically loaded package compiles, links, and executes native C++', () => {
  const result = compile({
    rootFileNames: [path('main.ts')],
    projectFileName: null,
    plugins: [],
    sourceOverlay: virtual({ ...packageFiles, 'main.ts': "import { value } from 'sample'; console.log(value + 1)" }).overlay
  })
  assert.ok(result.source, JSON.stringify(result.diagnostics.diagnostics.filter((d) => d.severity === 'root')))
  assert.ok(result.certificate)
  assert.deepEqual(result.emissionRefusals, [])
  const binary = resolve(compiler, `measurements/module-resolution${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', `-I${resolve(compiler, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary], {
    input: `${result.source}\nint main() { __gea_top_level(); }\n`
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), '43')
})
test('resolved declarations supply primitive parameter types to the JavaScript implementation', () => {
  const entry = resolve(compiler, 'test/fixtures/module-resolution-consumer.ts')
  const result = compile({
    rootFileNames: [entry],
    projectFileName: null,
    plugins: [],
    sourceOverlay: new Map([[entry, "import { increment } from './module-resolution-library.js'; console.log(increment(41))"]])
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics.filter((d) => d.severity === 'root')))
  assert.ok(result.source)
  assert.doesNotMatch(result.source, /gea_cpp_value|gea::Value/)
})

// Real installed packages, from corpus checkouts this repo does not own. See
// test/corpus-roots.mjs: the location is supplied, and a test whose corpus is
// absent skips instead of failing.
const nodeCompat = nodeCompatRoot()
const apps = appsRoot()
const installed = [
  ['fastify', nodeCompat && join(nodeCompat, 'apps/fastify-hello/server.ts'), /\/fastify\/fastify\.js$/],
  ['hono', nodeCompat && join(nodeCompat, 'apps/hono-hello/server.ts'), /\/hono\/dist\/index\.js$/],
  ['hono/tiny', nodeCompat && join(nodeCompat, 'apps/hono-hello/server.ts'), /\/hono\/dist\/preset\/tiny\.js$/],
  ['mongodb', nodeCompat && join(nodeCompat, 'apps/hono-mongodb-todo/server.ts'), /\/mongodb\/(lib\/index\.js|src\/index\.ts)$/],
  ['bson', nodeCompat && join(nodeCompat, 'apps/hono-mongodb-todo/server.ts'), /\/bson\/lib\/bson\.node\.mjs$/],
  ['three', apps && join(apps, 'apps/three-angle-metal/index.tsx'), /\/three\/build\/three\.module\.js$/],
  ['three/src/math/Vector3.js', apps && join(apps, 'apps/three-angle-metal/index.tsx'), /\/three\/src\/math\/Vector3\.js$/]
]
for (const [specifier, entry, expected] of installed) {
  test(`installed ${specifier}: actual implementation resolves without package-specific mappings`, { skip: entry ? false : 'corpus checkout not configured (GEA_APPS_ROOT / GEA_NODE_COMPAT_ROOT)' }, () => {
    const file = resolve(compiler, entry)
    assert.ok(existsSync(file), `Required installed-package test entry is missing: ${file}`)
    const result = createModuleResolver(ts.sys, options).resolve(specifier, file, ts.ModuleKind.ESNext)
    assert.match(selected(result) ?? '', expected)
  })
}
for (const [specifier, entry, expected] of installed.filter(([specifier]) => ['fastify', 'hono', 'mongodb', 'three'].includes(specifier))) {
  test(`installed ${specifier}: application loading traverses the implementation graph`, (context) => {
    const root = resolve(compiler, entry)
    const result = createProgram({
      rootFileNames: [root],
      options,
      projectFileName: null,
      dynamicFallback: true,
      sourceOverlay: new Map([[root, `import * as library from '${specifier}'; console.log(library)`]])
    })
    assert.ok(
      result.sourceFiles.some((file) => expected.test(file.fileName)),
      `Missing ${specifier} implementation`
    )
    const js = result.sourceFiles.filter((file) => /\.(?:js|mjs|cjs)$/.test(file.fileName)).length
    assert.ok(js > 0)
    context.diagnostic(
      `${js} JavaScript implementation files loaded; ${result.diagnostics.length} checker diagnostics (not an end-to-end compilation pass)`
    )
  })
}
