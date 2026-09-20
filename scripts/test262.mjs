/**
 * Upstream Test262 against THIS compiler, with the legacy sweep's denominator.
 *
 * The legacy compiler (`geastack/compiler-legacy`) measured itself against
 * tc39/test262 through the Cloud Run sweep: 37,138 candidate files under the
 * `expanded` manifest policy, run under the `current` runner policy, in `shim`
 * harness mode. Its best full run (tsc-20260702-172857) was
 * pass 21045 / fail 4160 / skip 11933. That harness is hardwired to the legacy
 * `packages/geatsc` layout, so it cannot be pointed at `compiler/dist`. This
 * script reproduces its SELECTION and its JUDGEMENT against `dist/`, so the
 * two compilers are compared on the same files by the same rule.
 *
 * What is kept identical to the legacy run, on purpose:
 *   - the candidate policy: the same path prefixes, feature names, variant
 *     rules (strict only; raw/module/sloppy skipped) and source-policy regexes
 *     (eval / new Function / $262.evalScript);
 *   - the shim harness rather than upstream `assert.js` + `sta.js`, and the
 *     same leniency in it: `assert.throws` checks THAT the callee threw, not
 *     what it threw. (Upstream `assert.js` hangs properties off a function
 *     value -- `assert.sameValue = function ...` -- which this compiler refuses
 *     as `function-value-dispatch`, and the legacy shim used a function +
 *     namespace merge, which is the same refusal. Here `assert` is an object
 *     and bare `assert(...)` calls in the body are rewritten to `assert.ok`.)
 *   - the metadata `includes` pasted verbatim from `vendor/test262/harness`;
 *   - the entry shape: the body inside `main()`, `'pass'` on stdout is the
 *     only pass; negative-runtime cases pass by throwing; negative-parse
 *     cases pass when TypeScript reports a diagnostic and are SKIPPED when it
 *     permits the construct (the legacy rule, kept so the skip column matches);
 *   - a 60 s run timeout and a per-case scratch directory.
 *
 * What is different, and reported as its own column rather than folded:
 *   - `refused`: this compiler withholds the certificate or refuses emission.
 *     The legacy runner counted a case whose only diagnostics were
 *     `unsupported`/TypeScript ones as a SKIP (151 + a few hundred of its
 *     11.9k skips). Folding a refusal into `skip` would flatter this compiler
 *     by exactly the amount it cannot compile, so it is not folded.
 *   - `cxx-fail`: the emitted C++ does not build (the legacy `native C++ build
 *     failed` reason, 492 of its 4160 fails).
 *
 * The checkout: `vendor/test262/` is the tree the legacy sweep archived on
 * 2026-07-12, so the file set is the one the 21045 was measured on.
 *
 *   node scripts/test262.mjs [--label <name>] [--path <prefix>]... [--match <substr>]
 *                            [--sample <every-nth>] [--limit N] [--offset N]
 *                            [--workers N] [--dynamic-fallback] [--keep-failures]
 *                            [--list-json] [--files <list>] [--out <json>] [--work-root <dir>]
 *
 * The last four are the seams a batch runner drives:
 * `--list-json` prints the selection instead of running it, `--files` runs an
 * explicit list of relative paths, `--out` names the result file and
 * `--work-root` moves the include dir and scratch off the measurements tree.
 * A laptop runs slices with this script; the full population runs in the
 * cloud, where 25k cases at ~1 s each is minutes rather than an hour.
 *
 * Writes `measurements/test262/<label>.json` (every case, its status and
 * reason) and prints the counts plus the ranked reasons. `--sample 20` runs
 * every 20th candidate in path order: a stratified slice whose pass RATE
 * estimates the full run's, for when 25k cases at ~2 s each is not the
 * question being asked.
 */
import { fork } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { createRequire } from 'node:module'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const flags = (name) => argv.flatMap((argument, index) => (argument === name && argv[index + 1] !== undefined ? [argv[index + 1]] : []))

const test262Root = resolve(flag('--test262-root', join(here, 'vendor', 'test262')))
const testDir = join(test262Root, 'test')
const harnessDir = join(test262Root, 'harness')
const dynamicFallback = argv.includes('--dynamic-fallback')
const keepFailures = argv.includes('--keep-failures')
// Where the include dir, the per-worker scratch and the result JSON live. The
// local default is the gitignored measurements tree; the Cloud Run worker
// points it at the task's own scratch.
const measurementsDir = resolve(flag('--work-root', join(here, 'measurements', 'test262')))
// The cloud worker hands the runner an explicit file list and an explicit
// output path: the selection was made once, by the manifest, for every task.
const filesList = flag('--files', null)
const outPath = flag('--out', null)
const listJson = argv.includes('--list-json')
const runTimeoutMs = Number(flag('--run-timeout-ms', 60_000))
const buildTimeoutMs = Number(flag('--build-timeout-ms', 300_000))

// ---------------------------------------------------------------------------
// Selection: the legacy sweep's policy, verbatim.
// ---------------------------------------------------------------------------

// Manifest-time policy (`expanded`), which decided the 37,138.
const expandedUnsupportedFeatureNames = new Set([
  'Atomics',
  'FinalizationRegistry',
  'Intl',
  'Reflect',
  'Reflect.construct',
  'Reflect.set',
  'ShadowRealm',
  'Temporal',
  'WeakRef',
  'resizable-arraybuffer',
  'regexp-v-flag'
])
const expandedUnsupportedPathPrefixes = [
  'annexB/',
  'intl402/',
  'staging/',
  'implementation-contributed/',
  'built-ins/Atomics/',
  'built-ins/FinalizationRegistry/',
  'built-ins/SharedArrayBuffer/',
  'built-ins/ShadowRealm/',
  'built-ins/Temporal/',
  'built-ins/WeakRef/',
  'built-ins/eval/',
  'language/eval-code/'
]
// Run-time policy (`current`), which decided the 11,933 skips inside them.
const currentUnsupportedFeatureNames = new Set([
  'Atomics',
  'Intl',
  'ShadowRealm',
  'Temporal',
  'resizable-arraybuffer',
  'regexp-v-flag',
  'regexp-unicode-property-escapes',
  'regexp-modifiers',
  'regexp-lookbehind',
  'regexp-duplicate-named-groups',
  'regexp-named-groups',
  'proxy-missing-checks',
  'tail-call-optimization',
  'Math.sumPrecise',
  // `Math.f16round` and the Float16Array family: declared by TypeScript only
  // in lib.esnext.float16, which the ES2022 program here never loads, and
  // carried by no runtime table -- an honest skip beside sumPrecise, not a
  // fail counted against the reflection machinery.
  'Float16Array',
  'cross-realm',
  'explicit-resource-management',
  'dynamic-import',
  'async-iteration',
  'SharedArrayBuffer',
  'AggregateError',
  'Promise.any',
  'Promise.allSettled',
  'String.prototype.matchAll',
  'Symbol.matchAll',
  'Symbol.replace',
  '__getter__',
  '__setter__',
  'Symbol.species',
  'Symbol.toPrimitive',
  'Symbol.toStringTag',
  'Proxy'
])
const currentUnsupportedPathPrefixes = [
  'annexB/',
  'intl402/',
  'staging/',
  'implementation-contributed/',
  'built-ins/Atomics/',
  'built-ins/SharedArrayBuffer/',
  'built-ins/ShadowRealm/',
  'built-ins/Temporal/',
  'built-ins/ArrayBuffer/',
  'built-ins/DataView/',
  'built-ins/AsyncFromSyncIteratorPrototype/',
  'built-ins/AsyncGeneratorPrototype/',
  'built-ins/eval/',
  'built-ins/Object/defineProperties/',
  'built-ins/Object/defineProperty/',
  'built-ins/Object/getOwnPropertyDescriptor/',
  'built-ins/Object/getOwnPropertyDescriptors/',
  'built-ins/Promise/',
  'language/arguments-object/',
  'language/eval-code/'
]

const parseMetadata = (source) => {
  const block = /\/\*---([\s\S]*?)---\*\//.exec(source)?.[1] ?? ''
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clean = (value) => value.trim().replace(/^["']|["']$/g, '')
  const scalar = (key) => {
    const match = new RegExp(`^\\s*${escape(key)}:\\s*(.+)$`, 'm').exec(block)
    return match?.[1] ? clean(match[1]) : undefined
  }
  const array = (key) => {
    const inline = new RegExp(`^\\s*${escape(key)}:\\s*\\[([^\\]]*)\\]`, 'm').exec(block)
    if (inline) return inline[1].split(',').map(clean).filter(Boolean)
    const list = new RegExp(`^\\s*${escape(key)}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, 'm').exec(block)
    if (!list) return []
    return list[1]
      .split(/\n/)
      .map((line) => clean(line.replace(/^\s*-\s*/, '')))
      .filter(Boolean)
  }
  const negativeBlock = /^\s*negative:\s*\n((?:\s+[A-Za-z]+:\s*.+\n?)+)/m.exec(block)
  const nested = (key) => {
    const match = new RegExp(`^\\s+${escape(key)}:\\s*(.+)$`, 'm').exec(negativeBlock[1])
    return match?.[1] ? clean(match[1]) : undefined
  }
  return {
    features: array('features'),
    flags: array('flags'),
    includes: array('includes'),
    negative: negativeBlock ? { phase: nested('phase'), type: nested('type') } : undefined
  }
}

const variantOf = (metadata) =>
  metadata.flags.includes('raw')
    ? 'raw'
    : metadata.flags.includes('module')
      ? 'module'
      : metadata.flags.includes('noStrict')
        ? 'sloppy'
        : 'strict'
const isCompileTimeNegativePhase = (phase) => phase === undefined || phase === 'parse' || phase === 'early' || phase === 'resolution'

const skipReasonFor = (relativePath, metadata, missingIncludes, variant, policy) => {
  const prefixes = policy === 'expanded' ? expandedUnsupportedPathPrefixes : currentUnsupportedPathPrefixes
  const features = policy === 'expanded' ? expandedUnsupportedFeatureNames : currentUnsupportedFeatureNames
  const pathSkip = prefixes.find((prefix) => relativePath.startsWith(prefix))
  if (pathSkip) return `unsupported Test262 path prefix: ${pathSkip}`
  if (relativePath.endsWith('_FIXTURE.js')) return 'Test262 _FIXTURE.js files are imported by other tests, not run standalone'
  if (variant === 'raw') return 'raw Test262 tests need exact harness control'
  if (variant === 'module') return 'module-mode Test262 tests are not enabled yet'
  if (variant === 'sloppy') return 'sloppy-only Test262 tests do not match the strict TypeScript target'
  if (missingIncludes.length > 0) return `missing Test262 includes: ${missingIncludes.join(', ')}`
  const phase = metadata.negative?.phase
  if (metadata.negative && phase && !isCompileTimeNegativePhase(phase) && phase !== 'runtime') {
    return `negative Test262 phase is not enabled yet: ${phase}`
  }
  const unsupported = metadata.features.find((feature) => features.has(feature))
  if (unsupported) return `unsupported Test262 feature metadata: ${unsupported}`
  return null
}

const candidateDynamicSourceSkipReason = (source) => {
  if (/\bnew\s+Function\s*\(/.test(source)) return 'new Function(source) is a source-policy skip for the standalone compiler'
  if (/\bFunction\s*\(\s*['"`]/.test(source)) return 'Function(source) is a source-policy skip for the standalone compiler'
  if (/(?:^|[^.\w$])eval\s*\(/.test(source)) return 'eval(source) is a source-policy skip for the standalone compiler'
  if (/=\s*eval\s*[;,)]/.test(source)) return 'aliased indirect eval is a source-policy skip for the standalone compiler'
  return null
}
const dynamicSourceSkipReason = (source) =>
  candidateDynamicSourceSkipReason(source) ??
  (/\$262\s*\.\s*evalScript\s*\(/.test(source) ? '$262.evalScript(source) is a source-policy skip for the standalone compiler' : null)

const resolveIncludes = (metadata) => {
  const sources = []
  const missing = []
  for (const include of metadata.includes) {
    const includePath = join(harnessDir, include)
    if (existsSync(includePath)) sources.push(readFileSync(includePath, 'utf8'))
    else missing.push(include)
  }
  return { sources, missing }
}

/** The legacy runner's whole verdict on a file before compiling it: a skip reason, or `null` for a candidate. */
const relevance = (relativePath, source) => {
  const metadata = parseMetadata(source)
  const variant = variantOf(metadata)
  const includes = resolveIncludes(metadata)
  // Manifest-time: outside `expanded` means the file was never one of the 37,138.
  const outside = skipReasonFor(relativePath, metadata, includes.missing, variant, 'expanded') ?? candidateDynamicSourceSkipReason(source)
  if (outside) return { selected: false, skip: outside, metadata, includes }
  const skip = skipReasonFor(relativePath, metadata, includes.missing, variant, 'current') ?? dynamicSourceSkipReason(source)
  return { selected: true, skip, metadata, includes }
}

const listTestFiles = (dir) => {
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('._')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(full)
    }
  }
  visit(dir)
  return files.sort()
}

// ---------------------------------------------------------------------------
// Entry construction: the legacy shim harness, minus what this compiler refuses.
// ---------------------------------------------------------------------------

const shimHarness = () =>
  `
class Test262Error {
  /** @param {unknown} [message] */
  constructor(message) { this.message = String(message ?? 'Test262 assertion failed') }
  /** @returns {string} */
  toString() { return 'Test262Error: ' + this.message }
}

/** @param {unknown} [message] @returns {never} */
function __gea_assert_fail(message) {
  throw new Test262Error(message)
}

/** @returns {void} */
function $DONOTEVALUATE() {
  throw new Test262Error('Test262: This statement should not be evaluated.')
}

const assert = {
  /** @param {unknown} condition @param {unknown} [message] @returns {void} */
  ok(condition, message) {
    if (!condition) __gea_assert_fail(message)
  },
  /** @param {unknown} actual @param {unknown} expected @param {unknown} [message] @returns {void} */
  sameValue(actual, expected, message) {
    if (actual === expected) return
    if (actual !== actual && expected !== expected) return
    __gea_assert_fail(message ?? 'Expected SameValue')
  },
  /** @param {unknown} actual @param {unknown} expected @param {unknown} [message] @returns {void} */
  notSameValue(actual, expected, message) {
    if (actual !== expected) return
    if (actual !== actual && expected !== expected) __gea_assert_fail(message ?? 'Expected different values')
  },
  /** @param {readonly unknown[]} actual @param {readonly unknown[]} expected @param {unknown} [message] @returns {void} */
  compareArray(actual, expected, message) {
    if (actual.length !== expected.length) __gea_assert_fail(message ?? 'Expected arrays to have the same length')
    for (let i = 0; i < actual.length; i++) {
      const a = actual[i]
      const e = expected[i]
      if (a === e) continue
      if (a !== a && e !== e) continue
      __gea_assert_fail(message ?? 'Expected array elements to match')
    }
  },
  /** @param {() => unknown} fn @param {unknown} [message] @returns {void} */
  throws(fn, message) {
    let didThrow = false
    try {
      fn()
    } catch (error) {
      didThrow = true
    }
    if (!didThrow) __gea_assert_fail(message ?? 'Expected function to throw')
  }
}

/** @param {readonly unknown[]} actual @param {readonly unknown[]} expected @param {unknown} [message] @returns {boolean} */
function compareArray(actual, expected, message) {
  assert.compareArray(actual, expected, message)
  return true
}

const $262 = {
  /** @param {unknown} _buffer @returns {void} */
  detachArrayBuffer(_buffer) {
    throw new Test262Error('$262.detachArrayBuffer is not provided by this harness')
  },
  /** @returns {void} */
  gc() {}
}
`.trim()

const asyncDoneHarness = () =>
  `
let __gea_async_done_status = 'pending'

/** @param {unknown} [error] @returns {void} */
function $DONE(error) {
  __gea_async_done_status = error ? 'fail' : 'pass'
}

/** @param {() => unknown} testFunc @returns {void} */
function asyncTest(testFunc) {
  try {
    /** @type {any} */
    const result = testFunc()
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      result.then(
        function () { $DONE() },
        /** @param {unknown} error */
        function (error) { $DONE(error) }
      )
      return
    }
    if (__gea_async_done_status === 'pending') $DONE()
  } catch (syncError) {
    $DONE(syncError)
  }
}
`.trim()

const throwsAsyncHarness = () =>
  `
/** @param {() => unknown} func @param {unknown} [message] @returns {Promise<void>} */
function __gea_throws_async(func, message) {
  const expectation = 'Expected an exception to be thrown asynchronously'
  try {
    /** @type {any} */
    const result = func()
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      let rejected = false
      result.then(
        function () { __gea_assert_fail(expectation + ' but no exception was thrown at all') },
        /** @param {unknown} thrown */
        function (thrown) { rejected = true }
      )
      if (!rejected) __gea_assert_fail(expectation + ' but no exception was thrown at all')
    } else {
      __gea_assert_fail(expectation + ' but result was not a thenable')
    }
  } catch (thrown) {
    // thrown synchronously: accepted, as the legacy shim accepted it
  }
  return Promise.resolve()
}
`.trim()

/**
 * The body edits. Text edits over the TypeScript AST, applied back to front,
 * so the rest of the source -- including the harness includes pasted above it
 * -- is exactly what test262 shipped.
 *
 *  - `assert(c, m)` -> `assert.ok(c, m)`: `assert` is an object here, see the header.
 *  - `assert.throws(T, fn, m)` -> `assert.throws(fn, m)`: the constructor is a host
 *    class used as a value, which this compiler refuses; the legacy shim ignored
 *    it too, so the leniency is the same on both sides.
 *  - `assert.throwsAsync(T, fn, m)` -> `__gea_throws_async(fn, m)`.

 * A top-level `var x;` is left WITHOUT an initializer. The legacy wrapper added
 * `= undefined`; here that initializer is a write of `undefined` into a cell
 * whose other writes the local-bindings census joins, so every such cell became
 * an `undefined`-armed union (or refused the write outright), while a cell
 * with no initializer is exactly the shape that census exists for.
 */
const rewriteBody = (body) => {
  const sourceFile = ts.createSourceFile('test262-body.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits = []
  const isName = (node, name) => ts.isIdentifier(node) && node.text === name
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (isName(callee, 'assert')) {
        edits.push({ start: callee.getStart(sourceFile), end: callee.end, text: 'assert.ok' })
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        isName(callee.expression, 'assert') &&
        (callee.name.text === 'throws' || callee.name.text === 'throwsAsync') &&
        node.arguments.length >= 2
      ) {
        const first = node.arguments[0]
        const second = node.arguments[1]
        edits.push({ start: first.getStart(sourceFile), end: second.getStart(sourceFile), text: '' })
        if (callee.name.text === 'throwsAsync')
          edits.push({ start: callee.getStart(sourceFile), end: callee.end, text: '__gea_throws_async' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (edits.length === 0) return body
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let out = body
  for (const edit of edits) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  return out
}

const indent = (source, spaces = 2) => {
  const prefix = ' '.repeat(spaces)
  let continues = false
  return source
    .split(/\n/)
    .map((line) => {
      const out = continues ? line : `${prefix}${line}`
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      let count = 0
      for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === '\\'; index--) count++
      continues = count % 2 === 1
      return out
    })
    .join('\n')
}

const entrySource = (source, includes, metadata, options) => {
  const body = rewriteBody(
    source
      .replace(/\/\*---[\s\S]*?---\*\//, '')
      .replace(/^#!.*\n/, '')
      .trim()
  )
  const async = metadata.flags.includes('async')
  // The harness files call the same bare `assert(...)` the bodies do, against
  // the same object-literal shim, so they take the same rewrite.
  const includeSource = includes.map(rewriteBody).join('\n\n')
  const needsThrowsAsync = async && /\bassert\s*\.\s*throwsAsync\b/.test(`${body}\n${includeSource}`)
  const prefix = [
    '// @ts-nocheck',
    '"use strict";',
    shimHarness(),
    async ? asyncDoneHarness() : '',
    includeSource,
    needsThrowsAsync ? throwsAsyncHarness() : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  // The body stays at TOP LEVEL, inside one `try`: test262 runs a test as a
  // global script, so its `var`s and functions are the program's own globals
  // and a closure over them is a closure over globals -- wrapping the body in
  // a function turned every one of them into a captured local of that
  // function, which is a different program (and one this compiler had to
  // transport environments for). A `try` block keeps hoisting intact: `var`
  // and function declarations hoist out of it, and nothing outside the block
  // reads a `let`/`const`/`class` declared in it.
  //
  // The verdict is one word on stdout. A thrown Test262Error is reported by
  // message; anything else thrown is just `fail` -- `String(e)` on an unknown
  // thrown value is the one ToString this runtime does not implement, and a
  // runner must not abort on the way to reporting a failure.
  const failure = "e instanceof Test262Error ? 'fail: ' + e.message : 'fail'"
  if (async) {
    return `${prefix}

let __gea_verdict = 'pass'
try {
${indent(body)}
} catch (e) {
  __gea_verdict = ${failure}
}

/** @returns {Promise<string>} */
async function __gea_finish() {
  await Promise.resolve(0)
  await Promise.resolve(0)
  if (__gea_verdict !== 'pass') return __gea_verdict
  return __gea_async_done_status === 'pass' ? 'pass' : 'fail: async status ' + __gea_async_done_status
}
__gea_finish().then(/** @param {string} verdict */ function (verdict) { console.log(verdict) })
`
  }
  if (options.negativeRuntime) {
    return `${prefix}

let __gea_verdict = 'fail: expected a runtime error'
try {
${indent(body)}
} catch (e) {
  __gea_verdict = 'pass'
}
console.log(__gea_verdict)
`
  }
  return `${prefix}

let __gea_verdict = 'pass'
try {
${indent(body)}
} catch (e) {
  __gea_verdict = ${failure}
}
console.log(__gea_verdict)
`
}

// ---------------------------------------------------------------------------
// Worker: compile, build, run one case at a time.
// ---------------------------------------------------------------------------

const engineRoots = [
  'core/packages/core/include',
  'core/packages/host/include',
  'core/packages/engine',
  'core/packages/engine/ui',
  'core/packages/elements',
  'core/packages/elements/ui'
]
const runtimeDir = join(here, 'src', 'targets', 'cpp', 'runtime')
const runtimeHeaders = ['gea_runtime.h', 'gea_dynamic_proxy.h', 'gea_eval.h', 'gea_native_class_prototype.h']

const normalizeReason = (reason) => reason.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 140)

/** A `// @ts-nocheck` entry still has to PARSE. TypeScript diagnostics for the negative-parse rule, the legacy way: any diagnostic passes. */
/**
 * TypeScript's PARSER rejecting a valid ECMAScript program -- a Unicode 10
 * identifier part, a private name the scanner does not accept -- is not this
 * compiler's answer and never can be; the legacy sweep skipped these as
 * "unsupported TypeScript parse/check diagnostic" and this keeps that column
 * comparable. Only syntactic diagnostics qualify: `@ts-nocheck` already
 * silences the checker, so a semantic diagnostic reaching the compiler is the
 * compiler's own refusal and stays counted against it.
 */
const typescriptParseDiagnosticOf = (entry) => {
  const sourceFile = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const first = sourceFile.parseDiagnostics?.[0]
  return first ? `TS${first.code}: ${ts.flattenDiagnosticMessageText(first.messageText, '\n').split('\n')[0]}` : null
}

const typescriptDiagnosticsOf = (entry) => {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: false,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    types: []
  })
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').split('\n')[0])
}

const runWorker = async () => {
  const workerId = Number(flag('--worker', 0))
  const { compile } = await import(`${here}/dist/compiler.js`)
  const includeDir = join(measurementsDir, 'include')
  const includes = [`-I${includeDir}`, ...engineRoots.map((root) => `-I${join(here, '..', root)}`)]
  const pch = join(includeDir, 'gea_runtime.h.pch')
  const pchArguments = existsSync(pch) ? ['-include-pch', pch] : []
  const workDir = join(measurementsDir, 'work', `w${workerId}`)
  mkdirSync(workDir, { recursive: true })

  const runCase = (task) => {
    const started = Date.now()
    const { relativePath, file } = task
    const source = readFileSync(file, 'utf8')
    const { metadata, includes: resolved } = relevance(relativePath, source)
    const negativeParse = !!metadata.negative && isCompileTimeNegativePhase(metadata.negative.phase)
    const negativeRuntime = metadata.negative?.phase === 'runtime'
    const caseDir = join(workDir, String(task.index))
    rmSync(caseDir, { recursive: true, force: true })
    mkdirSync(caseDir, { recursive: true })
    // A JAVASCRIPT entry, compiled as JavaScript: test262 is JS, and the
    // checker's JS-only inference is part of the language's meaning here -- a
    // pre-class `function F() { this.x = 1 }` invoked as `new F()` has a
    // construct signature and a constructed type only in a JS file; as
    // `test.ts` every such construction was `any` against a `void` return and
    // refused as a return-type disagreement (25 of one 1-in-20 sample).
    const entry = join(caseDir, 'test.js')
    // A negative-parse case is compiled WITHOUT `@ts-nocheck`: the diagnostic is the assertion.
    const text = entrySource(source, resolved.sources, metadata, { negativeRuntime })
    writeFileSync(entry, negativeParse ? text.replace('// @ts-nocheck\n', '') : text)
    const done = (status, reason, extra = {}) => {
      if (!keepFailures || status === 'pass') rmSync(caseDir, { recursive: true, force: true })
      return { index: task.index, relativePath, status, reason: reason ?? null, durationMs: Date.now() - started, ...extra }
    }

    if (negativeParse) {
      const diagnostics = typescriptDiagnosticsOf(entry)
      if (diagnostics.length > 0) return done('pass', null, { diagnostic: diagnostics[0] })
      return done(
        'skip',
        `TypeScript permits ${metadata.negative.type ?? 'this construct'} where ECMAScript requires a ${metadata.negative.phase ?? 'compile-time'} diagnostic`
      )
    }

    const parseDiagnostic = typescriptParseDiagnosticOf(entry)
    if (parseDiagnostic !== null) return done('skip', `unsupported TypeScript parse diagnostic: ${parseDiagnostic}`)

    let result
    try {
      result = compile({
        // No project file: the entry is the whole program (a shared project
        // directory pulled sibling cases in), and the compiler's own default
        // options apply -- `strict`, so `null`/`undefined` stay their own
        // types and an unannotated `var` evolves at each read.
        rootFileNames: [entry],
        projectFileName: null,
        javaScriptSources: true,
        dynamicFallback,
        unitBaseName: 'test'
      })
    } catch (error) {
      return done('refused', `compiler threw: ${normalizeReason(String(error?.message ?? error))}`, { phase: 'compiler-crash' })
    }
    if (result.units.length === 0) {
      const diagnostics = result.diagnostics.diagnostics
      const root = diagnostics.find((diagnostic) => diagnostic.severity === 'root') ?? diagnostics[0]
      if (result.certificate === null) {
        if (root) return done('refused', `diagnostic: ${normalizeReason(root.message)}`, { phase: 'diagnostic' })
        const first = result.refusals.find((row) => row.stage === 'certify') ?? result.refusals[0]
        const reason = first ? `${first.key}: ${normalizeReason(first.reason)}` : `${result.refusals.length} refusal(s)`
        return done('refused', `certify: ${reason}`, { phase: 'certify' })
      }
      const blocker = result.loweringBlockers[0]
      if (blocker) return done('refused', `lowering: ${normalizeReason(blocker.reason)}`, { phase: 'lowering' })
      const refusal = result.emissionRefusals[0]
      if (refusal) return done('refused', `emission: ${normalizeReason(refusal.reason)}`, { phase: 'emission' })
      return done('refused', 'certified but nothing emitted', { phase: 'emission' })
    }

    const units = []
    for (const unit of result.units) {
      const path = join(caseDir, unit.fileName)
      writeFileSync(path, `${unit.source}\n`)
      if (unit.role !== 'header' && unit.role !== 'runtime-header') units.push(path)
    }
    writeFileSync(
      join(caseDir, 'generated_support.hpp'),
      ['#pragma once', '#include "gea_runtime.h"', ...result.generatedSupportIncludes.map((header) => `#include "${header}"`), ''].join(
        '\n'
      )
    )
    for (const write of result.artifacts) write(caseDir)
    const shim = join(caseDir, 'main_shim.cpp')
    writeFileSync(shim, 'extern void __gea_top_level();\nint main() { __gea_top_level(); return 0; }\n')
    const binary = join(caseDir, 'program')
    const built = spawnSync('clang++', ['-std=c++20', '-O0', ...pchArguments, `-I${caseDir}`, ...includes, '-o', binary, ...units, shim], {
      encoding: 'utf8',
      timeout: buildTimeoutMs
    })
    if (built.status !== 0) {
      const firstError =
        (built.stderr ?? '').split('\n').find((line) => line.includes('error:')) ?? (built.stderr ?? '').split('\n')[0] ?? ''
      const reason =
        built.signal === 'SIGTERM' ? 'native C++ build timeout' : `cxx: ${normalizeReason(firstError.replace(/^.*?error:\s*/, ''))}`
      return done('cxx-fail', reason, { phase: 'build', stderrTail: (built.stderr ?? '').split('\n').slice(0, 12).join('\n') })
    }
    const ran = spawnSync(binary, { encoding: 'utf8', timeout: runTimeoutMs, maxBuffer: 64 * 1024 * 1024 })
    const stdout = (ran.stdout ?? '').trim()
    if (ran.status === 0 && stdout === 'pass') return done('pass', null)
    if (ran.signal === 'SIGTERM' && ran.status === null) return done('fail', 'compiled executable timeout', { phase: 'run' })
    if (ran.signal) {
      const abort = (ran.stderr ?? '').split('\n').find((line) => line.startsWith('gea:') || line.includes('terminating'))
      return done('fail', `signal ${ran.signal}${abort ? `: ${normalizeReason(abort)}` : ''}`, {
        phase: 'run',
        stderrTail: (ran.stderr ?? '').split('\n').slice(-6).join('\n')
      })
    }
    if (ran.status !== 0)
      return done('fail', `compiled executable exited with status ${ran.status}`, {
        phase: 'run',
        stderrTail: (ran.stderr ?? '').split('\n').slice(-6).join('\n')
      })
    const verdict = stdout.split('\n').find((line) => line.startsWith('fail')) ?? stdout.split('\n').at(-1) ?? ''
    return done(
      'fail',
      verdict.startsWith('fail') ? normalizeReason(verdict) : `expected stdout "pass", got ${JSON.stringify(stdout.slice(0, 80))}`,
      { phase: 'run' }
    )
  }

  process.on('message', (task) => {
    if (task === 'stop') process.exit(0)
    let outcome
    try {
      outcome = runCase(task)
    } catch (error) {
      outcome = {
        index: task.index,
        relativePath: task.relativePath,
        status: 'refused',
        reason: `runner threw: ${normalizeReason(String(error?.stack ?? error))}`,
        phase: 'runner-crash',
        durationMs: 0
      }
    }
    process.send(outcome)
  })
  process.send('ready')
}

// ---------------------------------------------------------------------------
// Coordinator.
// ---------------------------------------------------------------------------

const prepareIncludeDir = () => {
  const includeDir = join(measurementsDir, 'include')
  mkdirSync(includeDir, { recursive: true })
  for (const header of runtimeHeaders) writeFileSync(join(includeDir, header), readFileSync(join(runtimeDir, header), 'utf8'))
  // One precompiled runtime header for every case: the runtime is ~1 MB of
  // C++ and every emitted unit re-parses it. The unit's own
  // `#include "gea_runtime.h"` is then a no-op behind the header guard.
  const pch = join(includeDir, 'gea_runtime.h.pch')
  const built = spawnSync('clang++', ['-std=c++20', '-O0', '-x', 'c++-header', join(includeDir, 'gea_runtime.h'), '-o', pch], {
    encoding: 'utf8'
  })
  if (built.status !== 0) {
    rmSync(pch, { force: true })
    process.stderr.write(`test262: no runtime PCH (${(built.stderr ?? '').split('\n')[0]}); units will parse the runtime each time\n`)
  }
  return includeDir
}

const runCoordinator = async () => {
  if (!existsSync(testDir)) {
    console.error(`test262: no checkout at ${test262Root}; restore vendor/test262 first (see the header)`)
    process.exit(2)
  }
  const label = flag('--label', dynamicFallback ? 'dynamic' : 'latest')
  const paths = flags('--path')
  const match = flag('--match', null)
  const sample = Number(flag('--sample', 1))
  const limit = Number(flag('--limit', Infinity))
  const offset = Number(flag('--offset', 0))
  const workers = Number(flag('--workers', Math.max(1, Math.min(8, cpus().length - 4))))

  const roots = paths.length === 0 ? [testDir] : paths.map((path) => (existsSync(resolve(path)) ? resolve(path) : join(testDir, path)))
  const allFiles = filesList
    ? readFileSync(filesList, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((relativePath) => join(testDir, relativePath))
    : [
        ...new Set(
          roots.flatMap((root) => (existsSync(root) && statSync(root).isDirectory() ? listTestFiles(root) : existsSync(root) ? [root] : []))
        )
      ].sort()
  const records = []
  const candidates = []
  for (const file of allFiles) {
    const relativePath = relative(testDir, file).replace(/\\/g, '/')
    if (match && !relativePath.includes(match)) continue
    const source = readFileSync(file, 'utf8')
    const verdict = relevance(relativePath, source)
    if (!verdict.selected) continue
    if (verdict.skip) records.push({ relativePath, status: 'skip', reason: verdict.skip, durationMs: 0 })
    else candidates.push({ relativePath, file })
  }
  const selected = candidates.length + records.length
  const slice = candidates.filter((_, index) => index % sample === 0).slice(offset, offset + limit)
  slice.forEach((task, index) => (task.index = index))
  if (listJson) {
    // The manifest's view: what the policy selected, what it skipped, and the
    // candidates in path order -- so a cloud run's denominator is decided once.
    process.stdout.write(
      `${JSON.stringify({ files: allFiles.length, selected, skips: records.map(({ relativePath, reason }) => ({ relativePath, reason })), candidates: slice.map((task) => task.relativePath) })}\n`
    )
    return
  }
  process.stderr.write(
    `test262: ${allFiles.length} files, ${selected} selected by the expanded policy, ${records.length} skipped by the current policy, ${candidates.length} candidates, running ${slice.length} on ${workers} worker(s)${dynamicFallback ? ' with --dynamic-fallback' : ''}\n`
  )

  mkdirSync(measurementsDir, { recursive: true })
  prepareIncludeDir()
  rmSync(join(measurementsDir, 'work'), { recursive: true, force: true })

  const started = Date.now()
  const results = new Array(slice.length)
  let next = 0
  let finished = 0
  const counts = { pass: 0, fail: 0, refused: 0, 'cxx-fail': 0 }
  await new Promise((resolveAll) => {
    const finishIfDone = () => {
      if (finished === slice.length) resolveAll()
    }
    if (slice.length === 0) return resolveAll()
    const record = (message) => {
      results[message.index] = message
      counts[message.status] = (counts[message.status] ?? 0) + 1
      finished++
      if (finished % 200 === 0 || finished === slice.length) {
        const elapsed = (Date.now() - started) / 1000
        process.stderr.write(
          `test262: ${finished}/${slice.length} in ${elapsed.toFixed(0)}s -- pass ${counts.pass} fail ${counts.fail} refused ${counts.refused} cxx-fail ${counts['cxx-fail']}\n`
        )
      }
    }
    // A worker that dies (an OOM kill shows as exit `null`) takes exactly one
    // case with it: that case is recorded as a crash under its own name and
    // a fresh worker takes the seat, so one bad case costs one row, never the
    // rest of the chunk -- six dead workers lost 150 of 1277 cases in one
    // cloud sample before this, and left the coordinator awaiting forever.
    let restarts = 0
    const spawn = (id) => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker', String(id), ...argv], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      let inFlight = null
      const feed = () => {
        if (next >= slice.length) {
          inFlight = null
          return child.send('stop')
        }
        inFlight = slice[next++]
        child.send(inFlight)
      }
      child.on('message', (message) => {
        if (message === 'ready') return feed()
        inFlight = null
        record(message)
        finishIfDone()
        feed()
      })
      child.on('exit', (code, signal) => {
        if (inFlight) {
          const lost = inFlight
          inFlight = null
          process.stderr.write(`test262: worker ${id} exited with ${code ?? signal} on ${lost.relativePath}; recorded as a crash\n`)
          record({
            index: lost.index,
            relativePath: lost.relativePath,
            status: 'refused',
            reason: `runner worker died (exit ${code ?? signal}) while compiling or running this case`,
            phase: 'worker-crash',
            durationMs: 0
          })
        }
        if (finished < slice.length && next < slice.length && restarts < slice.length) {
          restarts++
          spawn(id)
        }
        finishIfDone()
      })
    }
    for (let id = 0; id < workers; id++) spawn(id)
  })

  const all = [...records, ...results.filter(Boolean)]
  const byStatus = {}
  for (const record of all) byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
  const reasons = {}
  for (const record of all) {
    if (record.status === 'pass') continue
    const key = `${record.status} | ${normalizeReason(record.reason ?? '')}`
    reasons[key] = (reasons[key] ?? 0) + 1
  }
  const ranked = Object.entries(reasons).sort((a, b) => b[1] - a[1])
  const summary = {
    label,
    generatedAt: new Date().toISOString(),
    test262Root,
    dynamicFallback,
    sample,
    files: allFiles.length,
    selected,
    candidates: candidates.length,
    ran: slice.length,
    counts: byStatus,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    legacyReference: { runId: 'tsc-20260702-172857-test262', selected: 37138, pass: 21045, fail: 4160, skip: 11933 },
    reasons: ranked.slice(0, 200).map(([reason, count]) => ({ reason, count })),
    cases: all
  }
  const written = outPath ? resolve(outPath) : join(measurementsDir, `${label}.json`)
  mkdirSync(dirname(written), { recursive: true })
  writeFileSync(written, `${JSON.stringify(summary, null, 2)}\n`)

  const ranCount = slice.length
  const line = (name, value) => `${name.padEnd(10)} ${String(value).padStart(7)}`
  console.log(
    `test262 (${label}): ${allFiles.length} files, ${selected} selected, ${ranCount} run${sample > 1 ? ` (every ${sample}th candidate)` : ''}`
  )
  for (const status of ['pass', 'fail', 'cxx-fail', 'refused', 'skip']) console.log(line(status, byStatus[status] ?? 0))
  if (ranCount > 0) {
    const passRate = ((byStatus.pass ?? 0) / ranCount) * 100
    console.log(
      `pass rate over run cases: ${passRate.toFixed(1)}%${sample > 1 ? ` (projects to ~${Math.round((passRate / 100) * candidates.length)} of ${candidates.length} candidates)` : ''}`
    )
  }
  console.log(
    `legacy reference (${summary.legacyReference.runId}): pass ${summary.legacyReference.pass} fail ${summary.legacyReference.fail} skip ${summary.legacyReference.skip} of ${summary.legacyReference.selected}`
  )
  console.log('\nranked reasons:')
  for (const [reason, count] of ranked.slice(0, 40)) console.log(`${String(count).padStart(6)}  ${reason}`)
  console.log(`\nwrote ${relative(here, written)}`)
}

if (argv.includes('--worker')) await runWorker()
else await runCoordinator()
