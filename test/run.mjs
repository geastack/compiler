import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism, freemem } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'measurements')
mkdirSync(join(output, 'cxx'), { recursive: true })
// Native tests must not put their output below the compiler's dist directory.
const env = { ...process.env, TMPDIR: output }
// Every command is its own process, so the suite is a pool. Size it by cores
// and free memory (~1 GB per concurrent compile) rather than letting a serial
// loop leave the machine idle. TEST_JOBS overrides.
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || Math.min(availableParallelism() - 2, Math.floor(freemem() / 2 ** 30) - 2, 18))
// The runtime suite is the long pole: ~1300 independent compile-link-run
// programs. Nine fixed serial shards made it ~30 minutes on a 20-core box while
// the other slots sat idle; one runner with persistent workers load-balances
// every program instead. It gets the full width: the other lanes finish long
// before it does, and a two-thirds share left a third of the cores idle for
// the whole tail. Its workers also wait on links and cache hits, so the
// third-wide pool running everything else beside it oversubscribes CPU, not
// memory -- `jobs` is already bounded by free memory.
// Measured on 20 cores with 15 workers: CPU 63-74% busy, no iowait, 5 GB of
// 19 used -- each worker spends part of every program spawning processes and
// linking, so the runtime runner oversubscribes the cores by half.
// Release mode compiles the whole runtime into every program at -O2, where a
// compile is memory-bound rather than spawn-bound (~2 GB of clang each): half
// the memory-sized `jobs`.
const runtimeJobs =
  process.env.GEA_NATIVE_RELEASE === '1' ? Math.max(1, Math.floor(jobs / 2)) : Math.max(jobs, Math.ceil(availableParallelism() * 1.5))
const width = Math.max(1, Math.ceil(jobs / 3))
const failed = []
let completed = 0
let total = 0
const suiteStarted = Date.now()
const running = new Map()
// Exact progress at any moment, whatever the caller does with stdout: one line
// per finished command, and this file rewritten on every change -- commands
// done/total, passes, failures, what is running, and how many runtime programs
// have reported (the runner prints one ok/FAIL line per program).
const statusFile = join(output, 'suite-status.txt')
const runtimeTotal = readdirSync(join(root, 'test', 'runtime')).length
let runtimeOk = 0
let runtimeFailed = 0
let runtimeFailures = []
const elapsed = () => `${Math.round((Date.now() - suiteStarted) / 1000)}s`
const writeStatus = () => {
  const lines = [
    `${elapsed()} elapsed`,
    `commands: ${completed}/${total} done, ${completed - failed.length} passed, ${failed.length} failed, ${running.size} running`,
    `runtime programs: ${runtimeOk + runtimeFailed} reported, ${runtimeOk} ok, ${runtimeFailed} failed (of ~${runtimeTotal} files)`,
    ...[...running].map(([name, started]) => `running ${Math.round((Date.now() - started) / 1000)}s  ${name}`),
    ...failed.map((name) => `FAIL ${name}`),
    ...runtimeFailures.map((name) => `FAIL runtime ${name}`)
  ]
  writeFileSync(`${statusFile}.tmp`, lines.join('\n') + '\n')
  renameSync(`${statusFile}.tmp`, statusFile)
}
const run = (args) =>
  new Promise((done) => {
    const started = Date.now()
    const label = args.join(' ')
    running.set(label, started)
    writeStatus()
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    const isRuntime = args[0] === 'scripts/run-runtime-tests.mjs'
    // Every result line is printed the moment it arrives, a failure with its
    // detail, so a failure is named while the suite runs, not after it ends.
    // Whole lines only, prefixed with the command, so lanes never interleave
    // mid-line.
    const short = isRuntime ? 'runtime' : (args.at(-1) ?? '').split('/').at(-1)
    let pending = ''
    let detail = 0
    const stream = (chunk) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        // `node --test` also prints ✖ for an expected todo failure; its real
        // failures show in the exit status, which prints the whole output below.
        const failure = /^FAIL\b/.test(line.trimStart())
        if (failure) detail = 6
        if (failure || detail-- > 0 || /^ok    /.test(line)) console.log(`[${short}] ${line}`)
      }
    }
    child.stdout.on('data', (chunk) => {
      text += chunk
      stream(chunk)
      if (!isRuntime) return
      // Counted over the whole text: a chunk can end mid-line.
      runtimeOk = (text.match(/^ok    /gm) ?? []).length
      runtimeFailed = (text.match(/^FAIL  /gm) ?? []).length
      runtimeFailures = [...text.matchAll(/^FAIL  (\S+)/gm)].map((match) => match[1])
      writeStatus()
    })
    child.stderr.on('data', (chunk) => (text += chunk))
    child.on('close', (status, signal) => {
      completed++
      if (isRuntime) finishRuntime()
      running.delete(label)
      // The duration names the suite's long pole, which is what bounds its wall time.
      const name = `${args.join(' ')} (${Math.round((Date.now() - started) / 1000)}s)`
      // Output is buffered per command so concurrent commands never interleave.
      if (status !== 0) {
        failed.push(name)
        console.error(`Running ${name}\n${text}exit=${status}, signal=${signal}`)
        console.log(`[${completed}/${total}] FAIL ${name} -- ${failed.length} failed so far, ${elapsed()}`)
      } else {
        const summary = text.split('\n').filter((line) => /^(ℹ (tests|pass|fail|skipped|todo)|\d+ programs:)/.test(line))
        console.log(`Running ${name}\n${summary.length ? summary.join('\n') : 'PASS'}`)
        console.log(`[${completed}/${total}] pass, ${failed.length} failed so far, ${running.size} running, ${elapsed()}`)
      }
      writeStatus()
      done()
    })
  })
// Each lane runs its commands in order; the pool runs `width` lanes at once.
// The runtime runner holds most of the cores while it runs, so the rest start
// `width` wide; once it finishes, the pool widens to the full `jobs` so the
// remaining commands do not trickle through a third of the machine.
let finishRuntime = () => {}
const runtimeFinished = new Promise((resolve) => (finishRuntime = resolve))
const pool = async (lanes, width) => {
  const queue = [...lanes]
  total = lanes.reduce((sum, lane) => sum + lane.length, 0)
  const worker = async () => {
    while (queue.length) for (const command of queue.shift()) await run(command)
  }
  await Promise.all([
    ...Array.from({ length: Math.min(width, queue.length) }, worker),
    runtimeFinished.then(() => Promise.all(Array.from({ length: Math.max(0, jobs - width) }, worker)))
  ])
}
const unitFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? unitFiles(file) : entry.name.endsWith('.test.js') ? [file] : []
  })
const helpers = new Set([
  'run.mjs',
  'contracts.mjs',
  'corpus-roots.mjs',
  'executable-suffix.mjs',
  'sanitizer.mjs',
  'pebble-counter-size.mjs'
])
const scripts = readdirSync(import.meta.dirname)
  .filter((file) => file.endsWith('.mjs') && !helpers.has(file))
  .sort()
// Scripts that build into the same measurements/ output (a shared native
// build directory, one fixed binary path) would clobber each other's files when
// run at once. Scripts sharing any output path are one serial lane.
const outputsOf = (file) => {
  const text = readFileSync(join(import.meta.dirname, file), 'utf8')
  const outputs = new Set([...text.matchAll(/measurements\/([\w.-]+)/g)].map((match) => match[1]))
  if (/'cxx'/.test(text) || file === 'native-build-cache.mjs') outputs.add('cxx')
  return outputs
}
const scriptLanes = []
for (const file of scripts) {
  const outputs = outputsOf(file)
  const sharing = scriptLanes.filter((lane) => [...outputs].some((output) => lane.outputs.has(output)))
  const lane = { outputs, files: [] }
  for (const other of sharing) {
    for (const output of other.outputs) lane.outputs.add(output)
    lane.files.push(...other.files)
    scriptLanes.splice(scriptLanes.indexOf(other), 1)
  }
  lane.files.push(file)
  scriptLanes.push(lane)
}
const scriptCommand = (file) => [
  join(import.meta.dirname, file),
  ...(file === 'native-build-cache.mjs' ? ['--out-dir', join(output, 'cxx')] : [])
]
// Each runtime worker builds into its own `<out-dir>/j<k>`.
const runtimeDirectory = join(output, 'cxx-runtime')
mkdirSync(runtimeDirectory, { recursive: true })
// The two long poles (runtime and oracle) first, then the longest script lanes.
await pool(
  [
    [['scripts/run-runtime-tests.mjs', '--jobs', String(runtimeJobs), '--out-dir', runtimeDirectory]],
    // The oracle suite was the tail: sized to the leftover width, it finished
    // alone on a few cores. It starts beside the runtime runner with full
    // workers; the cores oversubscribe while both run, which costs far less
    // than an idle tail (memory, not CPU, is the limit, and stays low).
    [['scripts/run-oracle-tests.mjs', '--workers', String(process.env.GEA_NATIVE_RELEASE === '1' ? runtimeJobs : jobs)]],
    ...scriptLanes.map((lane) => lane.files.sort().map(scriptCommand)).sort((a, b) => b.length - a.length),
    ...unitFiles(join(root, 'dist'))
      .sort()
      .map((file) => [['--test', file]])
  ],
  width
)
console.log(`${completed} test commands: ${completed - failed.length} passed, ${failed.length} failed`)
for (const command of failed) console.error(`FAIL ${command}`)
process.exitCode = failed.length ? 1 : 0
