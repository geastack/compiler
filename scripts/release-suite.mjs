// The release suite: every test this compiler ships against, not only its own.
//
//   node scripts/release-suite.mjs [--only=compiler,core,examples,parallel,node-compat,perf]
//
// Every sibling must be a checkout with its packages installed. One command
// prepares a fresh workspace -- clones what is missing, installs every locked
// package and builds what the lanes import:
//
//   node scripts/release-setup.mjs
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
import './host-toolchain.mjs'
import { posixShell } from './host-shell.mjs'
import { assertLfCheckout } from './checkout-line-ends.mjs'
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
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'

const compiler = resolve(import.meta.dirname, '..')
assertLfCheckout(compiler)
const output = join(compiler, 'measurements')
mkdirSync(output, { recursive: true })
const workspace = process.env.GEASTACK_ROOT ? resolve(process.env.GEASTACK_ROOT) : ''
// The siblings' npm scripts are POSIX shell, which npm runs in cmd.exe on
// Windows unless told otherwise.
if (process.platform === 'win32') process.env.npm_config_script_shell = posixShell
const onlyAt = process.argv.findIndex((argument) => argument === '--only' || argument.startsWith('--only='))
const only = onlyAt < 0 ? undefined : (process.argv[onlyAt].slice(7) || process.argv[onlyAt + 1] || '').split(',')
const wanted = (lane) => !only || only.includes(lane)

const checkout = (name, marker) => {
  const directory = join(workspace, name)
  if (!workspace || !existsSync(join(directory, marker)))
    throw new Error(
      `release suite needs GEASTACK_ROOT set to the directory holding ${name}/ (missing ${join(directory, marker)}); ` +
        '`node scripts/release-setup.mjs` prepares one'
    )
  return directory
}

const commands = []
const hostOnly = []
// A prerequisite runs to completion before any lane but the compiler suite starts.
const prerequisites = []
const add = (lane, name, cwd, argv, env = {}) => commands.push({ lane, name, cwd, argv, env })
const first = (lane, name, cwd, argv, env = {}) => prerequisites.push({ lane, name, cwd, argv, env })
// A measurement runs after every other command has finished, alone: a benchmark
// beside a clang build measures the build.
const alone = []
const last = (lane, name, cwd, argv, env = {}) => alone.push({ lane, name, cwd, argv, env })

if (wanted('compiler')) {
  const examples = checkout('examples', 'apps')
  const nodeCompat = checkout('node-compat', 'apps')
  const core = checkout('core', 'packages/core/package.json')
  add('compiler', 'test/run.mjs (release)', compiler, ['node', 'test/run.mjs'], {
    GEA_NATIVE_RELEASE: '1',
    GEA_APPS_ROOT: examples,
    GEA_NODE_COMPAT_ROOT: nodeCompat,
    // The native host tests that compile core's own sources take the core
    // this release ships, never an installed copy.
    GEA_CORE: join(core, 'packages/core'),
    GEA_CORE_ROOT: core
  })
}

if (wanted('mosaico')) {
  add('mosaico', 'RISC-V GCC optimized string concatenation', compiler, ['node', 'test/string-concatenation.mjs', '--riscv'])
  const demos = checkout('demos', 'apps/axel/package.json')
  const cli = checkout('cli', 'bin/gea.mjs')
  // Build a real camera/worker app with ESP-IDF's GCC, not the desktop Clang
  // harness. Runtime headers can fail on this toolchain without moving emitted C++.
  // The build must also leave the targets checkout as it found it: the
  // component manager once rewrote the board's tracked dependencies.lock.
  const targets = join(workspace, 'targets')
  const build = [
    join(cli, 'bin/gea.mjs'),
    'build',
    '--board',
    'mosaico',
    '--app',
    'axel',
    '--boards-config',
    join(compiler, 'test/fixtures/mosaico-gcc-boards.json')
  ]
  add(
    'mosaico',
    'Axel ESP32-S31 GCC firmware',
    join(demos, 'apps/axel'),
    [
      'node',
      '-e',
      [
        `const { spawnSync, execFileSync } = require('node:child_process')`,
        `const before = execFileSync('git', ['status', '--porcelain'], { cwd: ${JSON.stringify(targets)}, encoding: 'utf8' })`,
        `if (spawnSync(process.execPath, ${JSON.stringify(build)}, { stdio: 'inherit' }).status !== 0) process.exit(1)`,
        `const after = execFileSync('git', ['status', '--porcelain'], { cwd: ${JSON.stringify(targets)}, encoding: 'utf8' })`,
        `if (after !== before) { console.error('the build changed the targets checkout:', after); process.exit(1) }`
      ].join('\n')
    ],
    {
      IDF_TOOLCHAIN: 'gcc',
      GEA_COMPILER_DIR: compiler,
      GEA_CORE_DIR: join(workspace, 'core/packages/core'),
      GEA_ENGINE_DIR: join(workspace, 'core/packages/engine'),
      GEA_PLUGIN_DIR: join(workspace, 'core/packages/geatsc-plugin-gea'),
      GEA_HOST_DIR: join(workspace, 'core/packages/host'),
      GEA_CHIPS_DIR: join(workspace, 'core/packages/chips'),
      GEA_ELEMENTS_DIR: join(workspace, 'core/packages/elements'),
      GEA_TARGETS_ROOT: join(workspace, 'targets'),
      GEA_IDF_JOBS: '2'
    }
  )
}

if (wanted('core')) {
  // The same discovery core's run-tests.sh does -- every test_*.mjs and every
  // run-*.sh except the runner itself and the two it never runs directly -- but
  // each file is its own command, so one failure does not hide the rest.
  const examples = checkout('examples', 'apps')
  const core = checkout('core', 'packages/core/test/run-tests.sh')
  const tests = join(core, 'packages/core/test')
  // Its desktop source-list tests read the Linux targets' build scripts.
  checkout('linux', 'targets/raspberry-pi-os/build-raspberry-pi-os.sh')
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
    // Core's native DOM contracts compile their fixtures with this compiler,
    // against its own runtime, and compare with core's installed jsdom.
    GEA_COMPILER_CLI: join(compiler, 'dist/cli.js'),
    GEA_COMPILER_RUNTIME: join(compiler, 'src/targets/cpp/runtime'),
    GEA_TEST_RUNTIME_HEADER: join(compiler, 'src/targets/cpp/runtime/gea_runtime.h'),
    GEA_JSDOM_PACKAGE: join(core, 'packages/core/node_modules/jsdom'),
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
  // Linux and Windows build and run the fixtures on this host; elsewhere the
  // runner ships them to its Linux build machine.
  add('parallel', 'native', parallel, ['node', 'test/run-native.mjs', ...(process.platform !== 'darwin' ? ['--host=local'] : [])])
  if (process.platform === 'win32')
    hostOnly.push('parallel: the ThreadSanitizer builds of test/run-native.mjs (clang has no ThreadSanitizer on Windows)')
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

// One real app built and run with the Windows plugin: its own checks never
// compile an app, and an app build is where core headers meet clang-cl's
// Microsoft include rules (a quoted include once resolved to a host header of
// the same name). examples' counter-jsx is built, started, screenshotted after
// its first frames and closed; it must exit 0 having drawn the screenshot.
if (wanted('windows')) {
  if (process.platform !== 'win32') hostOnly.push('windows: counter-jsx app build and run (needs Windows)')
  else {
    const examples = checkout('examples', 'apps/counter-jsx/package.json')
    const driver = join(
      checkout('windows', 'packages/geastack-windows/package.json'),
      'packages/geastack-windows/targets/win32/build-windows.mjs'
    )
    const appOutput = join(output, 'windows-app')
    const binary = join(appOutput, 'counter-jsx', 'Counter.exe')
    const screenshot = join(appOutput, 'counter-jsx.png')
    add('windows', 'counter-jsx app build + run', examples, [
      'node',
      '-e',
      [
        `const { rmSync, existsSync, statSync } = require('node:fs')`,
        `const { spawnSync } = require('node:child_process')`,
        `rmSync(${JSON.stringify(appOutput)}, { recursive: true, force: true })`,
        `const env = { ...process.env, GEA_CLI_BIN: ${JSON.stringify(join(workspace, 'cli/bin/gea.mjs'))}, ` +
          `GEA_GEATSC_BIN: ${JSON.stringify(join(compiler, 'dist/cli.js'))}, GEA_WINDOWS_OUTPUT_DIR: ${JSON.stringify(appOutput)} }`,
        `if (spawnSync(process.execPath, [${JSON.stringify(driver)}, 'counter-jsx'], { stdio: 'inherit', env }).status !== 0) process.exit(1)`,
        `const run = spawnSync(${JSON.stringify(binary)}, [], { stdio: 'inherit', timeout: 60000, env: { ...env, GEA_WINDOWS_SCREENSHOT: ${JSON.stringify(screenshot)}, GEA_WINDOWS_EXIT_AFTER_MS: '4000' } })`,
        `if (run.status !== 0) { console.error('counter-jsx exited with', run.status, run.error?.message ?? ''); process.exit(1) }`,
        `if (!existsSync(${JSON.stringify(screenshot)}) || statSync(${JSON.stringify(screenshot)}).size === 0) { console.error('counter-jsx drew no screenshot'); process.exit(1) }`
      ].join('\n')
    ])
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
// Native Linux deployment is POSIX at both ends. The client refuses a host
// without POSIX ownership and modes, since it checks its SSH identity and
// known_hosts by them; the transaction transport it streams to the device
// (src/linux/transaction.py) takes fcntl locks, kills process groups and
// checks uids and modes. On Windows the client tests could only watch it
// refuse, and the transport tests have no transport to run.
const posixClient = process.platform === 'win32' && 'native Linux deployment needs a POSIX client'
const posixTransport = process.platform === 'win32' && 'runs the device-side Linux transaction transport, which needs POSIX'
// The cli's native-link and Linux target tests read the Raspberry Pi build script.
if (wanted('cli')) checkout('linux', 'targets/raspberry-pi-os/build-raspberry-pi-os.sh')
unitTests('cli', 'cli', {
  'runExternal resolves commands that exist only as a PATH shim': process.platform !== 'win32' && 'win32 only',
  'macOS enables LLDB symbols by default and accepts an explicit source debugging option': process.platform !== 'darwin' && 'macOS only',
  'registered SSH identity is explicit, strict and isolated from ambient configuration': posixClient,
  'reviewed hook, quiet profile and registered destination refuse ambiguous authority': posixClient,
  'CLI registration and flash dry-run use native alias without network or repurposing': posixClient,
  'Node inspection and recovery dispatch use stored authority without build or local hook/artifact': posixClient,
  'actual local transport stages exact bytes, returns pending, resumes only bound protected observation': posixTransport,
  'tampered payload never reaches handler or modifies an existing release': posixTransport,
  'failed activation retains inflight state and never automatically invokes rollback': posixTransport,
  'maintenance pending does not advance mutation phases and wrong-boot observation refuses completion': posixTransport,
  'resume refuses altered staged bytes and uncertain prior mutation': posixTransport,
  'fresh release permissions are exact under restrictive inherited umask': posixTransport,
  'durable root ownership refuses a second UUID while pending and releases after protected completion': posixTransport,
  'different UUID concurrent invocation refuses before another hook side effect': posixTransport,
  'pending candidate and transition review never advance protect; authorization bytes bind exact phase': posixTransport,
  'read-only inspection and explicit rollback use stored hook and exact uncertain state authorization': posixTransport,
  'hook timeout kills and reaps its process group, preserves uncertainty and refuses automatic retry': posixTransport,
  'transport validates budget before spawn and reaps an exited-child cancellation race': posixTransport
})
unitTests('debugger', 'debugger', {
  // It also needs a built native app, so it is never run here.
  'native picker consumes the complete gesture and releases input on cancel/disconnect': 'needs a running macOS app'
})
// apple's own test script: every tracked test file, one command each so one
// failure does not hide the rest. A test that links a macOS framework or drives
// the Xcode toolchain, or refuses to run off macOS, runs only on macOS; one
// that refuses to run on Windows (POSIX signals, a BSD-style ps) runs
// everywhere else. Each is named when this host cannot run it.
if (wanted('apple')) {
  const apple = checkout('apple', 'packages/geastack-apple')
  const tracked = execFileSync('git', ['ls-files'], { cwd: apple, encoding: 'utf8' }).split('\n')
  for (const file of tracked.filter((file) => /(^|\/)(test[-_][^/]*|[^/]*\.test)\.mjs$/.test(file)).sort()) {
    const text = readFileSync(join(apple, file), 'utf8')
    if (process.platform !== 'darwin' && /-framework|xcrun|swiftc|xcodebuild|process\.platform !== 'darwin'/.test(text))
      hostOnly.push(`apple: ${file} (needs macOS)`)
    else if (process.platform === 'win32' && /process\.platform === 'win32'\) \{\s*throw/.test(text))
      hostOnly.push(`apple: ${file} (needs a POSIX host)`)
    else add('apple', file, apple, ['node', file])
  }
}

if (wanted('node-compat')) {
  const nodeCompat = checkout('node-compat', 'scripts/test-package.mjs')
  // node-compat's scripts resolve the compiler from GEA_COMPILER_DIR before
  // node_modules, so this names the candidate even where no link is made.
  const env = { GEA_COMPILER_DIR: compiler }
  add('node-compat', 'test:package', nodeCompat, ['npm', 'run', 'test:package'], env)
  // The full HTTP framework test app, compiled from source and served:
  // `test:package` checks only the package's shape, so the 1.0.29 compiler
  // released with that app failing to certify and nothing here noticed. The build must emit a binary
  // and every route must answer exactly.
  const dist = join(nodeCompat, 'apps/hono-hello/dist')
  const binary = join(dist, process.platform === 'win32' ? 'server.exe' : 'server')
  const step = (argv) => `if (spawnSync(process.execPath, ${JSON.stringify(argv)}, { stdio: 'inherit', env }).status !== 0) process.exit(1)`
  add('node-compat', 'hono-hello build + routes', nodeCompat, [
    'node',
    '-e',
    [
      `const { rmSync, existsSync } = require('node:fs')`,
      `const { spawnSync } = require('node:child_process')`,
      `const env = { ...process.env, GEA_COMPILER_DIR: ${JSON.stringify(compiler)} }`,
      `rmSync(${JSON.stringify(dist)}, { recursive: true, force: true })`,
      step(['scripts/build.mjs', 'apps/hono-hello/server.ts', '--out', 'apps/hono-hello/dist']),
      `if (!existsSync(${JSON.stringify(binary)})) { console.error('the build emitted no server binary'); process.exit(1) }`,
      step(['scripts/test-hono.mjs'])
    ].join('\n')
  ])
}

if (wanted('perf')) {
  // The HTTP servers (GeaStack raw and Hono against Node, Rust and C++) and the
  // @geastack/parallel workloads (against Rayon and a C++ pool), compared with
  // the baseline benchmarks/ records for this machine. A machine without one
  // fails: an unmeasured release has not passed this lane.
  const benchmarks = checkout('benchmarks', 'node/release-gate/perf-gate.mjs')
  // GEA_PERF_HOST names the benchmark machine (an ssh host) the gate runs on
  // instead of this one: a desktop, and a WSL VM above all, drifts too much for
  // the gate's controls. remote.sh copies the checkouts there and runs it.
  // Without it, an ssh alias `geastack-bench` in this user's ssh config is that
  // machine (`ssh -G` resolves an alias to its configured HostName).
  const benchAlias = (() => {
    try {
      const config = execFileSync('ssh', ['-G', 'geastack-bench'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return /^hostname (?!geastack-bench$)/m.test(config) ? 'geastack-bench' : undefined
    } catch {
      return undefined
    }
  })()
  const perfHost = process.env.GEA_PERF_HOST || benchAlias
  if (perfHost && process.platform !== 'win32')
    last(
      'perf',
      `HTTP and parallel performance gate on ${perfHost}`,
      benchmarks,
      ['bash', 'node/release-gate/remote.sh', '--fix-loopback'],
      {
        GEA_PERF_HOST: perfHost,
        GEASTACK_ROOT: workspace
      }
    )
  else if (process.platform === 'linux' && process.arch === 'x64')
    last('perf', 'HTTP and parallel performance gate', benchmarks, ['node', 'node/release-gate/perf-gate.mjs', '--fix-loopback'], {
      GEA_COMPILER_DIR: compiler,
      GEA_NODE_COMPAT_DIR: join(workspace, 'node-compat'),
      PARALLEL_ROOT: join(workspace, 'parallel')
    })
  else hostOnly.push('perf: the HTTP and parallel performance gate (needs Linux on x86-64)')
}

// A skip is a test that did not run. node:test reports one as `ℹ skipped N`,
// core's shell tests as a `SKIP` line.
const skipOf = (text) => text.match(/^ℹ skipped [1-9]\d*$|^.*\bSKIP\b.*$/m)?.[0]
const listedSkipOf = (text) => text.match(/^.*# SKIP$/m)?.[0]

const total = () => commands.length + prerequisites.length + alone.length
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
    const [program, ...args] = command.argv
    // npm is a .cmd on Windows, which only a shell can start; its arguments
    // here are script names, so joining them loses nothing.
    const viaShell = process.platform === 'win32' && program === 'npm'
    const child = spawn(viaShell ? ['npm', ...args].join(' ') : program === 'bash' ? posixShell : program, viaShell ? [] : args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: viaShell
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
    ['windows', 'windows/packages/geastack-windows'],
    ['geatsc-plugin-windows-native', 'windows/packages/geatsc-plugin-windows-native']
  ].map(([name, path]) => [name, join(workspace, path)])
])
// Creating a symbolic link on Windows takes a privilege an ordinary account
// does not hold (EPERM); a junction is a directory link anyone may create, and
// Node reads one back as a symbolic link.
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
// Each entry is recorded BEFORE the installed copy is moved, so a run that
// dies at any point -- a failed link, an exception, a signal -- puts back
// exactly what it touched.
const linked = []
const restoreCandidates = () => {
  for (const { target, saved, link } of linked.splice(0).reverse()) {
    try {
      const current = lstatOrNull(target)
      if (current?.isSymbolicLink()) unlinkSync(target)
      if (saved && lstatOrNull(saved)) renameSync(saved, target)
      else if (link && !lstatOrNull(target)) symlinkSync(link, target, linkType)
    } catch (error) {
      console.error(`release suite: could not restore ${target}: ${error.message}`)
      process.exitCode = 1
    }
  }
}
process.on('exit', restoreCandidates)
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
// it already installs: the link replaces a dependency, never adds one -- except
// the compiler for parallel, which declares it only as an optional peer and
// cannot build or run a fixture without one.
const consumers = []
// The Windows lane's app build (above) builds an examples app, too.
if (wanted('core') || wanted('examples') || (wanted('windows') && process.platform === 'win32'))
  consumers.push([join(workspace, 'examples'), 'all'])
// core's own tests also run the compiler core installs (its module-graph and
// app-pipeline tests spawn node_modules/@geastack/compiler directly), so the
// candidate replaces that one too: otherwise they test the last release.
if (wanted('core')) consumers.push([join(workspace, 'core/packages/core'), []])
for (const [lane, path] of packageLanes) if (wanted(lane)) consumers.push([join(workspace, path), []])
if (wanted('apple')) consumers.push([join(workspace, 'apple'), []])
if (wanted('node-compat')) consumers.push([join(workspace, 'node-compat'), []])
if (wanted('parallel')) consumers.push([join(workspace, 'parallel'), ['compiler']])
const linkCandidates = () => {
  for (const [consumer, added] of consumers) {
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
      if (!installed && added !== 'all' && !added.includes(name)) continue
      const link = installed?.isSymbolicLink() ? readlinkSync(target) : undefined
      linked.push({ target, saved: installed && !link ? saved : undefined, link })
      if (installed && !link) renameSync(target, saved)
      else unlinkIfPresent(target)
      mkdirSync(modules, { recursive: true })
      symlinkSync(source, target, linkType)
      console.log(`candidate: ${consumer}: @geastack/${name} -> ${source}`)
    }
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
  linkCandidates()
  await Promise.all([
    (async () => {
      for (const command of heavy) await run(command)
    })(),
    others()
  ])
  for (const command of alone) await run(command)
} finally {
  restoreCandidates()
}
console.log(`${completed} release commands: ${completed - failed.length} passed, ${failed.length} failed`)
for (const name of failed) console.error(`FAIL ${name}`)
for (const name of hostOnly) console.log(`NOT RUN on ${process.platform}: ${name}`)
process.exitCode = failed.length ? 1 : 0
