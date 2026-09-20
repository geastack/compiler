import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

test('nested literal fields survive repeated whole-program inference and native execution', () => {
  const root = resolve(import.meta.dirname, '..')
  const fixture = resolve(root, 'test/runtime/inference-fact-stability.js')
  const result = compile({
    rootFileNames: [fixture],
    javaScriptSources: true,
    projectFileName: resolve(root, 'test/runtime/inferred-return-union.tsconfig.json')
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  const binary = resolve(root, `measurements/inference-fact-stability${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    {
      input: `${result.source}\nint main() { __gea_top_level(); }\n`
    }
  )
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), execFileSync(process.execPath, [fixture], { encoding: 'utf8' }))
})
