// Coverage of three.js's own WebGPURenderer, compiled from three's source with
// nothing edited, through gea's own build pipeline, and a stable summary of
// what refuses.
//
//   THREE_DIR=<three package> NATIVE_WEBGPU_DIR=<@geastack/native-webgpu checkout> \
//   GEA_CORE_DIR=<an installed @geastack/core> \
//     node scripts/three-webgpu-coverage.mjs [--three <dir>] [--native-webgpu <dir>]
//     [--gea-core <dir>] [--gea-plugin <host-shims>] [--out <dir>] [--memory-limit-gb <n>]
//     [--summarize <coverage.json>] [--refusals-only]
//
// The program is `test/fixtures/three-webgpu/entry.ts`: a scene, a camera, a
// box with a node material, and `renderer.render(scene, camera)`. No real app
// hands geatsc its entry and lets the checker follow every import: gea's build
// (`build-gea-vite-geatsc.mjs`) bundles the app with Vite first, and its
// module-graph plugin (`entryReachableOnly`) records the modules the bundle
// keeps. geatsc compiles that graph (`compile-module-graph`). So this script
// runs that build, unchanged, on an app made of the entry:
//
//   <out>/app/          entry.ts, package.json, tsconfig.json, and
//                       node_modules/{three, @geastack/native-webgpu} linked to
//                       the two packages;
//   build-gea-vite-geatsc.mjs --app-dir <out>/app --entry entry.ts
//     --out-dir <out>/generated --geatsc-bin dist/cli.js --no-apple-native
//     --gea-embedded-compat --compile-module-graph
//     --extra-geatsc-plugin <native-webgpu>/geatsc-plugin.mjs
//   with GEA_WEBGL_PLUGIN=0.
//
// `--gea-embedded-compat` is the build's own switch for the Vite config that
// carries the module-graph plugin with `entryReachableOnly`; the entry does not
// import `@geastack/core`, so the build would not choose it by itself.
// `--no-apple-native` is what the Windows target passes. `GEA_WEBGL_PLUGIN=0`
// keeps native-webgl-angle's three.js text patches, its `@ts-nocheck` prefixes
// and its absent `self` out; the build hands geatsc no `--no-webgl-plugin`, and
// geatsc reads the variable from the environment it inherits. The extra plugin
// is the facade's: `navigator.gpu`, the `GPU*` flag namespaces, `self`, three's
// `src/**` unchecked, and its JSDoc `Node` and `AudioListener` realized as
// three's classes. It carries the three settings itself, so a second plugin
// stating them would realize `Node` twice over one file, which is an error.
//
// `--gea-plugin` (or `GEATSC2_GEA_PLUGIN`) names the gea host-shims module to
// load instead of the installed `@geastack/geatsc-plugin-gea/host-shims`, as a
// path without its `.js`, so a core branch's own build is measured. Both
// compiles inherit it; unset, the compiler loads the installed one.
//
// `compile-module-graph` reports only its root diagnostics, as text, on
// stderr, and `geatsc coverage` has no module-graph input. So the codes,
// derived rows, ABI rows and boxed carriers come from a second compile:
// `geatsc coverage` over the staged entry the build compiled, under the staged
// project beside it, with the build's own plugin list read back from the
// geatsc process's argv. The app's tsconfig states `allowJs`, `checkJs` and
// `maxNodeModuleJsDepth` because `compile-module-graph` forces them. Both
// compiles read the same files, but coverage cannot state the graph's module
// set or its resolutions, so it is not quite the build's program: the summary
// gives each of the build's roots the code of the coverage row at the same
// position, and lists the rows coverage reports beyond them.
//
// Neither package is a dependency of the compiler, so both are named by the
// caller, and so is the `@geastack/core` whose build is run: it needs its own
// dependencies (Vite, the gea Vite and geatsc plugins) installed beside it, as
// in an app's `node_modules`.
//
// Everything lands in `--out` (default `measurements/three-webgpu/`):
// `pipeline.log` (the build's stdout and stderr, geatsc's with
// `GEA_STAGE_TIMING`), `coverage.json` (the complete `coverage --json` report),
// `stderr.log` (the coverage compile's stderr), `run.json`, `summary.json` and
// `summary.txt`. The summary is grouped by code and, within a code, by the
// message with its source positions and interned ids folded, so two runs over
// the same compiler print the same groups; only the header (date, time,
// memory) moves. `--summarize` re-reads a `coverage.json` without compiling.
//
// `--refusals-only` stops after the build's compile: the refusals come from it
// (`GEA_REFUSALS_JSON`), so the second, coverage compile, which adds only the
// codes, derived rows, ABI rows and boxed carriers, is skipped. It writes
// `pipeline.log` and a `run.json` without the coverage fields, and prints the
// build's lines of the summary; there is no `coverage.json` or `summary.*`.
//
// One compile takes several GB. The working set of the whole process tree is
// sampled every few seconds, a status line is printed every 30 s, and the tree
// is stopped above `--memory-limit-gb` (default 11); the peak each compile
// reports is the geatsc process's own `maxRSS` at exit.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname, cpus, totalmem } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'test/fixtures/three-webgpu')

const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const fail = (message) => {
  process.stderr.write(`three-webgpu-coverage: ${message}\n`)
  process.exit(2)
}
const say = (message) => process.stdout.write(`three-webgpu-coverage: ${message}\n`)

const packageAt = (label, directory, expectedName, requiredFile) => {
  if (!directory) fail(`set ${label} (or pass the matching flag) to the ${expectedName} package directory`)
  const dir = resolve(directory)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) fail(`${label}=${dir} has no package.json`)
  const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (name !== expectedName) fail(`${label}=${dir} is package '${name}', not '${expectedName}'`)
  if (!existsSync(join(dir, requiredFile))) fail(`${label}=${dir} has no ${requiredFile}`)
  return { dir, version }
}

// The compiler loads the override with `require`, which adds the `.js`; a path
// that names no module is refused here rather than as a load error mid-build.
const geaPluginOverride = () => {
  const requested = option('--gea-plugin') ?? process.env.GEATSC2_GEA_PLUGIN
  if (!requested) return null
  const path = resolve(requested)
  if (path.endsWith('.js')) fail(`--gea-plugin ${path}: name the module without its .js, as GEATSC2_GEA_PLUGIN takes it`)
  if (!existsSync(`${path}.js`)) fail(`--gea-plugin ${path}: there is no ${path}.js`)
  return path
}

const outDir = resolve(option('--out') ?? join(root, 'measurements/three-webgpu'))
const summarizeOnly = option('--summarize')
const refusalsOnly = process.argv.includes('--refusals-only')
if (summarizeOnly && refusalsOnly)
  fail('--summarize and --refusals-only are incompatible: one reads a coverage report, the other writes none')

const gitHead = () => {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' })
  return `${result.stdout.trim()}${dirty.stdout.trim() ? ' (src modified)' : ''}`
}

/** Every live process as [pid, parent pid, working set in bytes]. */
const listProcesses = () =>
  new Promise((done) => {
    const [command, args] =
      process.platform === 'win32'
        ? [
            'powershell',
            [
              '-NoProfile',
              '-Command',
              'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'
            ]
          ]
        : ['ps', ['-A', '-o', 'pid=,ppid=,rss=']]
    const lister = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    lister.stdout.on('data', (chunk) => (text += chunk))
    lister.on('close', () =>
      done(
        text
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter((fields) => fields.length === 3 && fields.every(Number.isFinite))
          .map(([pid, ppid, size]) => [pid, ppid, process.platform === 'win32' ? size : size * 1024])
      )
    )
    lister.on('error', () => done([]))
  })

/** The pids of `pid` and everything below it, with their summed working set. */
const treeOf = async (pid) => {
  const processes = await listProcesses()
  const members = new Set([pid])
  for (let grown = true; grown;) {
    grown = false
    for (const [child, parent] of processes)
      if (members.has(parent) && !members.has(child)) {
        members.add(child)
        grown = true
      }
  }
  const bytes = processes.filter(([member]) => members.has(member)).reduce((sum, [, , size]) => sum + size, 0)
  return { pids: [...members], bytes }
}

const stopTree = (child, pids) => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else
    for (const pid of pids.reverse())
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
}

// Preloaded into every node process of a run through NODE_OPTIONS: at exit it
// reports the process's argv, its own peak resident set (on Windows, the peak
// working set) and the V8 heap. geatsc is a grandchild of this script under the
// build, and its argv is also where the build's plugin list is read back from.
const peakReporter = `import v8 from 'node:v8'
process.on('exit', () => {
  const heap = v8.getHeapStatistics()
  process.stderr.write('[PEAK] ' + JSON.stringify({ argv: process.argv.slice(1), maxRssBytes: process.resourceUsage().maxRSS * 1024, heapTotalBytes: heap.total_heap_size, heapUsedBytes: heap.used_heap_size }) + '\\n')
})`
const peakImport = `--import=data:text/javascript,${encodeURIComponent(peakReporter)}`

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`

/**
 * Runs one command with its tree watched: a status line every 30 s, the tree
 * stopped above the limit. Resolves with its exit, its wall time and its whole
 * stderr (stdout too when `mergeStdout`).
 */
const watched = async ({ label, command, args, env, stdoutFile, stderrFile, limitBytes, mergeStdout = false }) => {
  const started = Date.now()
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = createWriteStream(stdoutFile)
  const errors = stderrFile === stdoutFile ? out : createWriteStream(stderrFile)
  let stderr = ''
  let phase = 'running'
  const note = (text) => {
    const stage = [...text.matchAll(/^\[STAGE\] (\S+)/gm)].pop()
    if (stage) phase = `geatsc ${stage[1]} done`
    else if (/^compile: /m.test(text) && !phase.startsWith('geatsc')) phase = 'geatsc compiling'
    else if (/\[gea-module-graph\] pruned to/.test(text)) phase = 'module graph written'
    else if (/vite v\d/.test(text)) phase = 'vite build'
  }
  child.stdout.on('data', (chunk) => {
    out.write(chunk)
    if (mergeStdout) {
      stderr += chunk
      note(String(chunk))
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    errors.write(chunk)
    note(String(chunk))
  })
  let sampledPeak = 0
  let current = 0
  let killed = null
  let sampling = false
  const sampler = setInterval(async () => {
    if (sampling) return
    sampling = true
    const tree = await treeOf(child.pid)
    sampling = false
    current = tree.bytes
    sampledPeak = Math.max(sampledPeak, tree.bytes)
    if (tree.bytes > limitBytes && killed === null) {
      killed = tree.bytes
      stopTree(child, tree.pids)
    }
  }, 5000)
  const status = setInterval(() => {
    say(`${label}: ${((Date.now() - started) / 1000).toFixed(0)} s, ${phase}, working set ${gb(current)} (peak ${gb(sampledPeak)})`)
  }, 30000)
  const exit = await new Promise((resolveExit) => child.on('close', (code, signal) => resolveExit({ code, signal })))
  clearInterval(sampler)
  clearInterval(status)
  await Promise.all([new Promise((done) => out.end(done)), errors === out ? null : new Promise((done) => errors.end(done))])
  const wallMs = Date.now() - started
  say(`${label}: finished in ${(wallMs / 1000).toFixed(0)} s, exit ${exit.code ?? exit.signal}`)
  if (killed !== null) say(`${label}: stopped at ${gb(killed)} working set`)
  return { exit, wallMs, stderr, sampledPeak, killed }
}

const peaksIn = (stderr) =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[PEAK] '))
    .map((line) => JSON.parse(line.slice('[PEAK] '.length)))
const stagesIn = (stderr) =>
  [...stderr.matchAll(/^\[STAGE\] (\S+)\s+(\d+)ms/gm)].map((match) => ({ stage: match[1], ms: Number(match[2]) }))
const isGeatsc = (peak, command) => resolve(peak.argv[0] ?? '') === join(root, 'dist/cli.js') && peak.argv[1] === command

/**
 * The app the build is run on. Rewritten in place, never removed: its
 * `node_modules` entries are links into the two packages, and a recursive
 * delete is the one operation here that must never follow them.
 */
const stageApp = (appDir, three, webgpu) => {
  mkdirSync(join(appDir, 'node_modules/@geastack'), { recursive: true })
  writeFileSync(join(appDir, 'entry.ts'), readFileSync(join(fixture, 'entry.ts')))
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'three-webgpu-coverage',
        private: true,
        type: 'module',
        dependencies: { three: three.version, '@geastack/native-webgpu': webgpu.version }
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(appDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          allowJs: true,
          checkJs: true,
          maxNodeModuleJsDepth: 100
        },
        include: ['entry.ts']
      },
      null,
      2
    )}\n`
  )
  for (const [link, target] of [
    ['node_modules/three', three.dir],
    ['node_modules/@geastack/native-webgpu', webgpu.dir]
  ]) {
    const path = join(appDir, link)
    let present = null
    try {
      present = lstatSync(path)
    } catch {}
    if (present && !present.isSymbolicLink()) fail(`${path} exists and is not a link; remove it by hand`)
    if (present) unlinkSync(path)
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/** What the build's module graph kept, by top-level directory of each package. */
const describeGraph = (graphFile, packageDirs) => {
  const graph = JSON.parse(readFileSync(graphFile, 'utf8'))
  const byArea = new Map()
  for (const module of graph.modules) {
    const file = resolve(module.file ?? module.id)
    let area = 'app'
    for (const [label, dir] of Object.entries(packageDirs)) {
      if (!file.startsWith(dir)) continue
      const parts = relative(dir, file).replace(/\\/g, '/').split('/')
      area = `${label}/${parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]}`
    }
    byArea.set(area, (byArea.get(area) ?? 0) + 1)
  }
  return { modules: graph.modules.length, byArea: Object.fromEntries([...byArea].sort()) }
}

// `report()` in the compiler's `cli-emit.ts` prints one line per root
// diagnostic: two spaces, `file:line:column: message` (or the component id when
// there is no position).
const pipelineRootsIn = (stderr) => {
  const header = stderr.match(/^compile: no certificate; (\d+) capability refusal\(s\), (\d+) diagnostic\(s\)$/m)
  const roots = []
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/^ {2}(\S.*?):(\d+):(\d+): (.*)$/)
    if (match) roots.push({ file: resolve(match[1]), line: Number(match[2]), column: Number(match[3]), message: match[4] })
  }
  return { capabilityRefusals: header ? Number(header[1]) : null, diagnostics: header ? Number(header[2]) : null, roots }
}

/**
 * The build's root diagnostics read against coverage's root rows: the code of
 * each of the build's roots (from the coverage row at the same position with
 * the same folded message), and what either compile reports alone.
 */
const compareRoots = (pipelineRoots, coverageRows) => {
  const key = (row) => `${resolve(row.file)}|${row.line}|${row.column}|${reasonOf(row.message.split(/\r?\n/)[0])}`
  const pending = new Map()
  for (const row of pipelineRoots) pending.set(key(row), (pending.get(key(row)) ?? 0) + 1)
  const pipelineByCode = new Map()
  const onlyInCoverage = new Map()
  let coverageRoots = 0
  for (const row of coverageRows) {
    if (row.file === null || !['refused', 'typecheck'].includes(row.status)) continue
    for (let copy = 0; copy < row.count; copy += 1) {
      coverageRoots += 1
      const left = pending.get(key(row)) ?? 0
      if (left > 0) {
        pending.set(key(row), left - 1)
        pipelineByCode.set(row.code, (pipelineByCode.get(row.code) ?? 0) + 1)
        continue
      }
      const group = `${row.code}|${reasonOf(row.message)}`
      onlyInCoverage.set(group, (onlyInCoverage.get(group) ?? 0) + 1)
    }
  }
  return {
    pipelineRoots: pipelineRoots.length,
    coverageRoots,
    pipelineByCode: Object.fromEntries([...pipelineByCode].sort()),
    onlyInPipeline: [...pending].flatMap(([row, count]) => Array(count).fill(row)),
    onlyInCoverage: [...onlyInCoverage].sort().map(([group, count]) => ({ code: group.slice(0, 5), reason: group.slice(6), count }))
  }
}

const compileOnce = async () => {
  const three = packageAt('THREE_DIR', option('--three') ?? process.env.THREE_DIR, 'three', 'src/renderers/webgpu/WebGPURenderer.js')
  const webgpu = packageAt(
    'NATIVE_WEBGPU_DIR',
    option('--native-webgpu') ?? process.env.NATIVE_WEBGPU_DIR,
    '@geastack/native-webgpu',
    'geatsc-plugin.mjs'
  )
  const core = packageAt(
    'GEA_CORE_DIR',
    option('--gea-core') ?? process.env.GEA_CORE_DIR,
    '@geastack/core',
    'scripts/build-gea-vite-geatsc.mjs'
  )
  const cli = join(root, 'dist/cli.js')
  if (!existsSync(cli)) fail('dist/cli.js is missing; run `npm run build` first')
  const limitBytes = Number(option('--memory-limit-gb') ?? 11) * 1024 ** 3
  const packageDirs = { three: three.dir, 'native-webgpu': webgpu.dir }
  const geaPlugin = geaPluginOverride()
  const pluginEnv = geaPlugin === null ? {} : { GEATSC2_GEA_PLUGIN: geaPlugin }

  mkdirSync(outDir, { recursive: true })
  const appDir = join(outDir, 'app')
  const generated = join(outDir, 'generated')
  stageApp(appDir, three, webgpu)

  const nodeOptions = [process.env.NODE_OPTIONS, peakImport].filter(Boolean).join(' ')
  const pipelineArgs = [
    join(core.dir, 'scripts/build-gea-vite-geatsc.mjs'),
    '--app-dir',
    appDir,
    '--entry',
    'entry.ts',
    '--out-dir',
    generated,
    '--geatsc-bin',
    cli,
    '--no-apple-native',
    '--gea-embedded-compat',
    '--compile-module-graph',
    '--extra-geatsc-plugin',
    join(webgpu.dir, 'geatsc-plugin.mjs')
  ]
  say(`running gea's build on ${appDir}`)
  const pipelineLog = join(outDir, 'pipeline.log')
  const pipeline = await watched({
    label: 'pipeline',
    command: process.execPath,
    args: pipelineArgs,
    env: { ...process.env, ...pluginEnv, NODE_OPTIONS: nodeOptions, GEA_STAGE_TIMING: '1', GEA_WEBGL_PLUGIN: '0' },
    stdoutFile: pipelineLog,
    stderrFile: pipelineLog,
    limitBytes,
    mergeStdout: true
  })
  const pipelinePeaks = peaksIn(pipeline.stderr)
  const graphGeatsc = pipelinePeaks.find((peak) => isGeatsc(peak, 'compile-module-graph'))
  const graphFile = join(generated, 'module-graph/gea-module-graph.json')
  if (!existsSync(graphFile)) fail(`the build wrote no module graph (${graphFile}); see ${pipelineLog}`)
  if (!graphGeatsc) fail(`the build ran no geatsc compile-module-graph that reported at exit; see ${pipelineLog}`)
  const reported = pipelineRootsIn(pipeline.stderr)

  // The build's own geatsc argv: its plugins and plugin options, in order, and
  // the staged entry it compiled.
  const geatscArgv = graphGeatsc.argv.slice(2)
  const argument = (name) => geatscArgv[geatscArgv.indexOf(name) + 1]
  const stagedEntry = resolve(argument('--entry'))
  const stagedProject = join(dirname(stagedEntry), 'tsconfig.json')
  const pluginArgs = []
  for (let index = 0; index < geatscArgv.length; index += 1)
    if (geatscArgv[index] === '--plugin' || geatscArgv[index] === '--plugin-option') pluginArgs.push(geatscArgv[index], geatscArgv[++index])

  const run = {
    date: new Date().toISOString(),
    compiler: gitHead(),
    machine: `${hostname()}, ${process.platform} ${process.arch}, ${cpus()[0]?.model.trim() ?? '?'} x${cpus().length}, ${(totalmem() / 1024 ** 3).toFixed(0)} GB, node ${process.version}`,
    three: `${three.version} (${three.dir})`,
    nativeWebgpu: `${webgpu.version} (${webgpu.dir})`,
    geaCore: `${core.version} (${core.dir})`,
    geaPlugin: geaPlugin ?? 'installed @geastack/geatsc-plugin-gea/host-shims',
    packageDirs,
    pipeline: {
      args: pipelineArgs,
      exitCode: pipeline.exit.code,
      killedAboveBytes: pipeline.killed,
      wallMs: pipeline.wallMs,
      sampledTreePeakBytes: pipeline.sampledPeak,
      moduleGraph: describeGraph(graphFile, packageDirs),
      geatsc: {
        argv: graphGeatsc.argv,
        peakRssBytes: graphGeatsc.maxRssBytes,
        heapAtExit: { totalBytes: graphGeatsc.heapTotalBytes, usedBytes: graphGeatsc.heapUsedBytes },
        stages: stagesIn(pipeline.stderr)
      },
      ...reported
    }
  }
  if (refusalsOnly) {
    writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)
    return { record: run, reportFile: null }
  }

  const args = [
    '--max-old-space-size=16384',
    peakImport,
    cli,
    'coverage',
    stagedEntry,
    '--project',
    stagedProject,
    '--no-webgl-plugin',
    ...pluginArgs,
    '--json'
  ]
  say('running geatsc coverage over the staged entry')
  const coverage = await watched({
    label: 'coverage',
    command: process.execPath,
    args,
    env: { ...process.env, ...pluginEnv, GEA_STAGE_TIMING: '1', GEA_WEBGL_PLUGIN: '0' },
    stdoutFile: join(outDir, 'coverage.json'),
    stderrFile: join(outDir, 'stderr.log'),
    limitBytes
  })
  const coveragePeak = peaksIn(coverage.stderr).find((peak) => isGeatsc(peak, 'coverage'))

  const record = {
    ...run,
    // The coverage compile's own fields keep the names the summary has always
    // read, so `--summarize` over an older run.json still renders.
    exitCode: coverage.exit.code,
    signal: coverage.exit.signal,
    killedAboveBytes: coverage.killed,
    wallMs: coverage.wallMs,
    peakRssBytes: coveragePeak?.maxRssBytes ?? coverage.sampledPeak,
    heapAtExit: coveragePeak ? { totalBytes: coveragePeak.heapTotalBytes, usedBytes: coveragePeak.heapUsedBytes } : null,
    stages: stagesIn(coverage.stderr)
  }
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  return { record, reportFile: join(outDir, 'coverage.json') }
}

// A message with its source positions and interned ids folded, so the same
// refusal at two sites, or in two runs, is one reason. Ids are the compiler's
// (`op|node|f606|...`, `decl|f12|3`, `type|4411`, `Node@1` keeps its ordinal
// because the ordinal says WHICH declaration of the name was bound).
const reasonOf = (message) =>
  message
    .replace(/[A-Za-z]:[\\/][^\s:()'"]+/g, '<path>')
    .replace(/(?:\/[^\s:()'"/]+){2,}/g, '<path>')
    .replace(/<path>:\d+:\d+/g, '<path>')
    .replace(/\b(f|n|r|op|node|decl|type|s|t|v|fn|b|c)(\d+)\b/g, '$1#')
    .replace(/\|\d+\|/g, '|#|')
    .replace(/\|\d+\b/g, '|#')
    .replace(/#\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()

// Roots first, then what they block, then what compiles but boxes.
const statusOrder = ['refused', 'unsupported', 'typecheck', 'derived', 'boxed']

const shorten = (reason, width = 170) => (reason.length > width ? `${reason.slice(0, width - 1)}…` : reason)

// Files are named by package, so the summary reads the same wherever the
// packages are installed.
const summarize = (report, run) => {
  const packageDirs = Object.entries(run?.packageDirs ?? {}).map(([label, dir]) => [label, resolve(dir)])
  const fileLabel = (file) => {
    if (file === null) return '(no source position)'
    const absolute = resolve(file)
    for (const [label, dir] of packageDirs) {
      if (absolute.startsWith(dir)) return `${label}/${relative(dir, absolute).replace(/\\/g, '/')}`
    }
    return relative(root, absolute).replace(/\\/g, '/')
  }
  const rows = report.rows
  const byStatus = new Map()
  for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count)
  const codes = new Map()
  for (const row of rows) {
    const key = `${row.code}|${row.status}`
    let bucket = codes.get(key)
    if (!bucket) {
      bucket = { code: row.code, status: row.status, layer: row.layer, count: 0, reasons: new Map(), files: new Map() }
      codes.set(key, bucket)
    }
    bucket.count += row.count
    const reason = reasonOf(row.message)
    const entry = bucket.reasons.get(reason) ?? { count: 0, sites: [] }
    entry.count += row.count
    if (entry.sites.length < 3 && row.file !== null) entry.sites.push(`${fileLabel(row.file)}:${row.line}`)
    bucket.reasons.set(reason, entry)
    const file = fileLabel(row.file)
    bucket.files.set(file, (bucket.files.get(file) ?? 0) + row.count)
  }
  const rank = (status) => statusOrder.indexOf(status)
  const ordered = [...codes.values()].sort((left, right) =>
    left.status === right.status ? (left.code < right.code ? -1 : left.code > right.code ? 1 : 0) : rank(left.status) - rank(right.status)
  )
  const filesOf = (statuses) => {
    const files = new Map()
    for (const row of rows)
      if (statuses.includes(row.status)) files.set(fileLabel(row.file), (files.get(fileLabel(row.file)) ?? 0) + row.count)
    return [...files].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
  }
  const s = report.summary
  const summary = {
    run,
    totals: {
      ...s,
      boxedShare: s.carriers === 0 ? 0 : s.boxed / s.carriers,
      rowsByStatus: Object.fromEntries([...byStatus].sort())
    },
    codes: ordered.map((bucket) => ({
      code: bucket.code,
      status: bucket.status,
      layer: bucket.layer,
      count: bucket.count,
      reasons: [...bucket.reasons]
        .sort((left, right) => right[1].count - left[1].count || (left[0] < right[0] ? -1 : 1))
        .map(([reason, entry]) => ({ reason, count: entry.count, sites: entry.sites })),
      files: [...bucket.files].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).slice(0, 5)
    })),
    topFiles: {
      refused: filesOf(['refused', 'unsupported', 'typecheck']).slice(0, 15),
      derived: filesOf(['derived']).slice(0, 10),
      boxed: filesOf(['boxed']).slice(0, 10)
    },
    roots: run?.pipeline ? compareRoots(run.pipeline.roots, rows) : null
  }
  return summary
}

const renderPipeline = (run, roots) => {
  const { pipeline } = run
  const { geatsc, moduleGraph } = pipeline
  const lines = []
  lines.push(`  @geastack/core ${run.geaCore}`)
  lines.push(
    `  pipeline: build-gea-vite-geatsc.mjs --gea-embedded-compat --compile-module-graph, wall ${(pipeline.wallMs / 1000).toFixed(0)} s, ` +
      `exit ${pipeline.exitCode}${pipeline.killedAboveBytes ? ` (stopped at ${gb(pipeline.killedAboveBytes)})` : ''}`
  )
  lines.push(
    `  module graph: ${moduleGraph.modules} modules: ` +
      Object.entries(moduleGraph.byArea)
        .map(([area, count]) => `${area} ${count}`)
        .join(', ')
  )
  lines.push(
    `  compile-module-graph: peak working set ${gb(geatsc.peakRssBytes)}, heap at exit ${gb(geatsc.heapAtExit.usedBytes)} used; ` +
      `${pipeline.diagnostics ?? '?'} diagnostic(s), ${pipeline.roots.length} root(s) printed, ${pipeline.capabilityRefusals ?? '?'} capability refusal(s)`
  )
  if (geatsc.stages.length > 0)
    lines.push(`    stages: ${geatsc.stages.map((stage) => `${stage.stage} ${(stage.ms / 1000).toFixed(1)}s`).join(', ')}`)
  if (roots) {
    const alone = roots.onlyInCoverage.reduce((sum, group) => sum + group.count, 0)
    lines.push(
      `  the build's ${roots.pipelineRoots} root(s) by the code of the same row in coverage: ` +
        Object.entries(roots.pipelineByCode)
          .map(([rowCode, count]) => `${rowCode} ${count}`)
          .join(', ') +
        (roots.onlyInPipeline.length > 0 ? `, ${roots.onlyInPipeline.length} with no coverage row (summary.json)` : '')
    )
    lines.push(`  coverage's ${roots.coverageRoots} positioned root(s): ${alone === 0 ? 'no other' : `${alone} the build does not report`}`)
    for (const group of roots.onlyInCoverage)
      lines.push(`    ${String(group.count).padStart(4)}  ${group.code}  ${shorten(group.reason, 150)}`)
  }
  lines.push('  coverage over the staged entry:')
  return lines
}

const renderSummary = (summary, reasonsPerCode = 6) => {
  const lines = []
  const { run, totals } = summary
  if (run) {
    lines.push(`three WebGPURenderer coverage  ${run.date.slice(0, 10)}  compiler ${run.compiler}`)
    lines.push(`  machine: ${run.machine}`)
    lines.push(`  three ${run.three}`)
    lines.push(`  native-webgpu ${run.nativeWebgpu}`)
    if (run.pipeline) lines.push(...renderPipeline(run, summary.roots))
    lines.push(
      `  wall ${(run.wallMs / 1000).toFixed(0)} s, peak working set ${gb(run.peakRssBytes)}` +
        (run.heapAtExit ? `, heap at exit ${gb(run.heapAtExit.usedBytes)} used / ${gb(run.heapAtExit.totalBytes)} committed` : '') +
        `, exit ${run.exitCode}${run.killedAboveBytes ? ` (stopped at ${gb(run.killedAboveBytes)})` : ''}`
    )
    if (run.stages.length > 0)
      lines.push(`  stages: ${run.stages.map((stage) => `${stage.stage} ${(stage.ms / 1000).toFixed(1)}s`).join(', ')}`)
  }
  if (!totals) return `${lines.join('\n')}\n`
  lines.push('')
  lines.push(
    `operations ${totals.operations}; carriers ${totals.carriers} (${totals.native} native, ${totals.boxed} boxed, ` +
      `${(totals.boxedShare * 100).toFixed(2)}% boxed)`
  )
  lines.push(
    `refused roots ${totals.refusedRoots}, derived ${totals.derived}, unsupported ${totals.unsupported}, typecheck ${totals.typecheckErrors}; ` +
      `abi ${totals.abiBlockers}, lowering ${totals.loweringBlockers}, certification ${totals.certifyRefusals}, emission ${totals.emissionRefusals}`
  )
  lines.push(totals.certified ? `certificate minted; ${totals.emittedLines} line(s) of C++` : 'certificate not minted; nothing emitted')
  lines.push(`reached: ${totals.reached ?? '(not reported by this compiler)'}`)
  lines.push(
    `rows by status: ${Object.entries(totals.rowsByStatus)
      .map(([status, count]) => `${status} ${count}`)
      .join(', ')}`
  )
  lines.push('')
  lines.push('by code:')
  for (const bucket of summary.codes) {
    lines.push(
      `  ${bucket.code}  ${bucket.status.padEnd(11)} ${bucket.layer.padEnd(30)} ${String(bucket.count).padStart(7)}  ${bucket.reasons.length} reason(s)`
    )
  }
  for (const bucket of summary.codes) {
    lines.push('')
    lines.push(`${bucket.code}  ${bucket.status.padEnd(11)} ${bucket.layer}  x${bucket.count}  (${bucket.reasons.length} reason(s))`)
    for (const reason of bucket.reasons.slice(0, reasonsPerCode)) {
      lines.push(`  ${String(reason.count).padStart(6)}  ${shorten(reason.reason)}`)
      if (reason.sites.length > 0) lines.push(`          at ${reason.sites.join(', ')}`)
    }
    if (bucket.reasons.length > reasonsPerCode) {
      const rest = bucket.reasons.slice(reasonsPerCode).reduce((sum, reason) => sum + reason.count, 0)
      lines.push(`  ${String(rest).padStart(6)}  … ${bucket.reasons.length - reasonsPerCode} more reason(s) in summary.json`)
    }
    lines.push(`          files: ${bucket.files.map(([file, count]) => `${file} ${count}`).join(', ')}`)
  }
  for (const [label, files] of Object.entries(summary.topFiles)) {
    if (files.length === 0) continue
    lines.push('')
    lines.push(`top files, ${label}:`)
    for (const [file, count] of files) lines.push(`  ${String(count).padStart(6)}  ${file}`)
  }
  return `${lines.join('\n')}\n`
}

let record = null
let reportFile
if (summarizeOnly) {
  reportFile = resolve(summarizeOnly)
  const beside = join(dirname(reportFile), 'run.json')
  if (existsSync(beside)) record = JSON.parse(readFileSync(beside, 'utf8'))
} else {
  ;({ record, reportFile } = await compileOnce())
}
if (reportFile === null) {
  process.stdout.write(`${renderPipeline(record, null).slice(0, -1).join('\n')}\n`)
  process.exit(0)
}
let report
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'))
} catch (error) {
  if (record) process.stderr.write(renderSummary({ run: record, totals: null, codes: [], topFiles: {} }))
  fail(`no complete coverage report in ${reportFile} (${error instanceof Error ? error.message : String(error)}); see stderr.log beside it`)
}
const summary = summarize(report, record)
writeFileSync(join(dirname(reportFile), 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
const text = renderSummary(summary)
writeFileSync(join(dirname(reportFile), 'summary.txt'), text)
process.stdout.write(text)
