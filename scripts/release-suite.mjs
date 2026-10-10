// The release suite: every test this compiler ships against, not only its own.
//
//   node scripts/release-suite.mjs [--only compiler,core,examples,parallel,node-compat]
//
// A compiler release is consumed by the framework (core), every example app and
// the packages built with it (parallel, node-compat). Each of those has its own
// suite, and a release that passes only `test/run.mjs` has not run them: core's
// `run-tests.sh` compiles every example app through its native pipeline, and the
// apps carry vitest suites and typechecks of their own.
//
// The sibling checkouts are supplied, never guessed: GEASTACK_ROOT is the
// directory holding compiler/, core/, examples/, parallel/ and node-compat/. A
// missing checkout FAILS the suite; it is not a reason to skip. So does any
// test that reports SKIP: a release suite that skipped a test has not run it,
// and the compiler's corpus cases, core's app pipelines and its Apple-host tests
// all skip silently without their inputs.
//
// Every command runs in a pool, one line per finished command with exact
// counts, and measurements/release-status.txt is rewritten on every change.
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer, connect } from 'node:net'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'

const compiler = resolve(import.meta.dirname, '..')
const output = join(compiler, 'measurements')
mkdirSync(output, { recursive: true })
const workspace = process.env.GEASTACK_ROOT ? resolve(process.env.GEASTACK_ROOT) : ''
const only = process.argv
  .find((argument) => argument.startsWith('--only='))
  ?.slice(7)
  .split(',')
const wanted = (lane) => !only || only.includes(lane)

const checkout = (name, marker) => {
  const directory = join(workspace, name)
  if (!workspace || !existsSync(join(directory, marker)))
    throw new Error(`release suite needs GEASTACK_ROOT set to the directory holding ${name}/ (missing ${join(directory, marker)})`)
  return directory
}

const commands = []
const hostOnly = []
// A prerequisite runs to completion before any lane but the compiler suite starts.
const prerequisites = []
const add = (lane, name, cwd, argv, env = {}) => commands.push({ lane, name, cwd, argv, env })
const first = (lane, name, cwd, argv, env = {}) => prerequisites.push({ lane, name, cwd, argv, env })

if (wanted('compiler')) {
  const examples = checkout('examples', 'apps')
  const nodeCompat = checkout('node-compat', 'apps')
  add('compiler', 'test/run.mjs (release)', compiler, ['node', 'test/run.mjs'], {
    GEA_NATIVE_RELEASE: '1',
    GEA_APPS_ROOT: examples,
    GEA_NODE_COMPAT_ROOT: nodeCompat
  })
}

if (wanted('core')) {
  // The same discovery core's run-tests.sh does -- every test_*.mjs and every
  // run-*.sh except the runner itself and the two it never runs directly -- but
  // each file is its own command, so one failure does not hide the rest.
  const examples = checkout('examples', 'apps')
  const core = checkout('core', 'packages/core/test/run-tests.sh')
  const tests = join(core, 'packages/core/test')
  const apple = join(checkout('apple', 'packages/geastack-apple/targets/macos'), 'packages/geastack-apple')
  // The app pipelines compile against the plugin, core and host of this
  // checkout -- the ones released with this compiler -- not whatever copies
  // core's node_modules last installed. A stale plugin has no spellings for
  // host APIs core added since, and every app using one is refused.
  const env = {
    GEA_GEATSC_BIN: join(compiler, 'dist/cli.js'),
    GEA_PLUGIN_DIR: join(core, 'packages/geatsc-plugin-gea'),
    GEA_CORE_DIR: join(core, 'packages/core'),
    GEA_HOST_DIR: join(core, 'packages/host'),
    GEA_THREE_AUDIO_MUTED: '1',
    GEA_APPLE_ROOT: apple,
    // The UI memory census asserts that a feature-pruned engine renders the
    // same pixels as the full one and reports what pruning saves. Both sides
    // are the engine this release ships: an installed older engine cannot link
    // against this checkout's core headers once they move past it.
    GEA_CENSUS_REFERENCE_ENGINE: join(core, 'packages/engine'),
    GEA_CENSUS_CANDIDATE_ENGINE: join(core, 'packages/engine')
  }
  // The plugin's own suite builds its dist/, which the native tests compile
  // against and write into.
  first('core', 'geatsc-plugin-gea test', join(workspace, 'core/packages/geatsc-plugin-gea'), ['npm', 'test'], {
    GEA_TEST_EXAMPLES_ROOT: examples
  })
  const notDirect = new Set(['run-tests.sh', 'run-gea-native-app-pipeline.sh', 'run-compiled-pcm-worklet.sh'])
  for (const file of readdirSync(tests).sort()) {
    if (/^test_.*\.mjs$/.test(file)) add('core', file, examples, ['node', join(tests, file)], env)
    else if (/^run-.*\.sh$/.test(file) && !notDirect.has(file)) {
      // A test that links a macOS framework cannot build anywhere else. It is
      // not skipped quietly: the summary names every one this host left unrun.
      if (process.platform !== 'darwin' && readFileSync(join(tests, file), 'utf8').includes('-framework'))
        hostOnly.push(`core: ${file} (links a macOS framework)`)
      else add('core', file, examples, ['bash', join(tests, file)], env)
    }
  }
}

if (wanted('examples')) {
  const examples = checkout('examples', 'apps')
  for (const group of ['apps', 'tools']) {
    for (const app of readdirSync(join(examples, group)).sort()) {
      const manifest = join(examples, group, app, 'package.json')
      if (!existsSync(manifest)) continue
      const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {}
      for (const script of ['test', 'test:native', 'check'])
        if (scripts[script]) add('examples', `${app} ${script}`, join(examples, group, app), ['npm', 'run', script])
    }
  }
}

if (wanted('parallel')) {
  const parallel = checkout('parallel', 'test/run-native.mjs')
  // One lane: the tests import the build, and the native runner builds every
  // fixture into the same output directory.
  add('parallel', 'build', parallel, ['npm', 'run', 'build'])
  add('parallel', 'test', parallel, ['npm', 'test'])
  add('parallel', 'refusals', parallel, ['npm', 'run', 'test:refusals'])
  add('parallel', 'native', parallel, ['node', 'test/run-native.mjs', ...(process.platform === 'linux' ? ['--host=local'] : [])])
}

// The packages released beside the compiler and core: each runs its own
// declared checks, against the candidate stack linked below.
const packageLanes = [
  ['cli', 'cli', ['check']],
  // The board tests compile their harnesses into an existing build directory.
  ['targets', 'targets', ['test'], { TMPDIR: output, GEA_TEST_BUILD_DIR: output }],
  ['simulator', 'simulator', ['check', 'test']],
  ['native-webgl-angle', 'native-webgl-angle', ['check', 'test']],
  ['windows', 'windows/packages/geatsc-plugin-windows-native', ['build', 'test']],
  ['debugger', 'debugger', ['check']],
  ['apple', 'apple/packages/geastack-apple', ['build']],
  // The repo tests import the plugin's dist/.
  ['apple', 'apple/packages/geatsc-plugin-apple-native', ['build']]
]
for (const [lane, path, scripts, env] of packageLanes) {
  if (!wanted(lane)) continue
  const directory = checkout(path, 'package.json')
  const declared = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts ?? {}
  for (const script of scripts) {
    if (!declared[script]) throw new Error(`release suite: ${path} declares no "${script}" script`)
    add(lane, `${path} ${script}`, directory, ['npm', 'run', script], env)
  }
}
// The cli's and debugger's integration tests drive a connected device or a
// running app named by environment variables, and skip without one; a few unit
// tests only mean something on another host. The rest run here, and the summary
// names each file and test left unrun.
// `notHere` maps a test name to why this host cannot run it, or to nothing.
const unitTests = (lane, path, notHere = {}) => {
  if (!wanted(lane)) return
  const directory = checkout(path, 'test')
  const files = readdirSync(join(directory, 'test'))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
  const unit = files.filter((file) => !/(^|\.)integration\.test\.mjs$/.test(file))
  for (const file of files) if (!unit.includes(file)) hostOnly.push(`${lane}: ${file} (needs a connected device or running app)`)
  const excluded = Object.entries(notHere).filter(([, reason]) => reason)
  for (const [name, reason] of excluded) hostOnly.push(`${lane}: ${name} (${reason})`)
  const skip = excluded.flatMap(([name]) => ['--test-skip-pattern', name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')])
  add(lane, `${path} unit tests`, directory, ['node', '--test', '--test-concurrency=1', ...skip, ...unit.map((file) => `test/${file}`)])
  // node:test counts a test excluded by name in its skipped total but does not
  // list it, so only a listed skip is one nobody declared.
  commands.at(-1).declaredSkips = true
}
// WSL's mirrored networking accepts a connection to a closed loopback port and
// then resets it, so a test expecting the refusal a board gives cannot see one.
const loopbackRefuses = await new Promise((done) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => {
      const socket = connect(port, '127.0.0.1')
      socket.on('connect', () => {
        socket.destroy()
        done(false)
      })
      socket.on('error', (error) => done(error.code === 'ECONNREFUSED'))
    })
  })
})
unitTests('cli', 'cli', {
  'runExternal resolves commands that exist only as a PATH shim': process.platform !== 'win32' && 'win32 only',
  'the WiFi transport streams channel-1 diagnostics frames and detects a missing server':
    !loopbackRefuses && 'this host accepts connections to closed loopback ports',
  'macOS enables LLDB symbols by default and accepts an explicit source debugging option': process.platform !== 'darwin' && 'macOS only'
})
unitTests('debugger', 'debugger', {
  // It also needs a built native app, so it is never run here.
  'native picker consumes the complete gesture and releases input on cancel/disconnect': 'needs a running macOS app'
})
// apple's own test script: every tracked test file, one command each so one
// failure does not hide the rest. A test that links a macOS framework or drives
// the Xcode toolchain, or skips itself off macOS, runs only on macOS and is
// named when it cannot run.
if (wanted('apple')) {
  const apple = checkout('apple', 'packages/geastack-apple')
  const tracked = execFileSync('git', ['ls-files'], { cwd: apple, encoding: 'utf8' }).split('\n')
  for (const file of tracked.filter((file) => /(^|\/)(test[-_][^/]*|[^/]*\.test)\.mjs$/.test(file)).sort()) {
    if (
      process.platform !== 'darwin' &&
      /-framework|xcrun|swiftc|xcodebuild|process\.platform !== 'darwin'/.test(readFileSync(join(apple, file), 'utf8'))
    )
      hostOnly.push(`apple: ${file} (needs macOS)`)
    else add('apple', file, apple, ['node', file])
  }
}

if (wanted('node-compat'))
  add('node-compat', 'test:package', checkout('node-compat', 'scripts/test-package.mjs'), ['npm', 'run', 'test:package'])

// A skip is a test that did not run. node:test reports one as `ℹ skipped N`,
// core's shell tests as a `SKIP` line.
const skipOf = (text) => text.match(/^ℹ skipped [1-9]\d*$|^.*\bSKIP\b.*$/m)?.[0]
const listedSkipOf = (text) => text.match(/^.*# SKIP$/m)?.[0]

const total = () => commands.length + prerequisites.length
const statusFile = join(output, 'release-status.txt')
const started = Date.now()
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`
const running = new Map()
const failed = []
let completed = 0
const writeStatus = () => {
  const lines = [
    `${elapsed()} elapsed`,
    `commands: ${completed}/${total()} done, ${completed - failed.length} passed, ${failed.length} failed, ${running.size} running`,
    ...[...running].map(([name, since]) => `running ${Math.round((Date.now() - since) / 1000)}s  ${name}`),
    ...failed.map((name) => `FAIL ${name}`)
  ]
  writeFileSync(`${statusFile}.tmp`, lines.join('\n') + '\n')
  renameSync(`${statusFile}.tmp`, statusFile)
}

const run = (command) =>
  new Promise((done) => {
    const label = `${command.lane}: ${command.name}`
    const since = Date.now()
    running.set(label, since)
    writeStatus()
    const child = spawn(command.argv[0], command.argv.slice(1), {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let text = ''
    let pending = ''
    child.stdout.on('data', (chunk) => {
      text += chunk
      // The compiler suite runs for most of an hour; its own progress and
      // failure lines stream through as they happen.
      if (command.lane !== 'compiler') return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (/^\[(\d+\/\d+|runtime)\]/.test(line)) console.log(`[compiler] ${line}`)
    })
    child.stderr.on('data', (chunk) => (text += chunk))
    child.on('close', (status, signal) => {
      completed++
      running.delete(label)
      const name = `${label} (${Math.round((Date.now() - since) / 1000)}s)`
      const skipped = status === 0 ? (command.declaredSkips ? listedSkipOf : skipOf)(text) : undefined
      if (status !== 0 || skipped) {
        failed.push(skipped ? `${name} -- skipped: ${skipped.trim()}` : name)
        console.error(`Running ${name}\n${text}exit=${status}, signal=${signal}`)
        console.log(`[${completed}/${total()}] FAIL ${failed.at(-1)} -- ${failed.length} failed so far, ${elapsed()}`)
      } else console.log(`[${completed}/${total()}] pass ${name}, ${failed.length} failed so far, ${elapsed()}`)
      writeStatus()
      done()
    })
  })

// The compiler suite sizes its own pool to the machine and runs beside the
// rest. Every other lane runs in order, several lanes at once; core's native
// tests are each a whole clang build, so the lanes are split by command.
const lanes = new Map()
for (const command of commands) {
  const key = command.lane === 'core' || command.lane === 'examples' ? `${command.lane}:${command.name}` : command.lane
  lanes.set(key, [...(lanes.get(key) ?? []), command])
}
const queue = [...lanes.values()]
const width = Number(process.env.RELEASE_JOBS) || Math.max(2, Math.floor(availableParallelism() / 4))
const worker = async () => {
  while (queue.length) for (const command of queue.shift()) await run(command)
}
const compilerLane = queue.findIndex((lane) => lane[0].lane === 'compiler')
const heavy = compilerLane >= 0 ? queue.splice(compilerLane, 1)[0] : []
console.log(`release suite: ${total()} commands, ${width} lanes beside the compiler suite`)
for (const name of hostOnly) console.log(`NOT RUN on ${process.platform}: ${name}`)
// The example apps resolve @geastack/* from their own node_modules: the
// versions published last, not the ones this release ships. An app written
// against a declaration the release adds then fails its typecheck, and its
// tests exercise yesterday's runtime. For the run, each package this release
// ships is replaced by a link to its checkout, and the installed copy is put
// back afterwards -- also after an interrupted run, at the next start.
const candidates = new Map([
  ['compiler', compiler],
  ...['core', 'engine', 'host', 'elements', 'geatsc-plugin-gea'].map((name) => [name, join(workspace, 'core/packages', name)]),
  ...[
    ['targets', 'targets'],
    ['simulator', 'simulator'],
    ['debugger', 'debugger'],
    ['apple', 'apple/packages/geastack-apple'],
    ['geatsc-plugin-windows-native', 'windows/packages/geatsc-plugin-windows-native']
  ].map(([name, path]) => [name, join(workspace, path)])
])
const linked = []
const restoreCandidates = () => {
  for (const { target, saved, link } of linked.splice(0).reverse()) {
    unlinkIfPresent(target)
    if (saved) renameSync(saved, target)
    else if (link) symlinkSync(link, target, 'dir')
  }
}
// rmSync refuses a link to a directory on some Node versions; unlink never follows one.
const unlinkIfPresent = (path) => lstatOrNull(path) && unlinkSync(path)
const lstatOrNull = (path) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
// Examples get every candidate. Each other tested package gets the candidates
// it already installs: the link replaces a dependency, never adds one.
const consumers = []
if (wanted('core') || wanted('examples')) consumers.push([join(workspace, 'examples'), true])
for (const [lane, path] of packageLanes) if (wanted(lane)) consumers.push([join(workspace, path), false])
if (wanted('apple')) consumers.push([join(workspace, 'apple'), false])
for (const [consumer, everything] of consumers) {
  const modules = join(consumer, 'node_modules/@geastack')
  for (const [name, source] of candidates) {
    if (!existsSync(source) || resolve(source) === resolve(consumer)) continue
    const target = join(modules, name)
    const saved = join(modules, `.${name}.installed`)
    // An interrupted run left its link and the installed copy beside it.
    if (lstatOrNull(saved)) {
      const left = lstatOrNull(target)
      if (left && !left.isSymbolicLink()) rmSync(saved, { recursive: true, force: true })
      else {
        unlinkIfPresent(target)
        renameSync(saved, target)
      }
    }
    const installed = lstatOrNull(target)
    if (!installed && !everything) continue
    const link = installed?.isSymbolicLink() ? readlinkSync(target) : undefined
    if (installed && !link) renameSync(target, saved)
    else unlinkIfPresent(target)
    mkdirSync(modules, { recursive: true })
    symlinkSync(source, target, 'dir')
    linked.push({ target, saved: lstatOrNull(saved) ? saved : undefined, link })
    console.log(`candidate: ${consumer}: @geastack/${name} -> ${source}`)
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    restoreCandidates()
    process.exit(1)
  })

const others = async () => {
  for (const command of prerequisites) await run(command)
  await Promise.all(Array.from({ length: width }, worker))
}
try {
  await Promise.all([
    (async () => {
      for (const command of heavy) await run(command)
    })(),
    others()
  ])
} finally {
  restoreCandidates()
}
console.log(`${completed} release commands: ${completed - failed.length} passed, ${failed.length} failed`)
for (const name of failed) console.error(`FAIL ${name}`)
for (const name of hostOnly) console.log(`NOT RUN on ${process.platform}: ${name}`)
process.exitCode = failed.length ? 1 : 0
