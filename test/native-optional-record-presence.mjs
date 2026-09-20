import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { walkRepresentation } from '../dist/representation/model.js'

const root = resolve(import.meta.dirname, '..')

test('optional record fields distinguish absence from present undefined and delete without boxing', () => {
  const file = resolve(root, 'test/runtime/native-optional-record-presence.ts')
  const result = compile({ rootFileNames: [file], projectFileName: null })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const records = [...result.representations.plan.selected.values()].filter(
    (carrier) => carrier.kind === 'record' || carrier.kind === 'record-with-index'
  )
  assert.ok(records.length > 0)
  for (const carrier of records) {
    assert.ok(
      [...walkRepresentation(carrier)].every((nested) => nested.kind !== 'dynamic'),
      'typed record storage remains native'
    )
  }
  // The unused adapter exposes declared fields to genuinely dynamic callers.
  // Its definition is not a boxed operation in this typed fixture; check both
  // the authoritative selections above and executable generated code below.
  const operations = result.source.replace(/  (?:virtual )?bool gea_readOwnField\([^]*?\n  }/g, '')
  assert.doesNotMatch(operations, /gea_cpp_value|Value::box\(gea::Value::Tag::Object|\.callAsFunction/)
  const binary = resolve(root, `measurements/native-optional-record-presence${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    { input: `${result.source}\nint main() { __gea_top_level(); }\n` }
  )
  assert.equal(execFileSync(binary, { encoding: 'utf8' }), execFileSync(process.execPath, [file], { encoding: 'utf8' }))
})

test('deleting a required native record field remains fail-closed', () => {
  const result = compile({
    rootFileNames: [resolve(root, 'test/runtime/native-required-record-delete.js')],
    projectFileName: resolve(root, 'test/runtime/inferred-return-union.tsconfig.json'),
    javaScriptSources: true
  })
  assert.equal(result.certificate, null)
  // Site-level capabilities are certified off the IR and refused as
  // `CompileResult.refusals`, not as diagnostics (diagnostics/sweep.ts): the
  // required field's constant-key delete demands the plain `record:delete`
  // row, which the manifest does not claim (`deleteNamesRecordExpandoKey`,
  // ir/certify/property-access.ts).
  assert.ok(
    result.refusals.some((refusal) => refusal.stage === 'certify' && refusal.key === 'property-access:record:delete:false'),
    JSON.stringify(result.refusals)
  )
})
