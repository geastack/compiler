import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

test('present optional unions and multi-implementor structural views remain native', () => {
  const root = resolve(import.meta.dirname, '..')
  const fixture = resolve(root, 'test/runtime/control-flow-structural-view.ts')
  const result = compile({ rootFileNames: [fixture], projectFileName: null })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  // PrefixRouter and SuffixRouter leave the program through the `TestRouter`
  // interface, a class-to-interface conversion the reflection census fails
  // closed on, so each struct carries the full dynamic protocol. Its
  // descriptor hook holds exactly one `gea::Value gea_descriptor_value` per
  // struct (records.ts, composed from the read hook since 1d4bf32f4): the
  // reflection protocol's own carrier, not a typed value boxed. Every other
  // boxing signal, including the per-field boxing that commit removed, must
  // still be absent.
  assert.doesNotMatch(result.source, /gea_cpp_value|gea::Value (?!gea_descriptor_value\b)(?:gea_|v\d|b\d)|nativeDynamicGet/)
  assert.match(result.source, /gea::record::classStructuralView|gea_view_this|packEnvironment/)

  const binary = resolve(root, `measurements/control-flow-structural-view${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    { input: `${result.source}\nint main() { __gea_top_level(); }\n` }
  )
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), execFileSync(process.execPath, [fixture], { encoding: 'utf8' }))
})
