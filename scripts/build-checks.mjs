// The checks `npm run build` runs once dist/ is built. Each reads dist/ and
// nothing another one writes, so they run at once: chained, they kept one core
// busy for minutes of a release check. A check's output is printed when it
// finishes, whole, so concurrent checks never interleave.
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

const failed = []
await Promise.all(
  checks.map(
    (argv) =>
      new Promise((done) => {
        const name = argv.slice(argv[0] === 'npm' ? 2 : 1).join(' ')
        const started = Date.now()
        // npm is a .cmd on Windows, which only a shell can start.
        const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
        let text = ''
        child.stdout.on('data', (chunk) => (text += chunk))
        child.stderr.on('data', (chunk) => (text += chunk))
        child.on('close', (status) => {
          const seconds = Math.round((Date.now() - started) / 1000)
          if (status !== 0) {
            failed.push(name)
            console.error(`${text}FAIL ${name} (${seconds}s, exit ${status})`)
          } else console.log(`pass ${name} (${seconds}s)`)
          done()
        })
      })
  )
)
if (failed.length) {
  console.error(`build checks failed: ${failed.join(', ')}`)
  process.exit(1)
}
