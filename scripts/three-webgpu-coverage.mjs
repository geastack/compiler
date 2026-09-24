// Coverage of three.js's own WebGPURenderer, compiled from three's source with
// nothing edited, and a stable summary of what refuses.
//
//   THREE_DIR=<three package> NATIVE_WEBGPU_DIR=<@geastack/native-webgpu checkout> \
//     node scripts/three-webgpu-coverage.mjs [--three <dir>] [--native-webgpu <dir>]
//     [--out <dir>] [--memory-limit-gb <n>] [--summarize <coverage.json>]
//
// The program is `test/fixtures/three-webgpu/entry.ts`: a scene, a camera, a
// box with a node material, and `renderer.render(scene, camera)`. It runs
// `geatsc coverage` over it with the plugin list an app of three's
// WebGPURenderer on native-webgpu builds with:
//
// - `--no-webgl-plugin`, so native-webgl-angle's three.js text patches, its
//   `// @ts-nocheck` prefixes and its absent `self` stay out of the program;
// - `test/fixtures/three-webgpu/unchecked-three.mjs`, stating `three/src/**`
//   unchecked, which is what those prefixes were for;
// - the facade's own plugin (`geatsc-plugin.mjs`), which realizes
//   `navigator.gpu`, the `GPU*` flag namespaces and `self`.
//
// Neither package is a dependency of the compiler, so both are named by the
// caller. The generated tsconfig maps `three/webgpu` to `src/Three.WebGPU.js`,
// the module three bundles into `build/three.webgpu.js`: the bundles
// (88k lines, plus the `three.core.js` they import) ship no source maps, so a
// refusal in them names no source file, and `three/src/**` would not cover
// them. `@geastack/native-webgpu` is mapped to the checkout's entry, so the
// imports the facade's plugin writes into three's files resolve wherever three
// is installed.
//
// Everything lands in `--out` (default `measurements/three-webgpu/`):
// `coverage.json` (the complete `coverage --json` report), `stderr.log` (the
// compiler's stderr with `GEA_STAGE_TIMING`), `summary.json` and `summary.txt`.
// The summary is grouped by code and, within a code, by the message with its
// source positions and interned ids folded, so two runs over the same compiler
// print the same groups; only the header (date, time, memory) moves.
// `--summarize` re-reads a `coverage.json` without compiling.
//
// One compile takes several GB. The child's working set is sampled every few
// seconds and the child is stopped above `--memory-limit-gb` (default 11); the
// peak the summary reports is the child's own `maxRSS` at exit.

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const outDir = resolve(option('--out') ?? join(root, 'measurements/three-webgpu'))
const summarizeOnly = option('--summarize')

const gitHead = () => {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' })
  return `${result.stdout.trim()}${dirty.stdout.trim() ? ' (src modified)' : ''}`
}

/** The child's current working set in bytes, or null once it is gone. */
const workingSetOf = (pid) => {
  if (process.platform === 'win32') {
    const listed = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    const fields = listed.stdout.trim().split('","')
    if (fields.length < 5) return null
    return Number(fields[4].replace(/\D/g, '')) * 1024
  }
  const listed = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
  const kb = Number(listed.stdout.trim())
  return listed.status === 0 && kb > 0 ? kb * 1024 : null
}

// Loaded into the child with --import: at exit it reports the process's own
// peak resident set (on Windows, the peak working set) and the V8 heap.
const peakReporter = `import v8 from 'node:v8'
process.on('exit', () => {
  const heap = v8.getHeapStatistics()
  process.stderr.write('[PEAK] ' + JSON.stringify({ maxRssBytes: process.resourceUsage().maxRSS * 1024, heapTotalBytes: heap.total_heap_size, heapUsedBytes: heap.used_heap_size, mallocedPeakBytes: heap.peak_malloced_memory }) + '\\n')
})`

const compileOnce = async () => {
  const three = packageAt('THREE_DIR', option('--three') ?? process.env.THREE_DIR, 'three', 'src/Three.WebGPU.js')
  const webgpu = packageAt(
    'NATIVE_WEBGPU_DIR',
    option('--native-webgpu') ?? process.env.NATIVE_WEBGPU_DIR,
    '@geastack/native-webgpu',
    'geatsc-plugin.mjs'
  )
  const cli = join(root, 'dist/cli.js')
  if (!existsSync(cli)) fail('dist/cli.js is missing; run `npm run build` first')
  const limitBytes = Number(option('--memory-limit-gb') ?? 11) * 1024 ** 3

  mkdirSync(outDir, { recursive: true })
  const entry = join(fixture, 'entry.ts')
  const project = join(outDir, 'tsconfig.json')
  const slash = (path) => path.replace(/\\/g, '/')
  writeFileSync(
    project,
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
          paths: {
            'three/webgpu': [slash(join(three.dir, 'src/Three.WebGPU.js'))],
            '@geastack/native-webgpu': [slash(join(webgpu.dir, 'src/nativeWebGPU.ts'))]
          }
        },
        files: [slash(entry)]
      },
      null,
      2
    )}\n`
  )

  const args = [
    '--max-old-space-size=16384',
    '--import',
    `data:text/javascript,${encodeURIComponent(peakReporter)}`,
    cli,
    'coverage',
    entry,
    '--project',
    project,
    '--no-webgl-plugin',
    '--plugin',
    join(webgpu.dir, 'geatsc-plugin.mjs'),
    '--plugin',
    join(fixture, 'unchecked-three.mjs'),
    '--json'
  ]
  const started = Date.now()
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, GEA_STAGE_TIMING: '1', GEA_WEBGL_PLUGIN: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const report = createWriteStream(join(outDir, 'coverage.json'))
  const errors = createWriteStream(join(outDir, 'stderr.log'))
  child.stdout.pipe(report)
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    errors.write(chunk)
  })
  let sampledPeak = 0
  let killed = null
  const watchdog = setInterval(() => {
    const bytes = workingSetOf(child.pid)
    if (bytes === null) return
    sampledPeak = Math.max(sampledPeak, bytes)
    if (bytes > limitBytes && killed === null) {
      killed = bytes
      child.kill()
    }
  }, 3000)
  const exit = await new Promise((resolveExit) => child.on('close', (code, signal) => resolveExit({ code, signal })))
  clearInterval(watchdog)
  await Promise.all([new Promise((done) => report.end(done)), new Promise((done) => errors.end(done))])
  const wallMs = Date.now() - started

  const peakLine = stderr.split(/\r?\n/).find((line) => line.startsWith('[PEAK] '))
  const peak = peakLine ? JSON.parse(peakLine.slice('[PEAK] '.length)) : null
  const stages = [...stderr.matchAll(/^\[STAGE\] (\S+)\s+(\d+)ms/gm)].map((match) => ({ stage: match[1], ms: Number(match[2]) }))
  const record = {
    date: new Date().toISOString(),
    compiler: gitHead(),
    machine: `${hostname()}, ${process.platform} ${process.arch}, ${cpus()[0]?.model.trim() ?? '?'} x${cpus().length}, ${(totalmem() / 1024 ** 3).toFixed(0)} GB, node ${process.version}`,
    three: `${three.version} (${three.dir})`,
    nativeWebgpu: `${webgpu.version} (${webgpu.dir})`,
    packageDirs: { three: three.dir, 'native-webgpu': webgpu.dir },
    exitCode: exit.code,
    signal: exit.signal,
    killedAboveBytes: killed,
    wallMs,
    peakRssBytes: peak?.maxRssBytes ?? sampledPeak,
    heapAtExit: peak ? { totalBytes: peak.heapTotalBytes, usedBytes: peak.heapUsedBytes } : null,
    stages
  }
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`)
  if (killed !== null) {
    process.stderr.write(`three-webgpu-coverage: stopped the compile at ${(killed / 1024 ** 3).toFixed(2)} GB working set\n`)
  }
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
    }
  }
  return summary
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`

const renderSummary = (summary, reasonsPerCode = 6) => {
  const lines = []
  const { run, totals } = summary
  if (run) {
    lines.push(`three WebGPURenderer coverage  ${run.date.slice(0, 10)}  compiler ${run.compiler}`)
    lines.push(`  machine: ${run.machine}`)
    lines.push(`  three ${run.three}`)
    lines.push(`  native-webgpu ${run.nativeWebgpu}`)
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
