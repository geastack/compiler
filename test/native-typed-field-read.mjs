import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const protocolBinary = resolve(root, 'dist/native-typed-field-protocol')
execFileSync(
  'clang++',
  [
    '-std=c++20',
    '-O1',
    '-DGEA_PROFILE_ALLOCATIONS=1',
    '-fsanitize=address,undefined',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    resolve(root, 'test/runtime/native-typed-field-read.cpp'),
    '-o',
    protocolBinary
  ],
  { stdio: 'inherit' }
)
execFileSync(protocolBinary, { stdio: 'inherit' })
const fixture = resolve(root, 'test/runtime/native-typed-field-read.ts')
const result = compile({ rootFileNames: [fixture], projectFileName: null })
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
assert.match(result.source, /gea::nativeFieldGet</)
const binary = resolve(root, `dist/native-typed-field-read${executableSuffix}`)
execFileSync(
  'clang++',
  [
    '-std=c++20',
    '-O1',
    '-DGEA_PROFILE_ALLOCATIONS=1',
    '-fsanitize=address,undefined',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    binary
  ],
  {
    input:
      result.source +
      `
int main() {
  __gea_top_level();
  // Ten thousand native field reads must not create ten thousand wrappers.
  if (gea::detail::allocationProfile().created >= 100) return 2;
}
`
  }
)
assert.equal(execFileSync(binary, { encoding: 'utf8' }), execFileSync(process.execPath, [fixture], { encoding: 'utf8' }))
console.log('Native subclass field reads preserve identity with no per-read allocation')
