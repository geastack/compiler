/**
 * The suite the corpus cannot be.
 *
 * `corpus.mjs`'s `compiles` column is `clang -fsyntax-only`. It says the
 * emitted C++ parses -- never that it links, never that it runs, and never
 * that the answer is right. A whole class of defect lives in that gap and
 * produces no signal at all in the corpus: `Object.keys` returning the correct
 * keys in the wrong ORDER compiles perfectly, moves no column, and is wrong.
 * So does a store that reads a box back as the wrong type. Both shipped.
 *
 * Each program under `test/runtime/` declares what it must print, in `//!`
 * lines at the top:
 *
 *   //! expect: <substring that must appear in stdout>   (repeatable)
 *   //! expect-abort         (must die by signal; any `expect:` lines are STILL checked
 *                            against what it printed before dying)
 *   //! expect-refusal: <substring>                       (must be REFUSED at compile time, repeatable)
 *   //! known-wrong: <text>                              (a defect not yet fixed)
 *   //! emitted-has: <substring the emitted C++ must contain>     (repeatable)
 *   //! emitted-lacks: <substring the emitted C++ must not contain> (repeatable)
 *   //! emitted-once: <substring the emitted C++ must contain exactly once>
 *   //! compile-only                                     (check the C++, do not link it)
 *   //! dynamic-fallback                                 (compile with --dynamic-fallback)
 *
 * `compile-only` is for a program this runner cannot link -- a JSX program
 * needs the engine's node type and a real document. Its shape is still pinned
 * and its C++ is still checked (`clang -fsyntax-only`); only the run is
 * dropped, and `expect` lines are meaningless on one.
 *
 * The last two are about the SHAPE of what the compiler wrote, which no
 * `expect` can see: a program prints the right answer whether or not the
 * emitter materialized a callable it never calls, copied a field it never
 * reads, or rebuilt a table of constants on every call. They exist so a
 * performance fix in the emitter is pinned by the same runner that pins its
 * correctness, and they are checked against the emitted units before the link.
 *
 * `known-wrong` is the honest half. A defect that is real, understood, and not
 * yet fixed is recorded here rather than deleted from the program or quietly
 * asserted as correct -- and the runner FAILS if a `known-wrong` line stops
 * being true, because a defect that silently fixes itself is a fact worth
 * learning, not a line to leave rotting.
 *
 * `expect-refusal` is the opposite of `known-wrong`: a program this compiler
 * must NOT certify. `run-emitted.mjs` prints `EMIT FAILED` plus the compile
 * log and exits 3 the moment `cli.js`'s own `--emit` refuses -- so this
 * directive asserts exactly that shape (a non-zero exit, and the named
 * refusal text present in the log) rather than the ordinary compile-link-run
 * a bare `expect` pins. A program that starts compiling clean where this
 * directive is present is the regression: a construct this compiler once
 * refused by name now certifies, which is worth catching by name, the same
 * way `known-wrong` catches a silent fix in the other direction.
 *
 *   node scripts/run-runtime-tests.mjs [--dist <dir>] [--only <substring>] [--shard <i>/<n>] [--translation-units single|per-file]
 *
 * `--shard <i>/<n>` runs every n-th program (1-based offset), which is the
 * only parallelism this suite has: each program is an independent
 * compile-link-run, so n shards at once cost what one does. Merge the
 * `ok`/`FAIL` lines afterwards; a shard may not write the status record.
 *
 * `--translation-units` is passed through to `run-emitted.mjs`, so the same
 * programs and the same expectations gate the per-file layout: a layout that
 * links and prints the same answers is one that split the program without
 * changing it.
 *
 * `--timings`, `--no-native-cache`, and `--no-pch` pass through to the native
 * builder. Each shard requires its own existing --out-dir; serial runs reuse
 * the default build directory and runtime PCH across programs and suite runs.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const dist = resolve(flag('--dist', join(here, 'dist')))
const only = flag('--only', null)
// `--shard <i>/<n>`: run only every n-th program, offset i (1-based).
//
// Every program here is an independent compile-link-run, so the serial loop
// below is incidental rather than required, and a full pass costs 300-odd
// clang invocations against a 25k-line header. Sharding is the whole
// parallelism story: run n of these at once and merge the outcome lines.
//
// The programs are STRIDED (`index % n`), not sliced into contiguous blocks,
// because they are sorted by name and cost is not evenly distributed across
// the alphabet -- a block containing the generator and iterator programs takes
// several times a block of scalar ones, and the run is only as fast as its
// slowest shard. Striding mixes the expensive ones across every shard.
//
// A shard cannot write the status file: `--update-status` needs the whole
// suite, and each shard sees a fraction. The comparison a shard still DOES
// make is per-program (`REGRESSED`/`FIXED` against the tracked record), which
// is exactly the part that is answerable from one program's own outcome.
const shard = flag('--shard', null)
const shardOf = (() => {
  if (shard === null) return null
  const parts = /^(\d+)\/(\d+)$/.exec(shard)
  if (!parts) {
    console.error(`--shard wants <i>/<n> (1-based), not "${shard}"`)
    process.exit(2)
  }
  const index = Number(parts[1])
  const count = Number(parts[2])
  if (index < 1 || index > count) {
    console.error(`--shard ${shard} is out of range: i must be between 1 and n`)
    process.exit(2)
  }
  return { index, count }
})()
// `--status <file>`: the TRACKED record of every program's expected outcome
// (`ok`/`FAIL`, one line each). A run compares itself against it and names
// each program that changed outcome -- `REGRESSED`, `FIXED`, `NEW`, `GONE` --
// which is the only comparison that makes a regression attributable; the
// counts alone never did. `--update-status` rewrites the file from this run
// (a full run, never a `--only` slice) so the record moves with a landing.
// It is a tracked file on purpose: a baseline kept under a gitignored
// directory was deleted once, with every measurement beside it.
const statusPath = flag('--status', null)
const updateStatus = argv.includes('--update-status')
const layout = flag('--translation-units', null)
const output = flag('--out-dir', null)
if (shard !== null && output === null) {
  console.error('--shard requires --out-dir pointing to an existing directory exclusive to that worker')
  process.exit(2)
}

const dir = join(here, 'test', 'runtime')
// The dialect these programs are compiled under, stated rather than inherited.
//
// Without a `--project` the CLI walks upward for the nearest `tsconfig.json`
// and finds the COMPILER'S OWN -- so every program here was being compiled
// under `rootDir: src`, `types: ["node"]`, `noUnusedLocals` and
// `noUncheckedIndexedAccess`, none of which anyone chose for a runtime test,
// and none of which the corpus applies to the same files (`corpus.mjs`
// compiles a fixture with `projectFileName: null`). Two harnesses, two
// languages, and the difference is invisible in both.
//
// `test/runtime/tsconfig.json` keeps `noUncheckedIndexedAccess` on purpose:
// `a[i]` really is `T | undefined` in JavaScript, and the accident of
// inheriting that option is what surfaced an indexed read that promised an
// optional its access never produced. It carries `"files": []` rather than an
// `include`, so each program is still compiled ALONE -- these are script-scope
// programs that share top-level names, and one project over all of them is a
// single program in which they collide.
const project = join(dir, 'tsconfig.json')
if (!existsSync(dir)) {
  console.error(`no runtime-tests directory at ${dir}`)
  process.exit(2)
}
const files = readdirSync(dir)
  // A leading underscore names a module a program IMPORTS -- a framework
  // stand-in a component test extends -- not a program to compile and run.
  // JavaScript regressions opt in with `.runtime.js`. Other `.js` files in
  // this directory are fixtures for focused negative/probe harnesses and are
  // not standalone programs for this runner.
  .filter(
    (name) =>
      (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.runtime.js')) && !name.endsWith('.d.ts') && !name.startsWith('_')
  )
  .filter((name) => (only ? name.includes(only) : true))
  .sort()
  .filter((_, index) => shardOf === null || index % shardOf.count === shardOf.index - 1)

// The colon is REQUIRED, not cosmetic: every directive this reads is
// colon-terminated, and a bare prefix test made `//! expect-abort` answer as
// an `expect:` directive whose text was `-abort`. That was inert only for as
// long as the abort branch below ignored `expect:` lines; the moment it
// stopped ignoring them, every aborting program demanded output no program
// could ever print.
const directives = (source, name) =>
  source
    .split('\n')
    .filter((line) => line.startsWith('//!'))
    .map((line) => line.slice(3).trim())
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim())

/**
 * A bare, colon-less flag (`expect-abort`, `compile-only`, `dynamic-fallback`).
 *
 * Line-anchored for the same reason the colon above is load-bearing. These were
 * `source.includes('//! expect-abort')`, which matches the string ANYWHERE --
 * including inside ordinary prose. A fixture that merely explains why it no
 * longer states a directive acquires that directive by writing its name, and
 * the failure is maximally confusing: the program runs correctly, prints
 * exactly what it should, and the suite reports "expected an abort, and it did
 * not abort". Caught when `dynamic-class-family-wrong.ts` documented the
 * `expect-abort` it was dropping and thereby kept it.
 *
 * The general rule this instrument keeps relearning: a directive scanner must
 * read DIRECTIVE LINES, never the source text. A comment is data.
 */
const hasFlag = (source, name) =>
  source
    .split('\n')
    .filter((line) => line.startsWith('//!'))
    .some((line) => line.slice(3).trim() === name)

let failed = 0
let known = 0
const outcomes = new Map()
for (const file of files) {
  const path = join(dir, file)
  const perProgramProject = join(dir, file.replace(/\.(?:tsx?|runtime\.js)$/, '.tsconfig.json'))
  const projectForProgram = existsSync(perProgramProject) ? perProgramProject : project
  // The directory was listed once, up front; a probe another session wrote and
  // then deleted while this suite was running is not a program of the suite,
  // and dying on it threw away every result before it.
  if (!existsSync(path)) {
    console.log(`skip  ${file}   (removed while the suite was running)`)
    continue
  }
  const source = readFileSync(path, 'utf8')
  const expects = directives(source, 'expect')
  const wrongs = directives(source, 'known-wrong')
  const mustAbort = hasFlag(source, 'expect-abort')
  const refusals = directives(source, 'expect-refusal')
  const compileOnly = hasFlag(source, 'compile-only')
  // Mirrors `compile-only` above: a directive stated in the program itself,
  // rather than a CLI flag threaded in from outside, so the requirement
  // travels with the file that needs it. Exists for programs whose own
  // arithmetic genuinely mixes carriers `--dynamic-fallback` is the
  // documented escape hatch for (see `targets/cpp/emit.ts`'s mixed-binary
  // dispatch) -- not for working around a defect this suite should catch.
  const dynamicFallback = hasFlag(source, 'dynamic-fallback')
  const shape = [
    ...directives(source, 'emitted-has').flatMap((text) => ['--emitted-has', text]),
    ...directives(source, 'emitted-lacks').flatMap((text) => ['--emitted-lacks', text]),
    ...directives(source, 'emitted-once').flatMap((text) => ['--emitted-once', text])
  ]

  let stdout = ''
  let status = 0
  try {
    const passthrough = [
      ...(output ? ['--out-dir', resolve(output)] : []),
      ...(layout ? ['--translation-units', layout] : []),
      ...(compileOnly ? ['--compile-only'] : []),
      ...(dynamicFallback ? ['--dynamic-fallback'] : []),
      ...['--no-native-cache', '--no-pch', '--timings'].filter((option) => argv.includes(option))
    ]
    const result = spawnSync(
      'node',
      [join(here, 'scripts', 'run-emitted.mjs'), path, '--dist', dist, '--project', projectForProgram, ...passthrough, ...shape],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`
    status = result.status ?? 1
    if (result.error) stdout += result.error.message
    if (argv.includes('--timings')) {
      for (const line of stdout.split('\n').filter((line) => line.startsWith('NATIVE BUILD '))) console.error(`${file}: ${line}`)
    }
  } catch (error) {
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
    status = error.status ?? 1
  }

  const problems = []
  if (mustAbort) {
    if (!stdout.includes('CRASHED')) problems.push('expected an abort, and it did not abort')
    // Everything printed BEFORE the abort is a real observation, and the
    // `expect:` lines are checked here for the same reason they are checked
    // anywhere: a program that dies in the WRONG place prints none of them.
    // Without this, `expect-abort` was a way to make a broken program report
    // green -- `template-strings-array-identity.ts` stated eight `expect:`
    // lines, printed three, and aborted on a `gea::host::unreachableValue`
    // trap five lines early, and this runner called it ok. An abort is a
    // claim about HOW the program ends, never a licence to stop checking
    // what it did on the way there.
    for (const want of expects) if (!stdout.includes(want)) problems.push(`missing expected output: ${want}`)
    for (const line of stdout.split('\n')) if (line.startsWith('EMITTED SHAPE:')) problems.push(line.slice('EMITTED SHAPE:'.length).trim())
  } else if (refusals.length > 0) {
    if (status === 0) problems.push('expected a compile-time refusal, and the program certified/linked/ran instead')
    for (const want of refusals) if (!stdout.includes(want)) problems.push(`missing expected refusal text: ${want}`)
  } else {
    if (status !== 0) problems.push(`exited ${status}`)
    for (const want of expects) if (!stdout.includes(want)) problems.push(`missing expected output: ${want}`)
    for (const line of stdout.split('\n')) if (line.startsWith('EMITTED SHAPE:')) problems.push(line.slice('EMITTED SHAPE:'.length).trim())
  }
  // A `known-wrong` line that stopped being true is reported as a FAILURE, not
  // quietly passed: someone fixed it, and the record has to be updated to say
  // so rather than keep describing a defect that is gone.
  for (const wrong of wrongs) {
    const text = wrong.split('--')[0].trim()
    if (stdout.includes(text)) known += 1
    else problems.push(`known-wrong no longer reproduces (GOOD -- update the directive): ${text}`)
  }

  if (problems.length) {
    failed += 1
    console.log(`FAIL  ${file}`)
    for (const problem of problems) console.log(`        ${problem}`)
  } else {
    console.log(`ok    ${file}${wrongs.length ? `   (${wrongs.length} known-wrong)` : ''}`)
  }
  outcomes.set(file, problems.length ? 'FAIL' : 'ok')
}

console.log(`\n${files.length} programs: ${files.length - failed} ok, ${failed} failed, ${known} known-wrong reproduced`)

let changed = 0
if (statusPath !== null) {
  const recorded = new Map(
    existsSync(statusPath)
      ? readFileSync(statusPath, 'utf8')
          .split('\n')
          .filter((line) => line.includes('\t'))
          .map((line) => line.split('\t'))
      : []
  )
  for (const [file, outcome] of outcomes) {
    const before = recorded.get(file)
    if (before === undefined) console.log(`NEW        ${file}  (${outcome})`)
    else if (before !== outcome) {
      changed += 1
      console.log(`${outcome === 'ok' ? 'FIXED     ' : 'REGRESSED '} ${file}  (${before} -> ${outcome})`)
    }
  }
  // A shard sees a fraction of the suite, so every program it did not run
  // would read as GONE. Same reason a `--only` slice does not report them.
  if (only === null && shardOf === null) for (const file of recorded.keys()) if (!outcomes.has(file)) console.log(`GONE       ${file}`)
  if (updateStatus) {
    if (only !== null || shardOf !== null) {
      console.error('--update-status needs the whole suite; a --only slice or a --shard would record every other program as gone')
      process.exit(2)
    }
    writeFileSync(statusPath, [...outcomes].map(([file, outcome]) => `${file}\t${outcome}`).join('\n') + '\n')
    console.log(`status written: ${statusPath}`)
  } else {
    console.log(`${changed} program(s) changed outcome against ${statusPath}`)
  }
}
process.exit(failed === 0 && changed === 0 ? 0 : 1)
