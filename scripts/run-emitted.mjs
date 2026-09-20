/**
 * Compile a TypeScript program with geatsc, LINK it, and RUN it.
 *
 * `corpus.mjs`'s `compiles` column is `clang -fsyntax-only`: it says the
 * emitted C++ parses, never that it links and never that it runs. That blind
 * spot is not hypothetical -- on 2026-09-03 every `for`-`in` over a generated
 * record segfaulted at runtime while the corpus read 118/118 clang-clean,
 * because `Ref::release` gates on `std::is_final_v<T>` where `makeRef` and
 * `WeakRef::release` gate on `detail::refStandalone<T>`, and a `Ref<void>`
 * over a standalone block then reads an operations table that was never
 * written. Certified, emitted, clang-clean, and wrong. This script is the
 * missing column.
 *
 *   node scripts/run-emitted.mjs <program.ts> [--out-dir <dir>] [--expect <text>] [--translation-units single|per-file]
 *
 * Native object caching and a reusable runtime PCH are enabled by default.
 * `--timings` reports their use; `--no-native-cache` disables both for a
 * control run, and `--no-pch` retains ccache while preserving textual includes.
 * Default output is measurements/cxx, created if absent. Concurrent
 * invocations need exclusive output directories; never share the default
 * between workers.
 *
 * `--translation-units` is passed through to `compile`, so the per-file layout
 * is exercised by the same link-and-run this exists for: the units it writes
 * are read back off `geatsc-sources.txt`, exactly as a real build reads them,
 * and every one of them is on the link line.
 *
 * Exit status is the program's own, so this composes into a sweep. `--expect`
 * additionally fails when the program's stdout does not contain the text,
 * which is what distinguishes "ran" from "ran and was right".
 *
 * The emitted unit has no `main` -- it exposes `__gea_top_level()` -- so a
 * two-line shim drives it. A crash inside the shim would be indistinguishable
 * from a crash in the program, so ALWAYS pair a suspected failure with a
 * control that exercises the same shim without the feature under test; a plain
 * arithmetic program and an array-push program both run clean through it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { buildNative } from './native-build-cache.mjs'
import { lockNativeOutput } from './native-output-lock.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const entry = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)
if (!entry || !existsSync(entry)) {
  console.error('usage: node scripts/run-emitted.mjs <program.ts> [--dist <dir>] [--project <tsconfig>] [--expect <text>]')
  process.exit(2)
}
const dist = resolve(flag('--dist', 'dist'))
const project = flag('--project', null)
const expect = flag('--expect', null)
// A program whose host this script cannot link -- a JSX program needs the
// engine's node type and its real document -- still has an emitted SHAPE worth
// pinning, and still has to be valid C++. `--compile-only` stops after
// `clang -fsyntax-only`, which is exactly the corpus's `compiles` column: less
// than running, and far more than nothing.
const compileOnly = argv.includes('--compile-only')
const layout = flag('--translation-units', null)
// Assertions about the SHAPE of the emitted C++, not its behavior. A program
// can print the right answer while the emitter builds a callable it never
// calls, copies a field it never reads, or heap-allocates a table of
// constants on every call -- none of which any `--expect` can see. Each flag
// is repeatable and names a substring the concatenated emitted units must
// (`--emitted-has`) or must not (`--emitted-lacks`) contain.
const flags = (name) => argv.flatMap((argument, index) => (argument === name && argv[index + 1] !== undefined ? [argv[index + 1]] : []))
// A directive is one source line, so a two-line shape (`blockN:` then `goto`) is written with a literal `\n`.
const unescaped = (text) => text.split('\\n').join('\n')
const emittedHas = flags('--emitted-has').map(unescaped)
const emittedLacks = flags('--emitted-lacks').map(unescaped)
const emittedOnce = flags('--emitted-once').map(unescaped)

// An explicit existing output directory supports serial work without scratch
// trees. Do not run two invocations against the same output concurrently:
// their source lists and main shims would overwrite each other.
const requestedOutput = flag('--out-dir', null)
const out = requestedOutput ? resolve(requestedOutput) : resolve(import.meta.dirname, '../measurements/cxx')
mkdirSync(out, { recursive: true })
const compilerRelative = relative(realpathSync(dist), realpathSync(out))
if (compilerRelative === '' || (!compilerRelative.startsWith(`..${sep}`) && compilerRelative !== '..' && !isAbsolute(compilerRelative)))
  throw new Error('Native test output must be outside compiler/dist; use --out-dir measurements/cxx')
await lockNativeOutput(out)

const compileArguments = ['compile', resolve(entry), '--out-dir', out]
// Without runtime code evaluation, this executable contains its complete
// classic-script lexical realm. Dynamic fallback permits Function strings,
// which can observe global lexical bindings under JavaScript semantics.
// Do not treat the native evaluator's currently limited lookup as a proof
// that such bindings are private. GlobalThis/object effects stay open in
// either mode.
if (!argv.includes('--dynamic-fallback')) compileArguments.push('--closed-script-scope')
if (argv.includes('--dynamic-fallback')) compileArguments.push('--dynamic-fallback')
if (project) compileArguments.push('--project', resolve(project))
if (layout) compileArguments.push('--translation-units', layout)
try {
  execFileSync('node', [join(dist, 'cli.js'), ...compileArguments], { stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  console.error('EMIT FAILED\n' + String(error.stdout ?? '') + String(error.stderr ?? ''))
  process.exit(3)
}

const sourceList = join(out, 'geatsc-sources.txt')
const units = existsSync(sourceList) ? readFileSync(sourceList, 'utf8').split('\n').filter(Boolean) : []
if (units.length === 0 || !units.every((unit) => existsSync(unit))) {
  console.error('EMIT PRODUCED NO C++ (the program was refused; read the compile log for why)')
  process.exit(3)
}

writeFileSync(join(out, 'main_shim.cpp'), 'extern void __gea_top_level();\nint main() { __gea_top_level(); return 0; }\n')

// Checked BEFORE the link: a shape assertion is about what the compiler wrote,
// and it should fail by name even when the program also fails to link or run.
const emitted = units.map((unit) => readFileSync(unit, 'utf8')).join('\n')
const shapeProblems = [
  ...emittedHas.filter((text) => !emitted.includes(text)).map((text) => `emitted C++ lacks ${JSON.stringify(text)}`),
  ...emittedLacks
    .filter((text) => emitted.includes(text))
    .map((text) => `emitted C++ contains ${JSON.stringify(text)} (${emitted.split(text).length - 1} time(s))`),
  ...emittedOnce
    .filter((text) => emitted.split(text).length !== 2)
    .map((text) => `emitted C++ contains ${JSON.stringify(text)} ${emitted.split(text).length - 1} time(s), not once`)
]
for (const problem of shapeProblems) console.error(`EMITTED SHAPE: ${problem}`)

// The same include roots `corpus.mjs` uses, read from the tree rather than
// copied, so a header that moves breaks this loudly.
const here = resolve(import.meta.dirname, '..')
const engineRoots = [
  'core/packages/core/include',
  'core/packages/host/include',
  'core/packages/engine',
  'core/packages/engine/ui',
  'core/packages/elements',
  'core/packages/elements/ui'
]
const includes = [`-I${out}`, ...engineRoots.map((root) => `-I${join(here, '..', root)}`)]
// A forced runtime include is safe only when the unit reaches it through a
// prefix of standard-library includes. Host programs declare native types and
// macros BEFORE the runtime; hoisting it across that prelude changes its ABI.
// Indirect includes (including per-file application headers) retain their
// original order and still benefit from object caching.
const pchExcludedUnits = [
  ...units.filter((unit) => {
    const source = readFileSync(unit, 'utf8')
    const runtimeInclude = source.indexOf('#include "gea_runtime.h"')
    return (
      runtimeInclude < 0 ||
      source
        .slice(0, runtimeInclude)
        .split('\n')
        .some((line) => line.trim() !== '' && !/^#include <[^>]+>$/.test(line.trim()))
    )
  }),
  join(out, 'main_shim.cpp')
]
try {
  const timing = buildNative({
    out,
    units: compileOnly ? units : [...units, join(out, 'main_shim.cpp')],
    includes,
    pchExcludedUnits,
    compileOnly,
    cache: !argv.includes('--no-native-cache'),
    pch: !argv.includes('--no-pch')
  })
  if (argv.includes('--timings')) console.error(`NATIVE BUILD ${JSON.stringify(timing)}`)
} catch (error) {
  console.error('COMPILE/LINK FAILED\n' + error.message)
  process.exit(4)
}
if (compileOnly) {
  if (shapeProblems.length > 0) process.exit(1)
  console.error('COMPILED OK')
  process.exit(0)
}
const binary = join(out, 'program')

const ran = spawnSync(binary, { encoding: 'utf8' })
process.stdout.write(ran.stdout ?? '')
if (ran.stderr) process.stderr.write(ran.stderr)

// A signal is reported by name: 139/138 as bare exit codes read like ordinary
// failures, and the whole point of this script is that they are not.
if (ran.signal) {
  console.error(`CRASHED: ${ran.signal}`)
  process.exit(1)
}
if (ran.status !== 0) {
  console.error(`EXITED ${ran.status}`)
  process.exit(1)
}
if (expect !== null && !(ran.stdout ?? '').includes(expect)) {
  console.error(`RAN, BUT WRONG: stdout does not contain ${JSON.stringify(expect)}`)
  process.exit(1)
}
if (shapeProblems.length > 0) process.exit(1)
console.error(expect === null ? 'RAN OK' : `RAN OK (matched ${JSON.stringify(expect)})`)
