import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const include = `-I${resolve(root, 'src/targets/cpp/runtime')}`
const runtimeBinary = resolve(output, 'native-field-descriptor-runtime')
execFileSync('clang++', [
  '-std=c++20',
  '-O0',
  '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all',
  include,
  resolve(root, 'test/runtime/native-field-descriptor-runtime.cpp'),
  '-o',
  runtimeBinary
])
execFileSync(runtimeBinary, { stdio: 'inherit' })

const entry = resolve(root, 'test/runtime/native-field-descriptor.ts')
const result = compile({ rootFileNames: [entry], projectFileName: null, dynamicFallback: false })
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
assert.ok(result.source?.includes('gea::applyNativeFieldDescriptor('))
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
const executable = resolve(output, 'native-field-descriptor')
execFileSync('clang++', ['-std=c++20', '-O1', include, '-x', 'c++', '-', '-o', executable], {
  input: `${result.source}\nint main() { __gea_top_level(); }\n`,
  env: { ...process.env, TMPDIR: output }
})
const native = execFileSync(executable, { encoding: 'utf8' })
const js = ts.transpileModule(readFileSync(entry, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
const reference = execFileSync(process.execPath, ['--input-type=module'], { input: js, encoding: 'utf8' })
assert.equal(native, reference, 'Generated field descriptors must agree with Node')
console.log('PASS native field descriptor emission and execution match Node')
