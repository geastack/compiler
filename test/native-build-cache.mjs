import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, statSync, utimesSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { buildNative } from '../scripts/native-build-cache.mjs'
import { lockNativeOutput } from '../scripts/native-output-lock.mjs'

const index = process.argv.indexOf('--out-dir')
assert.ok(index >= 0, 'Pass --out-dir with an existing build output directory')
const out = resolve(process.argv[index + 1])
assert.ok(existsSync(out))
const release = await lockNativeOutput(out)
await assert.rejects(lockNativeOutput(out, { timeoutMs: 0 }), /Native output is locked/)
const contender = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
  import { lockNativeOutput } from ${JSON.stringify(new URL('../scripts/native-output-lock.mjs', import.meta.url).href)};
  try { await lockNativeOutput(${JSON.stringify(out)}, { timeoutMs: 0 }); }
  catch (error) { console.error(error.message); process.exit(3); }
`
  ],
  { encoding: 'utf8' }
)
assert.equal(contender.status, 3)
assert.match(contender.stderr, /Native output is locked/)
release()
await lockNativeOutput(out)
console.log('PASS output lock rejects overlapping work and can be reacquired after release')
const header = join(out, 'native-cache-test-runtime.h')
const dependency = join(out, 'native cache test dependency.h')
const source = join(out, 'native-cache-test.cpp')
// A macro guard, as the real runtime has: the PCH is built from a sealed copy
// at another path, so `#pragma once` (which is per path) would let the unit's
// own include re-enter the header after the PCH.
const guarded = (body) =>
  `#ifndef CACHE_TEST_RUNTIME\n#define CACHE_TEST_RUNTIME\n#include "native cache test dependency.h"\n#include <cstdio>\n${body}#endif\n`
writeFileSync(header, guarded(''))
writeFileSync(dependency, '#define CACHE_TEST_VALUE 17\n')
writeFileSync(source, '#include "native-cache-test-runtime.h"\nint main() { std::printf("%d\\n", CACHE_TEST_VALUE); }\n')
// The cache is content-addressed and outlives a run, so this test owns one
// inside its own output directory and starts it empty: an entry left by the
// previous run would make every "built" below "reused".
const cacheDirectory = join(out, 'native-cache-test-runtime')
rmSync(cacheDirectory, { recursive: true, force: true })
const options = { out, units: [source], includes: [`-I${out}`], runtimeHeader: header, cacheDirectory }
const printed = () => execFileSync(join(out, 'program'), { encoding: 'utf8' }).trim()
const cold = buildNative(options)
assert.equal(cold.pch, 'built')
assert.equal(printed(), '17')
const warm = buildNative(options)
assert.equal(warm.pch, 'reused')
assert.equal(printed(), '17')
console.log('PASS repeated build reuses PCH and preserves output', JSON.stringify({ cold, warm }))

// A second output directory holding the same header shares the artifact: the
// key abstracts the directory away, and the PCH is built from sealed copies.
const sibling = join(out, 'native-cache-test-sibling')
rmSync(sibling, { recursive: true, force: true })
mkdirSync(sibling)
for (const file of [header, dependency, source]) copyFileSync(file, join(sibling, basename(file)))
const shared = buildNative({
  ...options,
  out: sibling,
  units: [join(sibling, basename(source))],
  includes: [`-I${sibling}`],
  runtimeHeader: join(sibling, basename(header))
})
assert.equal(shared.pch, 'reused')
assert.equal(execFileSync(join(sibling, 'program'), { encoding: 'utf8' }).trim(), '17')
rmSync(sibling, { recursive: true, force: true })
console.log('PASS output directories share one runtime artifact')

// Both runtime layouts produce the same program; prebuilt links the object
// compiled from the PCH, single compiles the runtime into the program.
const inlineRuntime = guarded('inline int cacheTestTwice(int v) { return v * 2; }\n')
writeFileSync(header, inlineRuntime)
writeFileSync(source, '#include "native-cache-test-runtime.h"\nint main() { std::printf("%d\\n", cacheTestTwice(CACHE_TEST_VALUE)); }\n')
assert.equal(buildNative({ ...options, runtime: 'prebuilt' }).runtime, 'prebuilt')
assert.equal(printed(), '34')
assert.equal(buildNative({ ...options, runtime: 'single' }).runtime, 'single')
assert.equal(printed(), '34')
writeFileSync(header, guarded(''))
writeFileSync(source, '#include "native-cache-test-runtime.h"\nint main() { std::printf("%d\\n", CACHE_TEST_VALUE); }\n')
console.log('PASS prebuilt and single runtime layouts build the same program')

// Content changes with identical size AND mtime must invalidate the PCH.
const stamp = statSync(dependency)
writeFileSync(dependency, '#define CACHE_TEST_VALUE 23\n')
utimesSync(dependency, stamp.atime, stamp.mtime)
assert.equal(buildNative(options).pch, 'built')
assert.equal(printed(), '23')
console.log('PASS transitive header content invalidates PCH despite unchanged size and mtime')

assert.equal(buildNative({ ...options, flags: ['-std=c++20', '-g', '-O1'] }).pch, 'built')
assert.equal(printed(), '23')
console.log('PASS compiler flags invalidate PCH')

writeFileSync(source, '#include "native-cache-test-runtime.h"\nint main() { std::printf("changed %d\\n", CACHE_TEST_VALUE); }\n')
buildNative(options)
assert.equal(printed(), 'changed 23')
console.log('PASS changed source is recompiled')

buildNative({ ...options, compileOnly: true })
assert.equal(buildNative({ ...options, cache: false }).pch, 'off')
assert.equal(printed(), 'changed 23')
assert.equal(buildNative({ ...options, pch: false }).pch, 'off')
assert.equal(printed(), 'changed 23')
console.log('PASS syntax-only and cache/PCH opt-outs preserve output')

writeFileSync(dependency, 'this is not valid C++\n')
assert.throws(() => buildNative(options), /failed/)
assert.throws(() => buildNative(options), /failed/)
writeFileSync(dependency, '#define CACHE_TEST_VALUE 29\n')
assert.equal(buildNative(options).pch, 'built')
assert.equal(printed(), 'changed 29')
console.log('PASS failed PCH build is never published; fixed header rebuilds')
rmSync(cacheDirectory, { recursive: true, force: true })
