import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')

test('an optional by-value record field reads natively with no dynamic hook', () => {
  const result = compile({
    rootFileNames: [resolve(root, 'test/runtime/native-optional-record-dynamic-hook.ts')],
    projectFileName: null
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  assert.match(result.source, /gea::Optional<gea_record_type_/)
  // `options.point?.x ?? 0` is a proven-present optional-slot read (the
  // presence proof landed in c67e49217), so FocusOptions and Point carry
  // keys-only reflection demand: no dynamic field hook of any kind is emitted
  // for them, and nothing in the program boxes.
  assert.doesNotMatch(result.source, /dynamicFieldAccepts<gea::Optional<gea_record_type_/)
  assert.doesNotMatch(result.source, /gea_cpp_value|gea::Value (?:gea_|v\d|b\d)/)
  execFileSync('clang++', ['-std=c++20', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-fsyntax-only'], {
    input: `${result.source}\nint main() { __gea_top_level(); }\n`
  })
})
