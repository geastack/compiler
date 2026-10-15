// Prepares a workspace for the release suite (scripts/release-suite.mjs).
//
//   node scripts/release-setup.mjs [--reinstall]
//
// The suite runs every sibling's own checks against this checkout, so each
// sibling must be cloned beside it, installed, and built where a lane imports
// a build. This does all of it, the same way on Linux, macOS and Windows:
//
//   - clones each missing sibling from the remote this checkout came from;
//   - runs `npm ci` in every directory holding a tracked package-lock.json
//     (node-compat's apps carry their own: fastify, mongodb, hono), and a plain
//     install where a package locks nothing (parallel);
//   - builds @geastack/windows, which the Windows plugin's tests import, and
//     this compiler's dist/ when there is none.
//
// GEASTACK_ROOT names the workspace; it defaults to this checkout's parent.
// A directory already installed is left alone unless --reinstall is given.
import './host-toolchain.mjs'
import { posixShell } from './host-shell.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const compiler = resolve(import.meta.dirname, '..')
const workspace = resolve(process.env.GEASTACK_ROOT ?? dirname(compiler))
const reinstall = process.argv.includes('--reinstall')
if (process.platform === 'win32') process.env.npm_config_script_shell = posixShell

// Every checkout scripts/release-suite.mjs reads.
const siblings = [
  'core',
  'examples',
  'node-compat',
  'parallel',
  'demos',
  'cli',
  'targets',
  'simulator',
  'native-webgl-angle',
  'windows',
  'debugger',
  'apple'
]

const step = (cwd, argv) => {
  console.log(`release setup: ${cwd}: ${argv.join(' ')}`)
  // npm is a .cmd on Windows, which only a shell can start.
  const shell = process.platform === 'win32' && argv[0] === 'npm'
  const result = spawnSync(shell ? argv.join(' ') : argv[0], shell ? [] : argv.slice(1), { cwd, stdio: 'inherit', shell })
  if (result.status !== 0) throw new Error(`release setup: \`${argv.join(' ')}\` failed in ${cwd}`)
}

const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: compiler, encoding: 'utf8' }).trim()
for (const name of siblings) {
  const directory = join(workspace, name)
  if (existsSync(join(directory, '.git'))) continue
  if (existsSync(directory)) throw new Error(`release setup: ${directory} exists but is not a git checkout`)
  step(workspace, ['git', 'clone', origin.replace(/compiler(\.git)?$/, `${name}$1`), name])
}

// Installed, and from the lockfile now checked out: npm records what it
// installed in node_modules/.package-lock.json, and a pull that changes the
// lockfile leaves that record older than it.
const installed = (directory) => {
  const record = join(directory, 'node_modules', '.package-lock.json')
  const lock = join(directory, 'package-lock.json')
  if (!existsSync(record)) return existsSync(join(directory, 'node_modules')) && !existsSync(lock)
  return !existsSync(lock) || statSync(record).mtimeMs >= statSync(lock).mtimeMs
}
for (const repository of [compiler, ...siblings.map((name) => join(workspace, name))]) {
  const locks = execFileSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /(^|\/)package-lock\.json$/.test(file))
  for (const lock of locks) {
    const directory = join(repository, dirname(lock))
    if (reinstall || !installed(directory)) step(directory, ['npm', 'ci', '--no-audit', '--no-fund'])
  }
  // A package that locks nothing (parallel) installs its declared ranges.
  if (!locks.length && existsSync(join(repository, 'package.json')) && (reinstall || !installed(repository)))
    step(repository, ['npm', 'install', '--no-package-lock', '--no-audit', '--no-fund'])
}

const windowsPackage = join(workspace, 'windows/packages/geastack-windows')
if (reinstall || !existsSync(join(windowsPackage, 'dist/index.js'))) step(windowsPackage, ['npm', 'run', 'build'])
if (!existsSync(join(compiler, 'dist/cli.js'))) step(compiler, ['npm', 'run', 'build'])
console.log(`release setup: ${workspace} is ready; run GEASTACK_ROOT=${workspace} node scripts/release-suite.mjs`)
