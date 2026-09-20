/**
 * The differential suite: Node is the oracle.
 *
 * `run-runtime-tests.mjs` pins what a program must print in `//! expect`
 * lines -- expectations a human wrote, and therefore expectations a human can
 * get wrong. The oracle suite asks a different question: run the SAME program
 * through this compiler and through Node, and require the two stdouts to be
 * identical. Nobody states the answer, so nobody can state it wrong, and a
 * whole class of defect that hand-written expectations quietly encode --
 * `Object.keys` in the wrong order, `-0` printed as `0`, a `Date` field
 * rounded, a `Map` iterated out of insertion order -- has nowhere to hide.
 *
 * The programs came from v1, where the suite ran under vitest as 58
 * `compiler-oracle-*.test.ts` files against `test/fixtures/`. Vitest is not
 * how this compiler is tested, so the cases are programs on disk here and the
 * runner is a script: one program per file under `test/oracle/`, discovered
 * by the import graph -- a `.ts` file no other file imports is a program, and
 * one that is imported is a module of the program that imports it.
 *
 * Each program prints, and the runner compares. Two directives ride in `//!`
 * lines at the top of a program:
 *
 *   //! dynamic-fallback                        compile with
 *       `--dynamic-fallback`, for a program whose subject genuinely is a
 *       dynamic boundary -- a `Proxy` whose traps are ordinary JavaScript is
 *       the canonical one, and this compiler admits `ProxyConstructor@1` only
 *       under that flag. It is not a way around a defect this suite should
 *       catch: the program still has to agree with Node, line for line.
 *   //! oracle-expect: <exact trimmed stdout>   a tripwire: the value both
 *       runs must produce, for the case where the compiler and the oracle
 *       regress the same way and agreeing with each other proves nothing.
 *   //! known-wrong: <text>                     a divergence that is real,
 *       understood and not yet fixed. Recorded rather than deleted -- and the
 *       runner FAILS if it stops reproducing, because a defect that fixes
 *       itself is a fact worth learning.
 *
 *   node scripts/run-oracle-tests.mjs [--dist <dir>] [--only <substring>]
 *        [--files <comma-separated relative paths>] [--list-json]
 *        [--out <json>] [--workers N] [--label <name>]
 *
 * `--list-json` prints the selection instead of running it and `--files` runs
 * exactly the named programs, which is the same contract `test262.mjs` offers
 * the cloud sweep: the manifest selects with the first and every task runs the
 * second, so a laptop slice and a cloud task are produced by one program.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const dist = resolve(flag('--dist', join(here, 'dist')))
const only = flag('--only', null)
const filesList = flag('--files', null)
const listJson = argv.includes('--list-json')
const outPath = flag('--out', null)
const workers = Math.max(1, Number(flag('--workers', '1')))
const label = flag('--label', `oracle-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`)

const root = join(here, 'test', 'oracle')
if (!existsSync(root)) {
  console.error(`no test/oracle directory at ${root}`)
  process.exit(2)
}
const project = join(root, 'tsconfig.json')

// The dialect the graph is read under. `Bundler` so a fixture's `./index.js`
// specifier resolves to `index.ts` the way it did in v1, and `allowJs` so a
// JavaScript regression can join the suite without a second code path.
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  isolatedModules: true,
  skipLibCheck: true,
  allowJs: true,
  allowImportingTsExtensions: true
}
const host = ts.createCompilerHost(compilerOptions, true)

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })

const moduleSpecifier = (node) =>
  (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null

const relativeImportsOf = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  const found = []
  source.forEachChild((node) => {
    const spec = moduleSpecifier(node)
    if (!spec?.startsWith('.')) return
    const resolved = ts.resolveModuleName(spec, file, compilerOptions, host).resolvedModule
    if (resolved && !resolved.isExternalLibraryImport) found.push(resolve(resolved.resolvedFileName))
  })
  return found
}

// A program is a file nobody imports. Stating it as a graph property rather
// than a naming convention means a fixture's helper modules need no prefix,
// no manifest and no list to keep in step with the directory.
const allFiles = walk(root)
  .map((file) => resolve(file))
  .sort()
const imported = new Set(allFiles.flatMap(relativeImportsOf))
const programs = allFiles.filter((file) => !imported.has(file)).map((file) => relative(root, file))

// `--files` is a path to a newline-separated list or the list itself, comma
// separated -- the first is what the cloud worker writes, the second is what a
// hand-run slice types.
const namedFiles = () =>
  (existsSync(filesList) ? readFileSync(filesList, 'utf8').split('\n') : filesList.split(',')).map((name) => name.trim()).filter(Boolean)
const selected = filesList ? namedFiles() : programs.filter((name) => (only ? name.includes(only) : true))

for (const name of selected) {
  if (!programs.includes(name)) {
    console.error(`not an oracle program: ${name}`)
    process.exit(2)
  }
}

if (listJson) {
  process.stdout.write(`${JSON.stringify({ files: allFiles.length, selected: selected.length, candidates: selected })}\n`)
  process.exit(0)
}

const directives = (source, name) =>
  source
    .split('\n')
    .filter((line) => line.startsWith('//!'))
    .map((line) => line.slice(3).trim())
    .filter((line) => line.startsWith(name))
    .map((line) => line.slice(name.length).replace(/^:\s?/, ''))

/**
 * A bare, colon-less flag. Line-anchored, for the reason
 * `run-runtime-tests.mjs`'s own `hasFlag` states at length: this was
 * `source.includes('//! dynamic-fallback')`, which matches the string anywhere
 * in the file, so a program that merely NAMES the directive in a comment
 * silently acquires it.
 */
const hasFlag = (source, name) =>
  source
    .split('\n')
    .filter((line) => line.startsWith('//!'))
    .some((line) => line.slice(3).trim() === name)

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      skipLibCheck: true
    },
    reportDiagnostics: false
  }).outputText

// Neither side drives `main`. The emitted C++ entry runs the program's top
// level and stops, so the Node side runs the transpiled top level and stops
// too -- a program states its own output with a top-level `console.log`, the
// way every program under `test/runtime/` does. v1's harness appended a
// `main()` call to the Node side only; every fixture that printed inline then
// printed twice under the oracle and once under the compiler, and the
// difference was the HARNESS, not the compiler.

const graphOf = (entry) => {
  const seen = new Set()
  const order = []
  const visit = (file) => {
    const abs = resolve(file)
    if (seen.has(abs)) return
    seen.add(abs)
    for (const next of relativeImportsOf(abs)) visit(next)
    order.push(abs)
  }
  visit(entry)
  return order
}

const commonDirectory = (files) => {
  const parts = files.map((file) => dirname(file).split(sep))
  let length = parts[0].length
  for (const other of parts.slice(1)) {
    length = Math.min(length, other.length)
    for (let index = 0; index < length; index++) {
      if (other[index] !== parts[0][index]) {
        length = index
        break
      }
    }
  }
  return parts[0].slice(0, length).join(sep) || sep
}

// Every case materializes the whole C++ runtime, its objects and a linked
// binary. v1's suite leaked one directory per case -- 8,836 of them, 60GB, and
// on a cgroup where page cache counts toward `memory.current` that walks a
// sweep container into an OOM-kill that reads like a compiler bug. Scope it.
const scoped = (prefix, run) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix))
  try {
    return run(dir)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort: a wedged child can still hold a handle
    }
  }
}

const runOnNode = (entry) =>
  scoped('geatsc-oracle-node-', (dir) => {
    const files = graphOf(entry)
    const base = commonDirectory(files)
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    for (const file of files) {
      const rel = relative(base, file)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`module graph escaped its root: ${file}`)
      const dest = join(dir, rel).replace(/\.tsx?$/, '.js')
      mkdirSync(dirname(dest), { recursive: true })
      const js = transpile(readFileSync(file, 'utf8'))
      writeFileSync(dest, js)
    }
    const ran = spawnSync(process.execPath, [join(dir, relative(base, resolve(entry)).replace(/\.tsx?$/, '.js'))], {
      encoding: 'utf8',
      timeout: 60_000
    })
    return { stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', status: ran.status, signal: ran.signal }
  })

// A program may state its own dialect in `<name>.tsconfig.json` beside it, the
// way `runtime-tests` already lets one -- and for one program here it is the
// difference between a defect and a faithful compile. `proxy-record-multi-trap`
// reads `target.count` off a `Record<string, number>` and merges it with a
// string default; without `noUncheckedIndexedAccess` TypeScript itself types
// that read `number`, eliminates the string arm from the `??`, and the compiler
// correctly follows the checker into a carrier the running program contradicts.
// Node prints the string. The suite-wide dialect stays off -- turned on for all
// 58 it makes a dozen v1-era programs type-invalid TypeScript, which is not a
// compiler defect either.
const projectFor = (entry) => {
  const own = entry.replace(/\.tsx?$/, '.tsconfig.json')
  return existsSync(own) ? own : project
}

const runOnGeatsc = (entry, dynamicFallback) =>
  scoped('geatsc-oracle-cpp-', (dir) => {
    const out = join(dir, 'out')
    mkdirSync(out, { recursive: true })
    const ran = spawnSync(
      process.execPath,
      [
        join(here, 'scripts', 'run-emitted.mjs'),
        entry,
        '--dist',
        dist,
        '--project',
        projectFor(entry),
        '--out-dir',
        out,
        ...(dynamicFallback ? ['--dynamic-fallback'] : [])
      ],
      { encoding: 'utf8', timeout: 600_000, env: { ...process.env, TMPDIR: dir } }
    )
    return { stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', status: ran.status, signal: ran.signal }
  })

// `run-emitted.mjs` names the phase it died in on stderr and exits 3 for a
// refusal, 4 for clang, 1 for a crash or a nonzero program. Keep the phase --
// "refused" and "segfaulted" are different defects and folding both into
// "failed" is how a sweep stops being diagnosable.
const phaseOf = (run) => {
  const stderr = run.stderr
  if (stderr.includes('EMIT FAILED') || stderr.includes('EMIT PRODUCED NO C++')) return 'refused'
  if (stderr.includes('COMPILE FAILED') || stderr.includes('LINK FAILED')) return 'clang'
  if (stderr.includes('CRASHED:')) return 'crashed'
  if (stderr.includes('EXITED ')) return 'exited'
  return run.status === 0 ? 'ran' : 'runner'
}

const head = (text, limit = 600) => {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n...` : trimmed
}

const firstDivergence = (a, b) => {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index])
      return `line ${index + 1}: geatsc ${JSON.stringify(left[index] ?? null)} vs node ${JSON.stringify(right[index] ?? null)}`
  }
  return 'stdout differs only in trailing whitespace'
}

const runCase = (name) => {
  const entry = join(root, name)
  const source = readFileSync(entry, 'utf8')
  const tripwire = directives(source, 'oracle-expect')[0] ?? null
  const wrongs = directives(source, 'known-wrong')
  const dynamicFallback = hasFlag(source, 'dynamic-fallback')
  const started = Date.now()

  const cpp = runOnGeatsc(entry, dynamicFallback)
  const phase = phaseOf(cpp)
  const node = runOnNode(entry)
  const cppStdout = cpp.stdout.trim()
  const nodeStdout = node.stdout.trim()

  const problems = []
  if (phase !== 'ran') problems.push(`${phase}: ${head(cpp.stderr)}`)
  else if (node.status !== 0)
    problems.push(`the oracle itself failed (node exit ${node.status}${node.signal ? ` ${node.signal}` : ''}): ${head(node.stderr)}`)
  else if (cppStdout !== nodeStdout) problems.push(`diverged from node -- ${firstDivergence(cppStdout, nodeStdout)}`)
  else if (cppStdout === '') problems.push('neither run printed anything: two silent programs agree on nothing')
  else if (tripwire !== null && cppStdout !== tripwire)
    problems.push(`both runs agree on ${JSON.stringify(cppStdout)}, which is not the pinned ${JSON.stringify(tripwire)}`)

  // A recorded divergence that no longer reproduces is a failure: the record
  // has to be updated to say it was fixed, not left describing a defect gone.
  const reproduced = []
  for (const wrong of wrongs) {
    const text = wrong.split('--')[0].trim()
    const matched = problems.some((problem) => problem.includes(text)) || cpp.stderr.includes(text) || cppStdout.includes(text)
    if (matched) reproduced.push(text)
    else problems.push(`known-wrong no longer reproduces (GOOD -- update the directive): ${text}`)
  }

  const outstanding = problems.filter((problem) => !reproduced.some((text) => problem.includes(text)))
  return {
    relativePath: name,
    status: outstanding.length === 0 ? (reproduced.length ? 'known-wrong' : 'pass') : phase === 'ran' ? 'diverged' : phase,
    reason: outstanding.join(' | ') || null,
    problems: outstanding,
    reproduced,
    durationMs: Date.now() - started
  }
}

const results = []
let index = 0
const pool = Array.from({ length: Math.min(workers, selected.length) }, async () => {
  while (index < selected.length) {
    const name = selected[index++]
    const result = runCase(name)
    results.push(result)
    if (result.status === 'pass') console.log(`ok    ${name}`)
    else if (result.status === 'known-wrong') console.log(`ok    ${name}   (${result.reproduced.length} known-wrong)`)
    else {
      console.log(`FAIL  ${name}   [${result.status}]`)
      for (const problem of result.problems) console.log(`        ${problem.split('\n').join('\n        ')}`)
    }
  }
})
await Promise.all(pool)

const counts = {}
for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
const failed = results.filter((result) => result.status !== 'pass' && result.status !== 'known-wrong')

if (outPath) {
  const summary = {
    label,
    generatedAt: new Date().toISOString(),
    programs: programs.length,
    ran: results.length,
    counts,
    cases: results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  writeFileSync(resolve(outPath), `${JSON.stringify(summary, null, 2)}\n`)
}

console.log(
  `\n${results.length} programs: ${counts.pass ?? 0} pass, ${failed.length} failed` +
    `${counts['known-wrong'] ? `, ${counts['known-wrong']} known-wrong reproduced` : ''}`
)
for (const [status, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
  console.log(`  ${status.padEnd(12)} ${String(count).padStart(4)}`)
process.exit(failed.length === 0 ? 0 : 1)
