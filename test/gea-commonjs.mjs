import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { adoptGeaPackage, geaCommonJsGlobals } from '../dist/plugins/gea/host.js'

const root = resolve(import.meta.dirname, '..')
const plugin = resolve(root, '../core/packages/geatsc-plugin-gea')
adoptGeaPackage(resolve(plugin, 'dist/index.js'))
assert.equal(geaCommonJsGlobals().size, 3)
const result = compile({
  rootFileNames: [resolve(plugin, 'test/commonjs-entry.cjs')],
  projectFileName: resolve(plugin, 'test/commonjs.tsconfig.json')
})
assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
assert.deepEqual(result.loweringBlockers, [])
assert.deepEqual(result.emissionRefusals, [])
const loads = [...result.graph.operations.values()].filter((operation) => operation.commonJsRequire)
assert.equal(loads.length, 2)
assert.ok(loads.every((operation) => operation.commonJsRequire.nativeRecord))
for (const operation of loads) {
  const value = operation.results.find((result) => result.role === 'value')
  assert.ok(value)
  assert.notEqual(result.representations.plan.selected.get(value.id)?.kind, 'dynamic')
}
// Errors cross the JS throw boundary through its dynamic carrier; module
// values and class instances must retain their native representation.
for (const line of result.source.split('\n').filter((line) => line.includes('gea::Value::box'))) {
  assert.match(line, /^GEA_THROW\(.*gea::runtime::Error/)
}
const binary = resolve(root, 'dist/test_gea_commonjs')
execFileSync(
  'clang++',
  ['-std=c++20', ...nativeOptimization('correctness'), `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
  {
    input: result.source + '\nint main() { __gea_top_level(); }\n',
    stdio: ['pipe', 'inherit', 'inherit']
  }
)
execFileSync(binary, { stdio: 'inherit' })
console.log('Gea CommonJS: host-owned wrappers, native module identity and state passed')
