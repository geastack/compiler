// The checks `npm run build` runs once dist/ is built. Each reads dist/ and
// nothing another one writes, so they run at once: chained, they kept one core
// busy for minutes of a release check. A check's output is printed when it
// finishes, whole, so concurrent checks never interleave.
import './host-toolchain.mjs'
import { spawn } from 'node:child_process'

const checks = [
  ['npm', 'run', 'test:binding-composition'],
  ['npm', 'run', 'test:global-host-mutations'],
  ['node', 'scripts/check-runtime-header.mjs'],
  ['npm', 'run', 'test:recursive-native-carriers'],
  ['npm', 'run', 'test:dynamic-value-metadata'],
  ['node', 'test/compiler-value-contracts.mjs'],
  ['npm', 'run', 'test:declaration-overlays'],
  ['npm', 'run', 'test:hot-path-shapes'],
  ['npm', 'run', 'test:declared-integers']
]

// Keep the normal parallel release behavior, while allowing a shared desktop
// to bound memory/CPU without dropping checks or extending test timeouts.
const requestedJobs = process.env.GEATSC_BUILD_CHECK_JOBS
if (requestedJobs !== undefined && !/^[1-9]$/.test(requestedJobs)) throw new Error('GEATSC_BUILD_CHECK_JOBS must be an integer from 1 to 9')
const jobs = requestedJobs === undefined ? checks.length : Number(requestedJobs)
const failed = []
let nextCheck = 0
const run = (argv) =>
  new Promise((done) => {
    const name = argv.slice(argv[0] === 'npm' ? 2 : 1).join(' ')
    const started = Date.now()
    // npm is a .cmd on Windows, which only a shell can start.
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let text = ''
    child.stdout.on('data', (chunk) => (text += chunk))
    child.stderr.on('data', (chunk) => (text += chunk))
    child.on('error', (error) => (text += String(error)))
    child.on('close', (status) => {
      const seconds = Math.round((Date.now() - started) / 1000)
      if (status !== 0) {
        failed.push(name)
        console.error(`${text}FAIL ${name} (${seconds}s, exit ${status})`)
      } else console.log(`pass ${name} (${seconds}s)`)
      done()
    })
  })
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (nextCheck < checks.length) await run(checks[nextCheck++])
  })
)
if (failed.length) {
  console.error(`build checks failed: ${failed.join(', ')}`)
  process.exit(1)
}
