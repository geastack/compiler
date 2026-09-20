import test from 'node:test'
import { nodeCompatRoot } from './corpus-roots.mjs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { resolve, dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { discoverNodeProject, startEntry } from '../dist/semantics/node-project.js'
import { createModuleResolver } from '../dist/semantics/module-resolution.js'
import { sourceIdentity } from '../dist/project-preparation.js'
import { defaultCompilerOptions } from '../dist/semantics/program.js'
const compiler = resolve(import.meta.dirname, '..')
const root = resolve(compiler, 'test/fixtures/project-discovery')
const virtual = (files) => {
  const data = new Map(
    Object.entries(files).map(([file, value]) => [resolve(root, file), typeof value === 'string' ? value : JSON.stringify(value)])
  )
  const dirs = new Set()
  for (const file of data.keys()) for (let dir = dirname(file); !dirs.has(dir); dir = dirname(dir)) dirs.add(dir)
  return {
    ...ts.sys,
    fileExists: (file) => data.has(resolve(file)),
    readFile: (file) => data.get(resolve(file)),
    directoryExists: (dir) => dirs.has(resolve(dir)),
    realpath: (file) => resolve(file),
    readDirectory: (dir, extensions) =>
      [...data.keys()].filter((file) => file.startsWith(`${resolve(dir)}/`) && extensions.some((ext) => file.endsWith(ext)))
  }
}
const options = { ...defaultCompilerOptions, types: [] }
const implementation = (files, specifier = 'sample', packages = [], from = 'app/main.ts', mode = ts.ModuleKind.ESNext) =>
  createModuleResolver(
    virtual(files),
    options,
    new Set(),
    packages.map((entry) => ({ root: resolve(root, entry.root), ...(entry.origin ? { origin: resolve(root, entry.origin) } : {}) }))
  ).resolve(specifier, resolve(root, from), mode).implementation?.resolvedFileName

test('launch discovery handles literal Node commands and script references without running shell code', () => {
  assert.equal(startEntry('NODE_ENV=production node --import tsx "src/server main.ts"', {}), 'src/server main.ts')
  assert.equal(startEntry('npm run serve', { serve: 'node --conditions=production dist/server.js' }), 'dist/server.js')
  assert.equal(startEntry('npm run loop', { loop: 'npm run loop' }), undefined)
  for (const command of ['node -e "console.log(1)"', 'node $(echo bad)', 'node server.js && rm -rf x', 'vite', 'node --test'])
    assert.equal(startEntry(command, {}), undefined)
})
test('bare project discovery maps its declared generated start entry through tsconfig', () => {
  const project = discoverNodeProject(
    root,
    virtual({
      'package.json': { name: 'app', scripts: { start: 'node dist/server.js' } },
      'tsconfig.json': { compilerOptions: { rootDir: 'src', outDir: 'dist' } },
      'src/server.ts': 'console.log(42)'
    })
  )
  assert.equal(project.entries[0].file, resolve(root, 'src/server.ts'))
})
test('all declared package bins are discovered', () => {
  const project = discoverNodeProject(
    root,
    virtual({ 'package.json': { bin: { first: 'one.js', second: 'two.js' } }, 'one.js': '', 'two.js': '' })
  )
  assert.deepEqual(
    project.entries.map((entry) => entry.name),
    ['first', 'second']
  )
})
test('ambiguous conventional entries fail rather than silently choosing another program', () => {
  assert.throws(() => discoverNodeProject(root, virtual({ 'package.json': {}, 'index.ts': '', 'server.js': '' })), /Ambiguous/)
})
test('a missing explicit start entry cannot fall through to an unrelated main', () => {
  assert.throws(
    () =>
      discoverNodeProject(root, virtual({ 'package.json': { main: 'index.js', scripts: { start: 'node missing.js' } }, 'index.js': '' })),
    /start script names/
  )
})
const exported = {
  'checkout/package.json': {
    name: 'sample',
    exports: {
      '.': { '@sample/source': './src/index.ts', import: './dist/index.js', require: './dist/index.cjs' },
      './feature/*': { source: './src/*.ts', default: './dist/*.js' },
      './private': null
    }
  },
  'checkout/src/index.ts': 'export const value = 42',
  'checkout/src/one.ts': 'export const value = 1',
  'checkout/src/private.ts': 'export const value = 0'
}
test('an unbuilt package checkout resolves its source exports without caller paths', () => {
  assert.equal(implementation(exported, 'sample', [{ root: 'checkout' }]), resolve(root, 'checkout/src/index.ts'))
  assert.equal(implementation(exported, 'sample/feature/one', [{ root: 'checkout' }]), resolve(root, 'checkout/src/one.ts'))
  assert.equal(implementation(exported, 'sample/private', [{ root: 'checkout' }]), undefined)
  assert.equal(implementation(exported, 'sample/src/private', [{ root: 'checkout' }]), undefined)
})
test('tsconfig emitted module paths find shipped TS including inferred rootDir', () => {
  assert.equal(
    implementation({
      'app/node_modules/sample/package.json': { main: 'lib/index.js' },
      'app/node_modules/sample/tsconfig.json': { compilerOptions: { outDir: 'lib' }, include: ['src/**/*.ts'] },
      'app/node_modules/sample/src/index.ts': 'export const value = 42'
    }),
    resolve(root, 'app/node_modules/sample/src/index.ts')
  )
})
test('a bundled public entry maps to the unique matching source below an explicit broad rootDir', () => {
  assert.equal(
    implementation(
      {
        'checkout/package.json': {
          name: 'sample',
          exports: { '.': { import: { types: './dist/index.d.mts', default: './dist/index.mjs' } } }
        },
        'checkout/tsconfig.json': {
          compilerOptions: { rootDir: '.', outDir: 'dist' },
          include: ['src/**/*.ts', 'test/**/*.ts']
        },
        'checkout/src/index.ts': 'export const value = 42',
        'checkout/src/helper.ts': 'export const helper = 1',
        'checkout/test/server.test.ts': ''
      },
      // The checkout is a stated package source, as in every sibling case: the
      // resolver guesses no directory from a package name
      // (`module-resolution.ts`), so without the root `sample` resolves nowhere
      // and the case measured nothing about rootDir since it was written.
      'sample',
      [{ root: 'checkout' }]
    ),
    resolve(root, 'checkout/src/index.ts')
  )
})
test('static Rollup outputs and build-script moves discover bundled entries', () => {
  assert.equal(
    implementation(
      {
        'checkout/package.json': { name: 'sample', main: 'dist/sample.cjs.js', scripts: { build: 'rollup --config && mv tmp/*.js dist' } },
        'checkout/rollup.config.mjs': "const input = 'src/index.ts'; export default [{ input, output: { file: 'tmp/sample.cjs.js' } }]",
        'checkout/src/index.ts': 'export const value = 42'
      },
      'sample',
      [{ root: 'checkout' }]
    ),
    resolve(root, 'checkout/src/index.ts')
  )
})
test('static esbuild outbase/outdir discovery keeps import and require paths', () => {
  const files = {
    'checkout/package.json': {
      name: 'sample',
      scripts: { build: 'tsx build.ts' },
      exports: { import: './dist/index.js', require: './dist/cjs/index.js' }
    },
    'checkout/build.ts': "const esm = { outbase: './src', outdir: './dist' }; const cjs = { outbase: './src', outdir: './dist/cjs' }",
    'checkout/src/index.ts': 'export const value = 42'
  }
  for (const mode of [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS])
    assert.equal(implementation(files, 'sample', [{ root: 'checkout' }], 'app/main.ts', mode), resolve(root, 'checkout/src/index.ts'))
})
test('source checkouts retain nested installed dependency versions', () => {
  const files = {
    'app/node_modules/sample/package.json': { name: 'sample', main: 'dist/index.js' },
    'app/node_modules/sample/dist/index.js': 'export const value = 1',
    'app/node_modules/parent/node_modules/sample/package.json': { name: 'sample', main: 'dist/index.js' },
    'app/node_modules/parent/node_modules/sample/dist/index.js': 'export const value = 2',
    'checkout-one/package.json': { name: 'sample', main: 'dist/index.js', source: 'src/index.ts' },
    'checkout-one/src/index.ts': 'export const value = 1',
    'checkout-two/package.json': { name: 'sample', main: 'dist/index.js', source: 'src/index.ts' },
    'checkout-two/src/index.ts': 'export const value = 2',
    'app/node_modules/parent/node_modules/dep/package.json': { main: 'index.js' },
    'app/node_modules/parent/node_modules/dep/index.js': 'export const value = 2',
    'app/node_modules/dep/package.json': { main: 'index.js' },
    'app/node_modules/dep/index.js': 'export const value = 1'
  }
  const packages = [
    { root: 'checkout-one', origin: 'app/node_modules/sample' },
    { root: 'checkout-two', origin: 'app/node_modules/parent/node_modules/sample' }
  ]
  assert.equal(implementation(files, 'sample', packages), resolve(root, 'checkout-one/src/index.ts'))
  assert.equal(implementation(files, 'sample', packages, 'app/node_modules/parent/main.ts'), resolve(root, 'checkout-two/src/index.ts'))
  assert.equal(
    implementation(files, 'dep', packages, 'checkout-two/src/index.ts'),
    resolve(root, 'app/node_modules/parent/node_modules/dep/index.js')
  )
})
test('source metadata requires a pinned commit and a contained repository directory', () => {
  const base = { gitHead: 'a'.repeat(40), repository: { url: 'git+https://github.com/example/library.git', directory: 'packages/library' } }
  assert.deepEqual(sourceIdentity(base), {
    url: 'https://github.com/example/library.git',
    commit: 'a'.repeat(40),
    directory: 'packages/library'
  })
  for (const change of [
    { gitHead: 'HEAD' },
    { gitHead: 'v1.0.0' },
    { repository: { url: 'file:///etc' } },
    { repository: { url: 'https://github.com/a/b', directory: '../escape' } }
  ])
    assert.equal(sourceIdentity({ ...base, ...change }), undefined)
})
test('npm provenance supplies an exact source commit when modern publications omit gitHead', async () => {
  const { provenanceSourceIdentity } = await import('../dist/project-preparation.js')
  const integrity = Buffer.from('published archive').toString('base64')
  const digest = Buffer.from(integrity, 'base64').toString('hex')
  const metadata = {
    name: '@example/server',
    version: '2.1.1',
    repository: { url: 'git+https://github.com/example/server.git' },
    dist: { integrity: `sha512-${integrity}` }
  }
  const payload = (repository = 'git+https://github.com/example/server', sourceDigest = digest) => ({
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/%40example/server@2.1.1', digest: { sha512: sourceDigest } }],
    predicate: {
      buildDefinition: {
        resolvedDependencies: [{ uri: `${repository}@refs/tags/v2.1.1`, digest: { gitCommit: 'b'.repeat(40) } }]
      }
    }
  })
  const response = (body) => ({
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(body)).toString('base64') } }
      }
    ]
  })
  assert.deepEqual(provenanceSourceIdentity(metadata, response(payload())), {
    url: 'https://github.com/example/server.git',
    directory: '.',
    commit: 'b'.repeat(40)
  })
  assert.equal(provenanceSourceIdentity(metadata, response(payload('git+https://github.com/attacker/server'))), undefined)
  assert.equal(provenanceSourceIdentity(metadata, response(payload(undefined, '0'.repeat(128)))), undefined)
})
// Hono and MongoDB were checked here against `node-compat/vendored-sources`,
// which is gone: a checkout pinned to one version answered for whatever
// version an application had installed, and kept answering after the
// dependency moved. Their source now arrives the same way every other
// package's does -- acquired for the exact installed version into
// `node_modules/.cache/geatsc/sources` -- so there is no checked-in tree to
// point a resolver at. The cases below keep the same assertion over the
// corpus checkouts, which are real trees this repository does own.
for (const [name, directory, specifier, suffix] of [
  ['zod', '../corpus/cases/zod/src/packages/zod', 'zod/v3', '/src/v3/index.ts'],
  ['neverthrow', '../corpus/cases/neverthrow/src', 'neverthrow', '/src/index.ts'],
  ['tiny-invariant', '../corpus/cases/tiny-invariant/src', 'tiny-invariant', '/src/tiny-invariant.ts']
])
  test(`real ${name} source checkout resolves through metadata alone`, () => {
    const packageRoot = resolve(compiler, directory)
    assert.ok(existsSync(join(packageRoot, 'package.json')))
    const result = createModuleResolver(ts.sys, options, new Set(), [{ root: packageRoot }]).resolve(
      specifier,
      resolve(root, 'main.ts'),
      ts.ModuleKind.ESNext
    )
    assert.equal(result.implementation?.resolvedFileName, `${packageRoot}${suffix}`)
  })
// Compiles against the node-compat runtime, which is a separate checkout.
test('bare geatsc discovers, compiles, links, and runs a Node project', { skip: nodeCompatRoot() ? false : 'set GEA_NODE_COMPAT_ROOT to a checkout of geastack/node-compat' }, () => {
  const project = resolve(compiler, 'test/fixtures/node-project')
  const defaultBuild = spawnSync(resolve(compiler, 'dist/cli.js'), [], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(defaultBuild.status, 0, defaultBuild.stderr)
  assert.doesNotMatch(defaultBuild.stderr, /\[build\] .* -std=c\+\+20 /)
  const out = join(project, 'dist/.geatsc/automatic-node-project')
  const executable = join(project, 'dist/automatic-node-project')
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
  const generatedProject = JSON.parse(readFileSync(join(out, 'tsconfig.json'), 'utf8'))
  assert.equal(report.linked, true)
  assert.ok(report.certificate)
  assert.equal(report.layout, 'single')
  assert.deepEqual(report.generatedFiles, ['automatic-node-project.cpp'])
  assert.ok(existsSync(join(out, 'automatic-node-project.cpp')))
  for (const legacy of ['server.cpp', 'main.cpp', 'gea_runtime.h', 'gea_dynamic_proxy.h', 'gea_eval.h']) {
    assert.equal(existsSync(join(out, legacy)), false, `${legacy} should not be copied or generated`)
  }
  const singleSource = readFileSync(join(out, 'automatic-node-project.cpp'), 'utf8')
  assert.match(singleSource, /run_compiled_program\(argc, argv, __gea_top_level\)/)
  assert.deepEqual(Object.keys(generatedProject.compilerOptions.paths), ['@app/*', 'node:process'])
  if (process.platform === 'darwin') assert.equal(existsSync(`${executable}.dSYM`), false)
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '42')

  const verboseBuild = spawnSync(resolve(compiler, 'dist/cli.js'), ['--verbose'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(verboseBuild.status, 0, verboseBuild.stderr)
  assert.match(verboseBuild.stderr, /\[build\] .* -std=c\+\+20 /)

  const perFileBuild = spawnSync(resolve(compiler, 'dist/cli.js'), ['--translation-units', 'per-file'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(perFileBuild.status, 0, perFileBuild.stderr)
  const perFileReport = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
  assert.equal(perFileReport.layout, 'per-file')
  assert.deepEqual(
    perFileReport.units
      .filter((unit) => unit.role === 'module')
      .map((unit) => unit.sourceFile)
      .sort(),
    [join(project, 'src/index.ts'), join(project, 'src/value.ts'), resolve(nodeCompatRoot(), 'runtime/node/process.ts')].sort()
  )
  assert.ok(perFileReport.units.some((unit) => unit.role === 'program' && unit.fileName === 'automatic-node-project.cpp'))
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '42')

  const singleEmit = spawnSync(resolve(compiler, 'dist/cli.js'), ['--emit-only'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
  assert.equal(singleEmit.status, 0, singleEmit.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).generatedFiles, ['automatic-node-project.cpp'])
  for (const unit of perFileReport.units.filter((unit) => unit.fileName !== 'automatic-node-project.cpp')) {
    assert.equal(existsSync(join(out, unit.fileName)), false, `${unit.fileName} should be removed when changing layouts`)
  }
})

const preparationFixture = () => {
  const data = new Map([
    ['/app/package.json', JSON.stringify({ dependencies: { sample: '1.0.0' } })],
    [
      '/app/node_modules/sample/package.json',
      JSON.stringify({ name: 'sample', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' })
    ]
  ])
  return {
    data,
    files: {
      exists: (file) => data.has(file),
      read: (file) => {
        if (!data.has(file)) throw new Error(`Missing ${file}`)
        return data.get(file)
      },
      write: (file, text) => data.set(file, text),
      realpath: (file) => file
    }
  }
}
test('source preparation requests the installed version, validates the checkout and reuses the cache', async () => {
  const { preparePackageSources } = await import('../dist/project-preparation.js')
  const { data, files } = preparationFixture()
  const calls = []
  const metadata = async (name, version) => {
    calls.push([name, version])
    return {
      name,
      version,
      gitHead: 'a'.repeat(40),
      repository: { url: 'https://github.com/example/sample.git', directory: 'packages/sample' }
    }
  }
  const checkout = (identity, destination) => {
    assert.equal(identity.commit, 'a'.repeat(40))
    data.set(`${destination}/packages/sample/package.json`, JSON.stringify({ name: 'sample', version: '1.0.0' }))
  }
  const options = { files, metadata, checkout, log: () => {} }
  const first = await preparePackageSources('/app', options)
  assert.equal(first.length, 1)
  assert.equal(first[0].origin, '/app/node_modules/sample')
  assert.ok(first[0].root.endsWith('/packages/sample'))
  assert.deepEqual(await preparePackageSources('/app', options), first)
  assert.deepEqual(calls, [['sample', '1.0.0']])
})
test('source preparation never substitutes latest, HEAD, or a mismatched package version', async () => {
  const { preparePackageSources } = await import('../dist/project-preparation.js')
  for (const response of [
    { name: 'sample', version: '2.0.0', gitHead: 'a'.repeat(40) },
    { name: 'sample', version: '1.0.0', gitHead: 'HEAD', repository: 'https://github.com/example/sample' },
    { name: 'sample', version: '1.0.0', repository: 'https://github.com/example/sample' }
  ]) {
    const { files } = preparationFixture()
    const logs = []
    const result = await preparePackageSources('/app', {
      files,
      metadata: async () => response,
      checkout: () => assert.fail('must not check out an unpinned source'),
      log: (message) => logs.push(message)
    })
    assert.deepEqual(result, [])
    assert.match(logs[0], /using installed JavaScript/)
  }
})
test('registry errors retain the installed implementation and disclose the fallback', async () => {
  const { preparePackageSources } = await import('../dist/project-preparation.js')
  const { files } = preparationFixture()
  const logs = []
  assert.deepEqual(
    await preparePackageSources('/app', {
      files,
      metadata: async () => {
        throw new Error('offline')
      },
      log: (message) => logs.push(message)
    }),
    []
  )
  assert.match(logs[0], /offline.*using installed JavaScript/)
})
test('the dependency walk stops at the compiler: nothing reachable only through it is acquired', async () => {
  const { preparePackageSources } = await import('../dist/project-preparation.js')
  const compilerName = JSON.parse(readFileSync(join(compiler, 'package.json'), 'utf8')).name
  const { data, files } = preparationFixture()
  // The shape node-compat has: a plain-JavaScript target package whose peer is
  // the compiler, whose own dependency is TypeScript -- a generated package
  // with types, exactly what the walk otherwise acquires.
  data.set('/app/package.json', JSON.stringify({ dependencies: { target: '1.0.0' } }))
  data.set(
    '/app/node_modules/target/package.json',
    JSON.stringify({ name: 'target', version: '1.0.0', peerDependencies: { [compilerName]: '*' } })
  )
  data.set(
    `/app/node_modules/${compilerName}/package.json`,
    JSON.stringify({
      name: compilerName,
      version: '9.9.9',
      main: 'dist/compiler.js',
      types: 'dist/compiler.d.ts',
      dependencies: { typescript: '*' }
    })
  )
  data.set(
    '/app/node_modules/typescript/package.json',
    JSON.stringify({ name: 'typescript', version: '5.9.3', main: 'lib/typescript.js', typings: 'lib/typescript.d.ts' })
  )
  const asked = []
  const result = await preparePackageSources('/app', {
    files,
    metadata: async (name, version) => {
      asked.push(`${name}@${version}`)
      throw new Error('must not be asked')
    },
    checkout: () => assert.fail('must not check anything out'),
    log: () => {}
  })
  assert.deepEqual(result, [])
  assert.deepEqual(asked, [])
})
test('every installed copy of one published version shares one checkout', async () => {
  const { preparePackageSources } = await import('../dist/project-preparation.js')
  const { data, files } = preparationFixture()
  data.set('/app/package.json', JSON.stringify({ dependencies: { sample: '1.0.0', other: '1.0.0' } }))
  data.set('/app/node_modules/other/package.json', JSON.stringify({ name: 'other', version: '1.0.0', dependencies: { sample: '1.0.0' } }))
  data.set(
    '/app/node_modules/other/node_modules/sample/package.json',
    JSON.stringify({ name: 'sample', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' })
  )
  const asked = []
  let checkouts = 0
  const result = await preparePackageSources('/app', {
    files,
    metadata: async (name, version) => {
      asked.push(`${name}@${version}`)
      return {
        name,
        version,
        gitHead: 'a'.repeat(40),
        repository: { url: 'https://github.com/example/sample.git', directory: 'packages/sample' }
      }
    },
    checkout: (_identity, destination) => {
      checkouts += 1
      data.set(`${destination}/packages/sample/package.json`, JSON.stringify({ name: 'sample', version: '1.0.0' }))
    },
    log: () => {}
  })
  assert.deepEqual(asked, ['sample@1.0.0'])
  assert.equal(checkouts, 1)
  assert.deepEqual(result.map((source) => source.origin).sort(), [
    '/app/node_modules/other/node_modules/sample',
    '/app/node_modules/sample'
  ])
  assert.equal(new Set(result.map((source) => source.root)).size, 1)
})

test('the Node oracle executes the same unbuilt checkout through the shared resolver', () => {
  const packageRoot = resolve(compiler, '../corpus/cases/tiny-invariant/src')
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      resolve(compiler, '../corpus/node_modules/tsx/dist/loader.mjs'),
      '--import',
      resolve(compiler, 'dist/semantics/node-source-hooks.js'),
      '--input-type=module',
      '--eval',
      "import invariant from 'tiny-invariant'; invariant(true); console.log('oracle-ok')"
    ],
    {
      cwd: compiler,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, GEATSC_SOURCE_CONTEXT: JSON.stringify({ root: compiler, packageSources: [{ root: packageRoot }] }) }
    }
  )
  assert.equal(output.trim(), 'oracle-ok')
})

test('dependency installation follows the selected manager and its lock without lifecycle scripts', async () => {
  const { dependencyInstallCommand } = await import('../dist/project-preparation.js')
  assert.equal(dependencyInstallCommand({}, new Set(['package-lock.json'])).args[0], 'ci')
  assert.equal(dependencyInstallCommand({ packageManager: 'npm@10.0.0' }, new Set(['yarn.lock'])).args[0], 'install')
  assert.deepEqual(dependencyInstallCommand({}, new Set(['pnpm-lock.yaml'])).args, ['install', '--ignore-scripts', '--frozen-lockfile'])
  const yarn = dependencyInstallCommand({ packageManager: 'yarn@4.1.0' }, new Set(['yarn.lock']))
  assert.deepEqual(yarn.args, ['install', '--immutable'])
  assert.equal(yarn.env.YARN_ENABLE_SCRIPTS, 'false')
})
