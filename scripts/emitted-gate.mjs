// The emitted-set gate, as one command.
//
//   npm run gate            compare both sets against the tracked baselines
//   npm run gate -- --write rewrite the baselines from this build
//   npm run gate -- --review also diff available baseline-matched old output
//   npm run gate -- --only=corpus   the corpus half, for iterating (never a landing gate)
//   npm run gate -- --jobs=N        emit each set as N parallel shard processes (env GEA_GATE_JOBS;
//                                   default min(8, cores/2, free memory/2GB); --jobs=1 is the serial path)
//   npm run gate -- --rows          print normalized hashes for comparison with an earlier run
//
// WHY THIS EXISTS AS A SCRIPT AND NOT A RECIPE
//
// The gate was already documented, in `scripts/EMITTED-BASELINE.md`, as nine
// lines of shell. On 2026-09-07 a session landed ~20 fixes across the emitter
// and the frontend, never ran it once, and shipped SEVEN regressions -- every
// one of which this gate would have named, by program, before the runtime
// suite took twenty minutes to find them. The instrument was not missing. It
// was too long to type, so it was skipped under time pressure, which is the
// only way an instrument ever gets skipped.
//
// So: one command, non-zero exit, the changed programs printed by name.
//
// WHAT IT ANSWERS
//
// "Did my change move the emitted C++ for programs I was not thinking about?"
// Nothing else answers that. `tsc --noEmit` proves the compiler builds. The
// architecture gate proves the source obeys its rules. The runtime suite proves
// programs still behave -- but it is slow, it needs the bench box to be
// tolerable, and it tells you a fixture broke without telling you which of your
// changes moved it. This tells you, in one run, exactly which programs' output
// your edit changed. A refactor that re-homes a decision must move NOTHING.
//
// WHEN TO RUN IT
//
// After ANY change under `src/targets/` or `src/semantics/`, before you believe
// a fix works and long before you run the suite. It is the routine check; the
// suite is the slow confirmation.
//
// READING A DIFF
//
// A diff is one of exactly two things, and you must say which:
//   1. The change you are making -- then the commit names these programs and
//      says why they are the ones that should move.
//   2. A regression -- then you have just found it, cheaply, with a name.
// `drift.txt`, `printer-drift.txt` and `uncertified.txt` are reports, not
// programs; they move when the set gains or loses a program.

import { spawn } from 'node:child_process'
import { availableParallelism, freemem } from 'node:os'
import { enableCompileCache } from 'node:module'
import { normalizeEmitted } from './normalize-emitted.mjs'
import { reviewEmitted } from './review-emitted.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const write = process.argv.includes('--write')
const measurements = join(here, 'measurements')
mkdirSync(measurements, { recursive: true })
// The corpus compiles thousands of programs; a shared system TMPDIR is how
// concurrent runs delete each other's in-flight output and manufacture
// failures that look like product bugs.
process.env.TMPDIR = measurements
// Node's module compile cache: importing the compiler costs ~0.36s per process
// uncached and ~0.22s cached, and the gate imports it once per shard. The cache
// is keyed by file content, so a rebuilt `dist/` simply misses. It lives in the
// gitignored `measurements/` output dir, and is exported so spawned shards use it.
const compileCache = join(measurements, 'compile-cache')
process.env.NODE_COMPILE_CACHE = compileCache
enableCompileCache?.(compileCache)

// How many shard processes per set. Each compile can hold 1-2 GB, so memory
// bounds it as much as cores do; cap at 8 where the returns flatten.
const jobsArgument = process.argv.find((argument) => argument.startsWith('--jobs='))?.slice('--jobs='.length) ?? process.env.GEA_GATE_JOBS
const jobs =
  jobsArgument === undefined || jobsArgument === ''
    ? Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2), Math.floor(freemem() / 2 ** 31)))
    : Number(jobsArgument)
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs=${jobsArgument}: expected a positive integer`)

/** The two sets, each with the tracked baseline it is compared against. */
const allSets = [
  { name: 'corpus', args: [], baseline: join(here, 'scripts/emitted-baseline-corpus.txt') },
  { name: 'runtime', args: ['--runtime'], baseline: join(here, 'scripts/emitted-baseline-runtime.txt') }
]
// The runtime half is 318s of the gate's ~390s. That cost is right for a
// LANDING gate and wrong for the tenth iteration of one edit, which is how the
// gate ends up skipped entirely. `--only=corpus` buys a 74s regression check
// that names moved programs; it is NOT a landing gate and refuses to write a
// baseline, because a baseline taken from half the sets is a wrong baseline
// rather than a partial one.
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice('--only='.length)
if (only !== undefined && !allSets.some((set) => set.name === only))
  throw new Error(`--only=${only}: no such set (${allSets.map((set) => set.name).join(', ')})`)
if (only !== undefined && write) throw new Error('--only and --write are incompatible: a baseline must be taken from every set')
const sets = only === undefined ? allSets : allSets.filter((set) => set.name === only)

/**
 * The normalized hash of one emitted unit.
 *
 * Normalization is what makes two builds comparable at all: SSA values and
 * minted identifiers are renumbered by ordinal, so a change that only shifts
 * numbering reads as identical rather than as every program moving.
 */
const hashOf = (directory, file) => {
  const normalized = normalizeEmitted(readFileSync(join(directory, file), 'utf8'))
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

const emitEnv = { ...process.env, GEA_DIST: join(here, 'dist'), GEA_GATE_TIMING: '1' }

/** Run one emit-corpus process; resolves with its stdout, rejects on any non-zero exit or signal. */
const runEmit = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'scripts/emit-corpus.mjs'), ...args], {
      cwd: here,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: emitEnv
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', reject)
    child.on('close', (code, signal) =>
      code === 0 ? resolve(stdout) : reject(new Error(`emit-corpus ${args.join(' ')} failed (${signal ?? `exit ${code}`})`))
    )
  })

/**
 * Emit `set` into `directory`. With one job this is the original single process.
 * With N, N shard processes each take every N-th program (--shard=I/N) into their
 * own sibling directory, and the results are merged into `directory` so that
 * everything downstream (rows, hashes, diff, --review) sees exactly the layout a
 * serial run produces. Any shard failure throws: a partial set must never be
 * mistaken for a verdict.
 */
const emit = async (set, directory) => {
  if (jobs === 1) {
    process.stdout.write(await runEmit([directory, ...set.args]))
    return
  }
  const shardDirectories = Array.from({ length: jobs }, (_, index) => `${directory}-shard${index}`)
  for (const shardDirectory of shardDirectories) rmSync(shardDirectory, { recursive: true, force: true })
  const settled = await Promise.allSettled(
    shardDirectories.map((shardDirectory, index) => runEmit([shardDirectory, ...set.args, `--shard=${index}/${jobs}`]))
  )
  const failures = settled.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    for (const shardDirectory of shardDirectories) rmSync(shardDirectory, { recursive: true, force: true })
    throw new Error(
      `${set.name}: ${failures.length}/${jobs} shards failed:\n${failures.map((failure) => `  ${failure.reason.message}`).join('\n')}`
    )
  }
  mkdirSync(directory, { recursive: true })
  const reports = { 'uncertified.txt': [], 'drift.txt': [], 'printer-drift.txt': [] }
  for (const shardDirectory of shardDirectories) {
    for (const file of readdirSync(shardDirectory)) {
      if (file in reports) {
        for (const row of readFileSync(join(shardDirectory, file), 'utf8').split('\n')) {
          if (row === '') continue
          const tab = row.indexOf('\t')
          reports[file].push({ index: Number(row.slice(0, tab)), row: row.slice(tab + 1) })
        }
      } else renameSync(join(shardDirectory, file), join(directory, file))
    }
    rmSync(shardDirectory, { recursive: true, force: true })
  }
  // The report files are hashed whole and are in target order; the global target
  // index restores it (Array.sort is stable, so one program's rows keep their order).
  const render = (rows) => rows.sort((a, b) => a.index - b.index).map((entry) => entry.row)
  const uncertified = render(reports['uncertified.txt'])
  const drift = render(reports['drift.txt'])
  const printerDrift = render(reports['printer-drift.txt'])
  writeFileSync(join(directory, 'uncertified.txt'), uncertified.join('\n') + '\n')
  writeFileSync(join(directory, 'drift.txt'), drift.join('\n') + (drift.length ? '\n' : ''))
  writeFileSync(join(directory, 'printer-drift.txt'), printerDrift.join('\n') + (printerDrift.length ? '\n' : ''))
  mergeShardOutput(settled.map((result) => result.value))
}

/** Print one merged summary and one merged timing line instead of N of each. */
const mergeShardOutput = (outputs) => {
  const sum = [0, 0, 0, 0, 0]
  const timings = []
  for (const output of outputs) {
    for (const line of output.split('\n')) {
      const summary =
        /^emitted (\d+) programs, (\d+) without source, (\d+) drift rows on certified programs \((\d+) on uncertified\), (\d+) printer refusals \/ (\d+) printer conversions/.exec(
          line
        )
      if (summary) {
        for (let i = 0; i < 5; i++) sum[i] += Number(summary[i + 1])
        sum[5] = (sum[5] ?? 0) + Number(summary[6])
      }
      if (line.startsWith('[emit timing] ')) timings.push(JSON.parse(line.slice('[emit timing] '.length)))
    }
  }
  process.stdout.write(
    `emitted ${sum[0]} programs, ${sum[1]} without source, ${sum[2]} drift rows on certified programs (${sum[3]} on uncertified), ${sum[4]} printer refusals / ${sum[5]} printer conversions, across ${outputs.length} shards\n`
  )
  if (timings.length > 0)
    process.stdout.write(
      `[emit timing] ${JSON.stringify({
        programs: timings.reduce((total, t) => total + t.programs, 0),
        wallMs: Math.max(...timings.map((t) => t.wallMs)),
        cpuMs: timings.reduce((total, t) => total + t.cpuMs, 0),
        shards: timings.length,
        slowest: timings
          .flatMap((t) => t.slowest)
          .sort((a, b) => b.milliseconds - a.milliseconds)
          .slice(0, 12)
      })}\n`
    )
}

const rowsFor = async (set) => {
  // The pid is in the path because this gate is run CONCURRENTLY -- by several
  // agents in one tree, and by separate sessions. A fixed directory name meant
  // one run's `rmSync` deleted the programs another run was still hashing, so
  // both crashed with ENOENT and neither got a verdict. An instrument that
  // fails whenever two people use it at once is an instrument people stop
  // using, which is the exact failure this gate exists to prevent.
  const directory = join(measurements, `emitted-gate-${set.name}-${process.pid}`)
  rmSync(directory, { recursive: true, force: true })
  process.stderr.write(`emitting ${set.name} (${jobs} shard${jobs === 1 ? '' : 's'})...\n`)
  const started = performance.now()
  await emit(set, directory)
  const emittedAt = performance.now()
  const normalizationCpu = process.cpuUsage()
  const rows = readdirSync(directory)
    .sort()
    .map((file) => `${file} ${hashOf(directory, file)}`)
  const normalizedAt = performance.now()
  const cpu = process.cpuUsage(normalizationCpu)
  process.stderr.write(
    `[gate timing] ${set.name}: emit ${(emittedAt - started).toFixed(0)}ms, normalize ${(normalizedAt - emittedAt).toFixed(0)}ms wall/${((cpu.user + cpu.system) / 1000).toFixed(0)}ms CPU, ${rows.length} rows\n`
  )
  // Keep actionable refusal evidence visible before the generated directory is
  // removed. A changed printer-drift hash alone does not identify the program
  // or failed conversion a reviewer must investigate.
  const printerReport = join(directory, 'printer-drift.txt')
  if (existsSync(printerReport)) {
    for (const row of readFileSync(printerReport, 'utf8').split('\n')) {
      if (row.split('\t')[2] === 'refused') process.stdout.write(`printer refusal: ${row}\n`)
    }
  }
  if (process.argv.includes('--review')) {
    reviewEmitted({
      set,
      directory,
      measurements,
      rows,
      report: join(measurements, 'emitted-review.diff'),
      reset: set.name === 'corpus'
    })
  }
  rmSync(directory, { recursive: true, force: true })
  return rows
}

let failed = false
for (const set of sets) {
  const rows = await rowsFor(set)
  if (process.argv.includes('--rows')) process.stdout.write(`[gate rows] ${JSON.stringify({ set: set.name, rows })}\n`)
  if (write) {
    writeFileSync(set.baseline, `${rows.join('\n')}\n`)
    process.stdout.write(`${set.name}: wrote ${rows.length} rows to ${set.baseline}\n`)
    continue
  }
  if (!existsSync(set.baseline)) throw new Error(`${set.name}: no baseline at ${set.baseline} -- take one with --write and TRACK it`)
  const before = new Map(
    readFileSync(set.baseline, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)])
  )
  const after = new Map(rows.map((line) => [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)]))
  const moved = [...after].filter(([file, hash]) => before.has(file) && before.get(file) !== hash).map(([file]) => file)
  const gained = [...after.keys()].filter((file) => !before.has(file))
  const lost = [...before.keys()].filter((file) => !after.has(file))
  if (moved.length === 0 && gained.length === 0 && lost.length === 0) {
    process.stdout.write(`${set.name}: ${after.size} programs, byte-identical to the baseline\n`)
    continue
  }
  failed = true
  process.stdout.write(`${set.name}: ${moved.length} MOVED, ${gained.length} gained, ${lost.length} lost (of ${after.size})\n`)
  for (const file of moved) process.stdout.write(`  moved   ${file}\n`)
  for (const file of gained) process.stdout.write(`  gained  ${file}\n`)
  for (const file of lost) process.stdout.write(`  lost    ${file}\n`)
}

if (failed) {
  process.stdout.write(
    '\nThe emitted set moved. Say which of the two this is:\n' +
      '  1. the change you are making -- name these programs in the commit and say why they move\n' +
      '  2. a regression -- you have just found it, before the suite did\n' +
      'Once (1) is established, re-take the baselines with `npm run gate -- --write` IN THE SAME COMMIT.\n'
  )
  process.exit(1)
}
