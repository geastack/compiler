import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { walkRepresentation } from '../dist/representation/model.js'

const root = resolve(import.meta.dirname, '..')
const fixture = resolve(root, 'test/runtime/stored-listener-native-flow.js')
const source = readFileSync(fixture, 'utf8')
const binary = resolve(root, `measurements/stored-listener-native-flow${executableSuffix}`)
const environment = { ...process.env, TMPDIR: resolve(root, 'measurements'), CCACHE_DISABLE: '1', UBSAN_OPTIONS: 'halt_on_error=1' }
const fieldSource = `
let observed = 0
class Leaf { run(value) { observed += value } }
class Holder {
  field = new Leaf()
  dispatch(value) { this.field.run(value) }
}
new Holder().dispatch(23);
(observed === 23 ? new Date(0) : new Date(NaN)).toISOString()
`
for (const [name, input] of [
  ['stored listener', source],
  ['object field receiver', fieldSource]
]) {
  for (const valid of [true, false]) {
    const program = valid ? input : input.replace('observed === 23', 'observed === 24')
    const result = compile({
      rootFileNames: [fixture],
      projectFileName: resolve(root, 'test/runtime/stored-listener-native-flow.tsconfig.json'),
      javaScriptSources: true,
      // The fixture is the whole program: a classic script's top-level `const`
      // is a global an unseen sibling script could write until the caller
      // states the realm is closed (`localBindingWritesAreComplete`), and the
      // receiver census refuses `resource` before the listener question is reached.
      closedScriptScope: true,
      sourceOverlay: new Map([[fixture, program]])
    })
    assert.ok(
      result.certificate,
      JSON.stringify({
        diagnostics: result.diagnostics.diagnostics,
        refusals: result.refusals,
        blockers: result.loweringBlockers,
        emission: result.emissionRefusals
      })
    )
    assert.deepEqual(result.loweringBlockers, [])
    assert.deepEqual(result.emissionRefusals, [])
    assert.ok(result.source)
    assert.equal(
      [...result.representations.plan.selected.values()].filter((value) =>
        [...walkRepresentation(value)].some((part) => part.kind === 'dynamic')
      ).length,
      0
    )
    const executable = result.source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    assert.doesNotMatch(executable, /\bgea::Value\b|\bgea_cpp_value\b|\bValue::box\w*\s*[<(]|\bunbox\w*\s*[<(]/)
    execFileSync(
      'clang++',
      [
        '-std=c++20',
        '-O1',
        '-fsanitize=address,undefined',
        `-I${resolve(root, 'src/targets/cpp/runtime')}`,
        '-x',
        'c++',
        '-',
        '-o',
        binary
      ],
      {
        input: `${result.source}
int main() {
  try { __gea_top_level(); return 0; }
  catch (const gea::Value& error) {
    if (!gea::host::isRuntimeError(error)) return 2;
    std::fprintf(stderr, "%s\\n", gea::host::runtimeErrorString(error).c_str());
    return 1;
  }
}
`,
        env: environment
      }
    )
    const native = spawnSync(binary, [], { encoding: 'utf8', env: environment })
    const javascript = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' })
    assert.equal(native.error, undefined)
    assert.equal(javascript.error, undefined)
    assert.equal(native.status === 0, valid, native.stderr)
    assert.equal(javascript.status === 0, valid, javascript.stderr)
    assert.doesNotMatch(native.stderr, /AddressSanitizer|runtime error:/)
    if (!valid) {
      assert.equal(native.status, 1)
      assert.match(native.stderr, /RangeError: Invalid time value/)
      assert.match(javascript.stderr, /RangeError: Invalid time value/)
    }
  }
  console.log(`PASS ${name}: zero selected dynamic carriers, zero emitted boxing, checked result and failure parity under ASan/UBSan`)
}
