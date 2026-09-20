// The emitted-set gate, as one command.
//
//   npm run gate            compare both sets against the tracked baselines
//   npm run gate -- --write rewrite the baselines from this build
//   npm run gate -- --review also diff available baseline-matched old output
//   npm run gate -- --only=corpus   the 74s half, for iterating (never a landing gate)
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

import { execFileSync } from 'node:child_process'
import { normalizeEmitted } from './normalize-emitted.mjs'
import { reviewEmitted } from './review-emitted.mjs'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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

const rowsFor = (set) => {
  // The pid is in the path because this gate is run CONCURRENTLY -- by several
  // agents in one tree, and by separate sessions. A fixed directory name meant
  // one run's `rmSync` deleted the programs another run was still hashing, so
  // both crashed with ENOENT and neither got a verdict. An instrument that
  // fails whenever two people use it at once is an instrument people stop
  // using, which is the exact failure this gate exists to prevent.
  const directory = join(measurements, `emitted-gate-${set.name}-${process.pid}`)
  rmSync(directory, { recursive: true, force: true })
  process.stderr.write(`emitting ${set.name}...\n`)
  const started = performance.now()
  execFileSync(process.execPath, [join(here, 'scripts/emit-corpus.mjs'), directory, ...set.args], {
    cwd: here,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, GEA_DIST: join(here, 'dist'), GEA_GATE_TIMING: '1' }
  })
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
  const rows = rowsFor(set)
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
