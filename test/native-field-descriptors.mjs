import { executableSuffix } from './executable-suffix.mjs'
import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const include = `-I${resolve(root, 'src/targets/cpp/runtime')}`
const runtimeBinary = resolve(output, `native-field-descriptor-runtime${executableSuffix}`)
execFileSync('clang++', [
  '-std=c++20',
  ...nativeOptimization('correctness'),
  '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all',
  include,
  resolve(root, 'test/runtime/native-field-descriptor-runtime.cpp'),
  '-o',
  runtimeBinary
])
execFileSync(runtimeBinary, { stdio: 'inherit' })

const entry = resolve(root, 'test/runtime/native-field-descriptor.ts')
// Compiled as a Script: a lone root that cannot observe the difference is
// given the module goal, where the closed fields no longer reach the dynamic
// descriptor adapter this test is about. Mentioning `globalThis` keeps it one.
const program = `void globalThis\n${readFileSync(entry, 'utf8')}`
const result = compile({
  rootFileNames: [entry],
  projectFileName: null,
  dynamicFallback: false,
  sourceOverlay: new Map([[entry, program]])
})
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
assert.match(result.source ?? '', /gea::applyNativeFieldDescriptor<double, gea::NativeFieldLeafPolicy>\(/)
assert.ok(result.source?.includes('gea::detail::applyNativeDynamicFieldDescriptor('))
assert.equal(
  result.source?.includes('gea_current = gea::PropertyDescriptor::assignment(gea::detail::readDynamicField'),
  false,
  'A dynamic-carrier descriptor update must not box its current native value'
)
assert.equal(
  result.source.includes('gea_current = gea::PropertyDescriptor::assignment(gea::Value::box('),
  false,
  'A fixed-field descriptor update must not box its current native value'
)
const executable = resolve(output, `native-field-descriptor${executableSuffix}`)
execFileSync('clang++', ['-std=c++20', ...nativeOptimization('correctness'), include, '-x', 'c++', '-', '-o', executable], {
  input: `${result.source}\nint main() { __gea_top_level(); }\n`,
  env: { ...process.env, TMPDIR: output }
})
const native = execFileSync(executable, { encoding: 'utf8' })
const js = ts.transpileModule(program, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
const reference = execFileSync(process.execPath, ['--input-type=module'], { input: js, encoding: 'utf8' })
assert.equal(native, reference, 'Generated field descriptors must agree with Node')
console.log('PASS native field descriptor emission and execution match Node')
