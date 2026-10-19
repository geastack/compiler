import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'
import { nativeOptimization } from '../scripts/native-optimization.mjs'
import { executableSuffix } from './executable-suffix.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/native-dictionary-accessors')
mkdirSync(output, { recursive: true })
const entry = resolve(root, 'test/runtime/native-dictionary-accessors.ts')
const result = compile({ rootFileNames: [entry], projectFileName: resolve(root, 'test/runtime/tsconfig.json'), closedScriptScope: true })
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
assert.match(result.source ?? '', /gea::detail::nativeDocumentDefine\(/)
assert.match(result.source ?? '', /gea::detail::nativeDocumentDescriptor\(/)
const executable = resolve(output, `native-dictionary-accessors${executableSuffix}`)
execFileSync(
  'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-',
    '-o',
    executable
  ],
  { input: `${result.source}\nint main() { __gea_top_level(); }\n`, env: { ...process.env, TMPDIR: output } }
)
const native = execFileSync(executable, {
  encoding: 'utf8',
  // LeakSanitizer exists only on Linux; asking for it elsewhere aborts the run.
  env: { ...process.env, ASAN_OPTIONS: process.platform === 'linux' ? 'detect_leaks=1' : 'detect_leaks=0' }
})
const referenceSource = ts.transpileModule(readFileSync(entry, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const reference = execFileSync(process.execPath, ['--input-type=module'], { input: referenceSource, encoding: 'utf8' })
assert.equal(reference, '11\n22\n12\ntrue\ntrue\n103\n23\n13\nundefined\n')
assert.equal(native, reference, 'Two owned keys, replacement and retained accessor closure must agree with Node')
console.log('PASS native dictionary accessor emission, ownership and execution match Node')
