import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
writeFileSync(header, '#pragma once\n#include "native cache test dependency.h"\n#include <cstdio>\n')
writeFileSync(dependency, '#define CACHE_TEST_VALUE 17\n')
writeFileSync(source, '#include "native-cache-test-runtime.h"\nint main() { std::printf("%d\\n", CACHE_TEST_VALUE); }\n')
const options = { out, units: [source], includes: [`-I${out}`], runtimeHeader: header }
const printed = () => execFileSync(join(out, 'program'), { encoding: 'utf8' }).trim()
const cold = buildNative(options)
assert.equal(printed(), '17')
const warm = buildNative(options)
assert.equal(warm.pch, 'reused')
assert.equal(printed(), '17')
console.log('PASS repeated build reuses PCH and preserves output', JSON.stringify({ cold, warm }))

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
writeFileSync(dependency, '#define CACHE_TEST_VALUE 23\n')
assert.equal(buildNative(options).pch, 'built')
assert.equal(printed(), 'changed 23')
console.log('PASS failed PCH build is never reused; fixed header rebuilds')
