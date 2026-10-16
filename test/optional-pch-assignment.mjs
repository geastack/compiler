import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildNative } from '../scripts/native-build-cache.mjs'
import { nativeHostIncludes } from '../scripts/native-host-includes.mjs'

// Exercise the actual normal prebuilt PCH/object producer, not syntax-only
// checking or a private runtime header. Root may compile without execution.
const root = resolve(import.meta.dirname, '..')
const out = resolve(root, 'measurements/optional-pch-assignment')
mkdirSync(out, { recursive: true })
const runtime = resolve(root, 'src/targets/cpp/runtime')
const result = buildNative({
  out,
  units: [resolve(root, 'test/runtime/optional-pch-assignment.cpp')],
  includes: [`-I${runtime}`, ...nativeHostIncludes],
  runtimeHeader: resolve(runtime, 'gea_runtime.h'),
  runtime: 'prebuilt',
  pch: true,
  cache: true
})
assert.equal(result.runtime, 'prebuilt')
console.log(JSON.stringify(result))
if (!process.argv.includes('--build-only')) {
  assert.equal(execFileSync(resolve(out, 'program'), { encoding: 'utf8' }), '')
  console.log('Optional prebuilt PCH assignment controls passed')
}
