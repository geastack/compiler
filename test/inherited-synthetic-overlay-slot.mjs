import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

test('a refined inherited synthetic overlay keeps one native storage slot', () => {
  const root = resolve(import.meta.dirname, '..')
  const result = compile({
    rootFileNames: [resolve(root, 'test/runtime/inherited-synthetic-overlay-slot.runtime.js')],
    projectFileName: resolve(root, 'test/runtime/tsconfig.json'),
    javaScriptSources: true
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  assert.equal(result.source.match(/^\s+.* color;$/gm)?.length, 1)
  assert.match(
    result.source,
    /\{ auto gea_field_initializer_value = gea_body_fn_decl_[^(]+\([^;]+\); [^\n]*->color = [^\n]*::ofArm<\d+>[^\n]*gea_field_initializer_value[^\n]*; \}/
  )
  assert.doesNotMatch(result.source, /DynamicCarrier|gea::Value (?:b|v)\d/)

  const binary = resolve(root, `measurements/inherited-synthetic-overlay-slot${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary], {
    input: `${result.source}\nint main() { __gea_top_level(); }\n`
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'synthetic-overlay=16777215/16777215')
})
