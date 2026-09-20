import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// THE compiler. There is one, it is `dist/`, and every agent's changes rebuild
// it -- see `CLAUDE.md`'s "One compiler".
//
// This used to honour `GEA_CORPUS_DIST`, so a run could measure a PRIVATE copy
// of the build. The reasoning was that two builds made minutes apart are not
// comparable while anything else edits the tree. That is true and it is not
// this script's problem to solve: a private copy answers it by measuring a
// compiler nobody else has, which is how a measurement gets reported for a
// build that was never shared, and how 155 stale copies and 15 GB of scratch
// accumulated. Serialize against the other agents instead.
const distRoot = '../dist'
if (process.env.GEA_CORPUS_DIST) {
  throw new Error('GEA_CORPUS_DIST is gone: there is ONE compiler, `dist/`. Rebuild it and measure that. See CLAUDE.md.')
}
const { compile } = await import(`${distRoot}/compiler.js`)
const { findProjectFile } = await import(`${distRoot}/semantics/program.js`)

/**
 * The compass.
 *
 * One run over a fixed corpus, reporting for every program the same numbers, so
 * a change is measured rather than asserted. It prints a bounded table and
 * writes the complete record to a file, because a top-N view of a regression is
 * indistinguishable from no regression at all.
 *
 * Missing obligations are counted by *predicate id*, not by row: one absent
 * primitive raises one row per site, so counting rows measures how large the
 * program is and not how large the gap is. The ranked blocker list at the end
 * is what says which primitive to build next.
 *
 * A real application is one program, not a pile of files: an app entry compiled
 * under its own project pulls in every module it imports and every ambient
 * declaration the project declares, which is the only configuration in which
 * what this reports is what shipping the app would report.
 */

// fileURLToPath, not `.pathname`: on Windows the latter keeps the URL's
// leading slash, and resolving `/C:/...` yields `C:\C:\...`.
const here = resolve(fileURLToPath(new URL('..', import.meta.url)))

const sourceFilesIn = (dir) => {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir)
    .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts'))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * The file an application starts from, or `null` when it has no single entry.
 *
 * The manifest's own `gea.entry` first, for the same reason `appPlatform` below
 * reads the manifest: it is what the shipping build opens, and a convention
 * kept only here is a second rule that can disagree with it. It did -- `maps`
 * starts from `index.device.tsx`, matched none of the four conventional names,
 * and was dropped from every measurement without a word, so a shipping app sat
 * outside the corpus while the corpus reported itself complete.
 */
const entryOf = (appDir) => {
  const manifest = join(appDir, 'package.json')
  if (existsSync(manifest)) {
    try {
      const stated = JSON.parse(readFileSync(manifest, 'utf8'))?.gea?.entry
      if (typeof stated === 'string' && existsSync(join(appDir, stated))) return join(appDir, stated)
    } catch {
      // A manifest this file cannot read is not an entry point; fall through to
      // the conventional names rather than dropping the app entirely.
    }
  }
  for (const candidate of ['index.tsx', 'index.ts', 'src/index.tsx', 'src/index.ts']) {
    const path = join(appDir, candidate)
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Every directory an app's own native half is compiled with on its include
 * path: the conventional `native/`, plus the directory of each source the
 * manifest declares under `gea.nativeSources`.
 *
 * Both halves are needed because the two are genuinely different conventions.
 * Most apps keep their native half in `native/` and the plugin's preamble names
 * the header by bare name (`native_bench.h`, `device_bridge.h`). `gea3d-cube`
 * does not: its native half is a vendored copy of the gea3d engine under
 * `src/gea3d/native/`, declared in the manifest and named -- also by bare name
 * -- as `gea3d_native.h`. Reading only `native/` measured that app as failing
 * to compile over a header that is right there in the tree and on the real
 * build's include path, which is a defect in this harness, not in the emitted
 * C++.
 *
 * The manifest is the authority for the same reason `entryOf` and `appPlatform`
 * read it: it is what the shipping build reads. A second list here would drift.
 */
const nativeDirectoriesOf = (appDir) => {
  const directories = [join(appDir, 'native')]
  const manifest = join(appDir, 'package.json')
  if (existsSync(manifest)) {
    try {
      const stated = JSON.parse(readFileSync(manifest, 'utf8'))?.gea?.nativeSources
      if (Array.isArray(stated)) {
        for (const source of stated) if (typeof source === 'string') directories.push(dirname(join(appDir, source)))
      }
    } catch {
      // Unreadable manifest: `native/` alone, exactly as before this read existed.
    }
  }
  return [...new Set(directories)].filter((directory) => existsSync(directory))
}

/**
 * The platform an app declares for itself, or `null` when it declares none.
 *
 * Read from the app's own manifest rather than inferred from what its emitted
 * C++ happens to name: the manifest is what the shipping build reads, and a
 * second rule here could disagree with it.
 */
const appPlatform = (appDir) => {
  const manifest = join(appDir, 'package.json')
  if (!existsSync(manifest)) return null
  try {
    const targets = JSON.parse(readFileSync(manifest, 'utf8'))?.gea?.targets ?? {}
    return targets.ios === true ? 'ios' : null
  } catch {
    return null
  }
}

const appsIn = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, entry: entryOf(join(dir, name)) }))
    .filter((app) => app.entry !== null)
}

/**
 * Every example app writes `import { Component } from '@geastack/core'`. The
 * package's own `exports` map (`core/packages/core/package.json`) answers
 * `"."` with `{ types: "./index.d.ts", default: "./runtime.ts" }` --
 * `runtime.ts` (which re-exports `runtime-surface.ts`) is the real
 * entrypoint a bundler loads at build time, and `index.d.ts` is a
 * separately-authored declaration file for editors, not a mirror of it (its
 * `WiFiController`/`DisplayController`/`GeaWindow`/... classes do not exist
 * anywhere in `runtime/host.ts`, which declares the same surface inline as
 * anonymous `declare const navigator: { ... }` object types instead). None
 * of the 56 app tsconfigs under the examples apps root declares a `paths` entry
 * for `@geastack/core` -- most declare none at all, a few alias only a
 * stale `gea-embedded` -- so this compiler's own module resolution falls
 * through node_modules to that declaration file. Resolving the framework to
 * a `.d.ts` makes the whole library look ambient (declared by a host,
 * defined nowhere), so the checker types every framework export as a native
 * host object and this compiler demands a native protocol for it. That is a
 * measurement of the harness, not of the app.
 */
// @geastack/core is a package, so its root is its own package.json's directory.
const frameworkRoot = dirname(fileURLToPath(import.meta.resolve('@geastack/core/package.json')))

const frameworkPaths = {
  '@geastack/core': [join(frameworkRoot, 'runtime.ts')],
  '@geastack/core/*': [join(frameworkRoot, '*')]
}

// Generated, not hand-written: 56 near-identical override files would drift
// the moment an app's own tsconfig changes lib/jsx/types, and this directory
// is regenerated on every run so it never can. Nothing under
// the examples apps root is touched.
const generatedProjectsDir = join(here, 'projects', 'generated')

// Concurrent runs collide on the generated tsconfigs -- same path, same
// filename, and `writeFileSync` is not atomic, so a run that reads one
// mid-write sees a truncated file and records a certificate loss with no
// compiler cause. That is the "corpus is flaky while agents run" failure.
//
// The cure is a distinct NAME, deliberately NOT a distinct directory. A
// tsconfig is not location-independent: TypeScript resolves `extends`, `paths`
// and `node_modules` relative to the file's own directory, so writing these
// somewhere else silently changes module resolution for every app -- and the
// failure it produces (cert null, everything else zero, "import module
// specifier did not resolve to a checker module declaration") is INDISTINGUISH-
// ABLE from a real refusal. That cost a peer session a false regression report
// against six apps before `operations: 1` gave it away. It also loses the
// hand-written project files that live beside `generated/`.
//
// So the private root names the files, and they stay where resolution expects.
const generatedProjectPrefix = process.env.GEA_CORPUS_PROJECTS ? `${basename(resolve(process.env.GEA_CORPUS_PROJECTS))}.` : ''
mkdirSync(generatedProjectsDir, { recursive: true })

/**
 * The project an example app compiles under: its own tsconfig, `extends`-ed
 * by one generated file that adds only the `paths` entry above.
 *
 * `extends` is how an external application's project and the generated
 * `watch-noimportsource.tsconfig.json` already solve exactly this kind of
 * problem, and it is what lets every other setting an app's tsconfig asks for
 * -- its `lib`, its `jsx`, the two apps (`image-demo`, `weather`) that set
 * `"types": []` specifically to keep `@types/node` from handing `fetch` and
 * `setTimeout` to the DOM/ambient checker instead of the framework's own --
 * pass through untouched. `paths` itself is not deep-merged by `extends`
 * (TypeScript replaces the whole map when the extending file sets it), which
 * is exactly what is wanted here: it drops the stale `gea-embedded` alias
 * a few apps still carry, rather than adding to it. `include`/`exclude`
 * paths in the app's own tsconfig keep resolving relative to *that* file's
 * directory, not this generated one -- TypeScript has always resolved a
 * base config's own relative paths against its own location, extended or
 * not -- so nothing about which files an app compiles changes.
 *
 * Six apps (`ios-*-showcase`, `ios-metal-world-game`, `ttf-bench`) ship no
 * tsconfig.json of their own anywhere above them; `findProjectFile` returns
 * `null` for these today, and they compile under this compiler's own bare
 * `defaultCompilerOptions` (see `dist/semantics/program.js`) with no `paths`
 * at all -- the same `.d.ts` bug, reached by plain node_modules resolution
 * instead of a stale alias. They get that same baseline back, verbatim,
 * plus the one fix: no `extends`, since there is no app tsconfig to layer
 * onto, and no `include`, since a compiled root's imports are pulled into
 * the program by module resolution regardless of what a project's `include`
 * names -- `include` only matters for ambient `.d.ts` files nothing
 * `import`s, and none of these six apps has one.
 */
/**
 * The library set the framework's own source needs, on top of whatever the app
 * declares.
 *
 * `DOM`, still -- but no longer because the framework needs it. It used to be
 * unavoidable: `runtime/primitives.ts` named `HTMLElement`, a lib.dom global
 * the framework itself never declares, and without the library 33 apps failed
 * to typecheck on it. That is fixed at the source (the mount root is now read
 * off `document.getElementById`'s own result type), so this is a free choice
 * again -- and measured both ways.
 *
 * Removing it is worth 4 apps whose checker errors are entirely lib.dom's doing
 * and costs 3 that lose their certificate: an app declaring its own
 * `interface Window` plus `declare const window: Window` is declaring a HOST
 * object, and with lib.dom gone the compiler correctly demands a native
 * boundary for `Window@1` that no plugin states. That is the honest state of
 * the world and the right thing to fix, but it is a host-binding gap, not a
 * reason to hold the other 4 hostage -- so the library stays until `window` is
 * wired, and this note is the record of what removing it costs.
 *
 * `lib` does not merge through `extends` -- it replaces -- so the app's own
 * choice has to be restated alongside the addition rather than added to it.
 */
const frameworkLib = null

// The baseline for the six apps that ship no tsconfig at all: what every other
// app's own tsconfig declares.
const baselineLib = ['ES2022']

/**
 * The ambient asset declarations every generated project carries.
 *
 * Stated through `files` rather than `include` on purpose: `extends` replaces
 * `include` instead of merging it, so naming one here would silently discard
 * whatever file set the app's own tsconfig declared. `files` and `include`
 * contribute independently, and no app in the corpus sets `files` -- verified,
 * not assumed -- so this adds one declaration file and changes nothing else
 * about which sources a program contains.
 */
const ambientAssets = join(here, 'test', 'fixtures', 'ambient', 'assets.d.ts')

/**
 * No AMBIENT type package is auto-included in a generated project.
 *
 * TypeScript's automatic `@types` inclusion walks up from the directory holding
 * the tsconfig, and these are generated into `projects/generated/`,
 * so every app was silently compiled with `node_modules/@types/node`
 * in its program. That is not a smaller difference than it sounds: `@types/node`
 * declares `fetch`, `console`, `setTimeout` and `Buffer` as globals, and they
 * MERGE with the framework's own declarations of the same names -- so `await
 * fetch(url)` in `maps` resolved to Node's overload and produced a `Response`,
 * a host type gea has never had, instead of the framework's `FetchResponse`.
 *
 * Pointing the roots at the app's own chain instead was tried and is worse:
 * the examples workspace-root `node_modules/@types` install, so every app
 * inherits every package any sibling hoisted there -- `@types/react`, whose
 * global `JSX` namespace replaces the framework's and turned every `<canvas>`
 * touch handler in `bubble-grid` into React's `TouchEvent<HTMLCanvasElement>`.
 * An app that really needs an ambient package can `/// <reference types>` it or
 * import it; nothing in this corpus does.
 */
const noAmbientTypePackages = { types: [] }

const projectForApp = (appDir, appName) => {
  const ownTsconfig = findProjectFile(appDir)
  const config = ownTsconfig
    ? {
        extends: ownTsconfig,
        files: [ambientAssets],
        // `lib` is deliberately absent: the app's own tsconfig decides it, and
        // `extends` REPLACES rather than merges, so naming it here at all would
        // overrule that choice. See `frameworkLib`.
        compilerOptions: {
          paths: frameworkPaths,
          ...noAmbientTypePackages,
          ...(frameworkLib === null ? {} : { lib: frameworkLib })
        }
      }
    : {
        files: [ambientAssets],
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          jsx: 'preserve',
          lib: frameworkLib ?? baselineLib,
          paths: frameworkPaths,
          ...noAmbientTypePackages
        }
      }
  const generated = join(generatedProjectsDir, `${generatedProjectPrefix}${appName}.tsconfig.json`)
  writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`)
  return generated
}

const targets = [
  // Fixtures are compiled file by file and without a project: each one exists to
  // isolate one language construct, and pulling a project's file set in would
  // measure the project instead of the construct.
  ...sourceFilesIn(join(here, 'test', 'fixtures')).map((file) => ({ label: 'fixtures', name: basename(file), file, project: null })),
  // The JSX fixtures are the one exception: JSX has no meaning without a JSX
  // namespace, so they carry the smallest project that declares one.
  ...sourceFilesIn(join(here, 'test', 'fixtures', 'jsx')).map((file) => ({
    label: 'fixtures',
    name: basename(file),
    file,
    project: join(here, 'test', 'fixtures', 'jsx', 'tsconfig.json')
  })),
  // The same JSX, compiled the way the *language* defines it: `jsx:
  // "react-jsx"` names a factory module, so every element is an ordinary call
  // to ordinary TypeScript and the compiler needs no element machinery at all.
  // This fixture exists to measure that claim rather than assert it.
  ...sourceFilesIn(join(here, 'test', 'fixtures', 'jsx-factory')).map((file) => ({
    label: 'fixtures',
    name: basename(file),
    file,
    project: join(here, 'test', 'fixtures', 'jsx-factory', 'tsconfig.json')
  })),
  // An application outside this repository joins the corpus by pointing
  // GEA_EXTERNAL_APP_DIR at it. Such an app may ship no tsconfig of its own --
  // its real build constructs the program from the bundler's module graph -- so
  // GEA_EXTERNAL_APP_TSCONFIG names the project that resolves its framework
  // import. Compiling it without one measures a program whose every import is
  // unresolved, which is a measurement of the harness.
  ...(process.env.GEA_EXTERNAL_APP_DIR
    ? sourceFilesIn(process.env.GEA_EXTERNAL_APP_DIR).map((file) => ({
        label: 'external',
        name: basename(file),
        file,
        project: process.env.GEA_EXTERNAL_APP_TSCONFIG ?? join(process.env.GEA_EXTERNAL_APP_DIR, 'tsconfig.json'),
        native: join(process.env.GEA_EXTERNAL_APP_DIR, 'native')
      }))
    : []),
  // The example apps are corpus input, not part of this repo. GEA_APPS_ROOT
  // names the app project root (the gea CLI sets it the same way); there is no
  // default, and without it the corpus simply runs without this arm.
  ...(process.env.GEA_APPS_ROOT ? appsIn(join(process.env.GEA_APPS_ROOT, 'apps')) : []).map((app) => ({
    label: 'examples',
    name: app.name,
    file: app.entry,
    project: projectForApp(dirname(app.entry), app.name),
    // Which platform this app is FOR, as the app itself states it
    // (`package.json`'s `gea.targets`). An iOS app's host spellings are UIKit's
    // -- `UIScreen`, `UILabel`, `UIColor` -- which do not exist in the macOS
    // SDK, so checking one against the default sysroot reports every one of
    // them as an unknown name and measures the wrong platform.
    platform: appPlatform(dirname(app.entry)),
    // Where this app's own native half lives, read from the app rather than
    // restated here. See `nativeDirectoriesOf`.
    native: nativeDirectoriesOf(dirname(app.entry))
  }))
]

const only = process.argv.find((argument) => argument.startsWith('--only='))
const filtered = only ? targets.filter((target) => `${target.label}/${target.name}`.includes(only.slice('--only='.length))) : targets

// `--shard=I/N` measures only every Nth target, offset I. A full gate is
// otherwise one process compiling 128 programs in series, which is the
// throughput ceiling on every change that has to be gated -- and the box has
// far more cores than that uses. Striding (rather than slicing into blocks)
// keeps each shard's mix of cheap and expensive programs roughly even, so the
// shards finish together instead of one holding the wall.
//
// Sharding is ONLY sound because each target is measured independently and
// the rows are order-independent: `scripts/merge-shards.mjs` concatenates the
// shard files back into one measurement with the same shape a single run
// writes. Every shard still needs its OWN `GEA_CORPUS_PROJECTS` and `TMPDIR`
// for the reason this file's own header records -- concurrent runs sharing
// scratch delete each other's in-flight output and manufacture failures that
// look like product bugs.
const shard = process.argv.find((argument) => argument.startsWith('--shard='))
const selected = (() => {
  if (!shard) return filtered
  const [indexText, countText] = shard.slice('--shard='.length).split('/')
  const index = Number(indexText)
  const count = Number(countText)
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`--shard expects I/N with 0 <= I < N, got ${shard.slice('--shard='.length)}`)
  }
  return filtered.filter((_, position) => position % count === index)
})()

const measureOne = (target) => {
  const started = process.hrtime.bigint()
  try {
    // Each measured target is compiled as one standalone native program. This
    // closes only its classic-script lexical realm, not globalThis or objects.
    const result = compile({ rootFileNames: [target.file], projectFileName: target.project, closedScriptScope: true })
    // Optional rows are excluded: an unbuilt fast path gates nothing, so
    // counting one as a gap would rank a devirtualization above the primitives
    // that actually stop a program from compiling.
    const missing = result.preflight.obligations.filter(
      (row) => !row.optional && (row.localStatus === 'missing' || row.localStatus === 'unsupported')
    )
    return {
      ...target,
      threw: null,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
      operations: result.graph.operations.size,
      edges: result.graph.edges.length,
      selected: result.representations.plan.selected.size,
      violations: result.representations.violations.length,
      boxed: [...result.representations.plan.selected.values()].filter((carrier) => carrier.kind === 'dynamic').length,
      unresolved: [...result.representations.plan.selected.values()].filter((carrier) => carrier.kind === 'unresolved').length,
      missingRows: missing.length,
      missingPredicates: [...new Set(missing.map((row) => row.predicate.id))].sort(),
      certificate: result.certificate ? result.certificate.id : null,
      loweringBlockers: result.loweringBlockers.map((blocker) => blocker.reason),
      abiBlockers: result.abiBlockers.map((blocker) => blocker.reason),
      emissionRefusals: result.emissionRefusals.map((refusal) => refusal.reason),
      diagnostics: result.diagnostics.diagnostics.filter((row) => row.severity === 'root').map((row) => row.message),
      // A WITHHELD producer is not a root diagnostic and never appeared in any
      // ranked list, so a program it killed outright reported no certificate,
      // no emitted line, zero violations and zero missing rows -- which reads
      // in this table exactly like a program blocked on something already
      // known. `const f = <T>(...) => ...` was dead that way in every program
      // that had one, and the corpus said nothing at all. Recorded separately
      // rather than folded into `diagnostics`, so the existing column keeps
      // meaning what it meant.
      withheld: result.diagnostics.diagnostics.filter((row) => row.message.startsWith('withheld:')).map((row) => row.message),
      emittedLines: result.source ? result.source.split('\n').length : 0,
      source: result.source
    }
  } catch (error) {
    return {
      ...target,
      threw: `${error.message}`,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
      missingPredicates: [],
      loweringBlockers: [],
      abiBlockers: [],
      emissionRefusals: [],
      diagnostics: []
    }
  }
}

const rows = selected.map(measureOne)

/**
 * The only claim about emitted C++ that is worth anything: a compiler accepted
 * it. Line counts say a file was produced, not that it is valid, and every
 * defect found in this backend so far -- a `shared_ptr` initialized from a
 * reference, an unquoted string literal, a member named `0` -- reads as a
 * perfectly plausible line until a compiler sees it.
 */
/**
 * The engine's own headers, for the units that name its spellings.
 *
 * A program that reaches a gea host namespace emits `#include
 * "gea/embedded.h"` -- the declaration the plugin package states for those
 * spellings -- so checking it without the engine on the include path measures
 * whether a header was found, not whether the program is valid C++.
 *
 * Six roots because that is how the engine lays its headers out: each package
 * includes its siblings' by bare name. They are read from the tree rather than
 * copied, so a header that moves breaks this loudly instead of silently
 * reverting the column to measuring the fiction it measured before -- a unit
 * that compiled only because it declared its own `extern` for every host
 * global and would never have linked.
 */
const engineRoots = [
  'core/packages/core/include',
  'core/packages/host/include',
  'core/packages/engine',
  'core/packages/engine/ui',
  'core/packages/elements',
  'core/packages/elements/ui'
]
const engineIncludes = engineRoots.map((root) => `-I${join(here, '..', root)}`)

/**
 * The iOS simulator sysroot and target triple, or an empty list when this
 * machine has no iOS SDK -- in which case an iOS program keeps failing against
 * the default sysroot, which is the honest answer for that configuration.
 */
let iosSdkCache
const iosSdkArguments = () => {
  if (iosSdkCache !== undefined) return iosSdkCache
  try {
    const path = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    iosSdkCache = path ? ['-isysroot', path, '-target', 'arm64-apple-ios17.0-simulator'] : []
  } catch {
    iosSdkCache = []
  }
  return iosSdkCache
}

// Beside the private projects root, for the same reason: two runs emitting
// C++ into one directory overwrite each other's files.
const cxxDir = process.env.GEA_CORPUS_PROJECTS ? join(resolve(process.env.GEA_CORPUS_PROJECTS), 'cxx') : join(here, 'measurements', 'cxx')
mkdirSync(cxxDir, { recursive: true })
copyFileSync(join(here, 'src/targets/cpp/runtime/gea_runtime.h'), join(cxxDir, 'gea_runtime.h'))
copyFileSync(join(here, 'src/targets/cpp/runtime/gea_dynamic_proxy.h'), join(cxxDir, 'gea_dynamic_proxy.h'))
copyFileSync(join(here, 'src/targets/cpp/runtime/gea_eval.h'), join(cxxDir, 'gea_eval.h'))
copyFileSync(join(here, 'src/targets/cpp/runtime/gea_native_class_prototype.h'), join(cxxDir, 'gea_native_class_prototype.h'))

/**
 * Apple's `gea/apple/native_bridge.h`, written by the generator the shipping
 * product uses.
 *
 * Every Apple program's preamble names that header, and it does not exist in
 * the tree: the plugin package writes it during a real build, out of the SDK
 * metadata alone -- so one copy serves every Apple app, and hand-writing a
 * stand-in here would measure the stand-in. Driven through the plugin's own
 * `createCppBackend(...).transformGeneratedSources` hook, which is where the
 * product calls `writeAppleNativeBridgeRuntime`.
 *
 * A tree without the Apple packages installed simply gets no header, and those
 * programs keep reporting the file as missing -- which is the honest answer for
 * that configuration and not something to paper over.
 */
const writeAppleBridgeHeader = () => {
  try {
    const require_ = createRequire(join(here, 'package.json'))
    const sdk = require_('@geastack/apple')
    const plugin = require_('@geastack/geatsc-plugin-apple-native')
    const metadata = sdk.generateAppleBridgeMetadata(sdk.appleSdkFixture)
    const backend = plugin.appleNativePlugin({ metadata }).createCppBackend({ outDir: cxxDir })
    backend?.transformGeneratedSources?.([])
    return true
  } catch (error) {
    process.stdout.write(`apple bridge header not generated: ${String(error)}\n`)
    return false
  }
}
writeAppleBridgeHeader()
for (const row of rows) {
  const path = join(cxxDir, `${row.label}-${row.name.replace(/\.[jt]sx?$/, '')}.cpp`)
  // A program that emitted nothing this run must not leave the file it emitted
  // on some earlier run lying around. `compiles` stays undefined either way, so
  // the table is honest -- but the stale file on disk is not, and reading one by
  // hand looks exactly like reading this run's output. That is not hypothetical:
  // a stale file was diagnosed at length here as though it were current.
  if (!row.source) {
    rmSync(path, { force: true })
    continue
  }
  writeFileSync(path, `${row.source}\n`)
  try {
    const stated = typeof row.native === 'string' ? [row.native] : (row.native ?? [])
    const nativeInclude = stated.filter((directory) => existsSync(directory)).map((directory) => `-I${directory}`)
    // An Apple program is Objective-C++, not C++. Its host spellings ARE ObjC
    // -- `[NSColor colorWithRed:...]`, `__bridge` -- because the frameworks it
    // calls have no C++ surface, which is why the shipping target compiles the
    // generated unit as `.mm`. Compiling it as plain C++ here measured a
    // language this program was never written in, and reported `__bridge` as an
    // undeclared identifier. ARC because the bridge the plugin generates is
    // written for it.
    const objcxx = row.source.includes('gea/apple/native_bridge.h')
    const language = objcxx ? ['-x', 'objective-c++', '-fobjc-arc'] : []
    // An iOS app is checked against the iOS SDK, for the reason `appPlatform`
    // states. The simulator SDK rather than the device one: this is a syntax
    // check, both declare the same UIKit, and the simulator sysroot is the one
    // present on a machine with Xcode and no device provisioning.
    const sdk = row.platform === 'ios' ? iosSdkArguments() : []
    execFileSync(
      'clang++',
      ['-std=c++20', '-fsyntax-only', ...language, ...sdk, `-I${cxxDir}`, ...nativeInclude, ...engineIncludes, path],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    row.compiles = 'yes'
  } catch (error) {
    row.compiles = 'NO'
    row.compileErrors = String(error.stderr ?? '')
      .split('\n')
      .slice(0, 40)
  }
}

const pad = (text, width) => String(text).padEnd(width)
const name = (row) => `${row.label}/${row.name}`

const header = ['program', 'ops', 'sel', 'viol', 'box', 'unres', 'miss', 'preds', 'cert', 'c++', 'clang']
process.stdout.write(
  `${pad(header[0], 34)}${header
    .slice(1)
    .map((h) => pad(h, 8))
    .join('')}\n`
)
process.stdout.write(`${'-'.repeat(34 + 8 * 10)}\n`)
for (const row of rows) {
  if (row.threw) {
    process.stdout.write(`${pad(name(row), 34)}THREW  ${row.threw.split('\n')[0].slice(0, 90)}\n`)
    continue
  }
  const cells = [
    row.operations,
    row.selected,
    row.violations,
    row.boxed,
    row.unresolved,
    row.missingRows,
    row.missingPredicates.length,
    row.certificate ? 'yes' : 'no',
    row.emittedLines,
    row.compiles ?? '-'
  ]
  process.stdout.write(`${pad(name(row), 34)}${cells.map((cell) => pad(cell, 8)).join('')}\n`)
}

const clean = rows.filter((row) => row.compiles === 'yes').length
const certified = rows.filter((row) => row.certificate).length
process.stdout.write(
  `\n${rows.length} programs: ${certified} certified, ${clean} clang-clean, ${rows.filter((r) => r.threw).length} threw\n`
)

// Ranked by how many programs a primitive blocks, then by name: a primitive
// that stops five programs outranks one that raises more rows inside a single
// program it was never going to finish anyway.
const rank = (key) => {
  const counts = new Map()
  for (const row of rows) for (const item of new Set(key(row))) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
}

const rankedPredicates = rank((row) => row.missingPredicates)
process.stdout.write(`\nmissing primitives, ranked by programs blocked (${rankedPredicates.length} distinct):\n`)
for (const [predicate, count] of rankedPredicates.slice(0, 30)) process.stdout.write(`  ${pad(count, 4)} ${predicate}\n`)

const rankedBlockers = rank((row) => [...row.loweringBlockers, ...row.abiBlockers, ...row.emissionRefusals].map((r) => r.slice(0, 110)))
process.stdout.write(`\nlowering / abi / emission blockers, ranked (${rankedBlockers.length} distinct):\n`)
for (const [reason, count] of rankedBlockers.slice(0, 30)) process.stdout.write(`  ${pad(count, 4)} ${reason}\n`)

const rankedDiagnostics = rank((row) => row.diagnostics.map((message) => message.slice(0, 110)))
process.stdout.write(`\nroot diagnostics, ranked by programs (${rankedDiagnostics.length} distinct):\n`)
for (const [message, count] of rankedDiagnostics.slice(0, 30)) process.stdout.write(`  ${pad(count, 4)} ${message}\n`)

const rankedWithheld = rank((row) => (row.withheld ?? []).map((message) => message.slice(0, 110)))
const withheldPrograms = rows.filter((row) => (row.withheld ?? []).length > 0)
process.stdout.write(`\nwithheld producers, ranked by programs (${rankedWithheld.length} distinct, ${withheldPrograms.length} programs):\n`)
for (const [message, count] of rankedWithheld.slice(0, 30)) process.stdout.write(`  ${pad(count, 4)} ${message}\n`)

const outDir = join(here, 'measurements')
mkdirSync(outDir, { recursive: true })
const label =
  process.argv.find((argument) => !argument.startsWith('--') && argument !== process.argv[0] && argument !== process.argv[1]) ?? 'latest'
const outFile = join(outDir, `${label}.json`)
writeFileSync(outFile, `${JSON.stringify({ rows: rows.map(({ source, ...rest }) => rest) }, null, 2)}\n`)
process.stdout.write(`\nrecord: ${relative(here, outFile)} (${rows.length} programs)\n`)
