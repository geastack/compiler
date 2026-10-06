import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'
import { noPluginCapabilities } from '../dist/plugins/model.js'
import { cppBodyName } from '../dist/targets/cpp/types.js'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements')
const entry = resolve(root, 'test/native-function-signatures.ts')
const declarationFileName = resolve(root, 'test/native-function-signatures.d.ts')
const header = resolve(root, 'test/native-signatures.h')
const identity = () =>
  createHash('sha256')
    .update(readFileSync(resolve(root, 'dist/compiler.js')))
    .digest('hex')
const initialIdentity = identity()
const declarations = [
  ['integerHost', 'integerAlias'],
  ['fractionalHost', 'fractionalAlias']
].map(([declarationName, cppName]) => ({
  declarationFileName,
  declarationName,
  inspection: { cppFunction: `gea::signature_test::${cppName}`, headers: [header] }
}))
const plugin = {
  name: 'native-callback-execution-fixture',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      nativeFunctionDeclarations: declarations,
      hostFunctions: new Map(declarations.map((row) => [row.declarationName, row.inspection.cppFunction])),
      hostPreambles: new Map(declarations.map((row) => [row.inspection.cppFunction, [`#include "${header}"`]]))
    }
  })
}
const domain = `function tick(value: number) {
  let result = value % 1000;
  result = (result + 1) % 1000; result = (result + 2) % 1000;
  result = (result + 3) % 1000; result = (result + 4) % 1000;
  result = (result + 5) % 1000; result = (result + 6) % 1000;
  result = (result + 7) % 1000; result = (result + 8) % 1000;
  console.log(result);
}
function frame(value: number) { tick(value); }
`
const referenceHosts = `function integerHost(callback) {
  callback(0); callback(-17); callback(37); callback(2147483647); callback(-2147483648); return 1;
}
function fractionalHost(callback) { callback(0.5); callback(-17.25); callback(37.75); }
`
const nativeHosts = `namespace gea::signature_test {
int integerAlias(IntegerCallback callback) {
  callback(0); callback(-17); callback(37); callback(2147483647); callback(-2147483647 - 1); return 1;
}
void fractionalAlias(FractionalCallback callback) { callback(0.5); callback(-17.25); callback(37.75); }
}
int main() { __gea_top_level(); }
`
const scenarios = [
  { name: 'integer', calls: 'integerHost(frame);', integer: true },
  { name: 'fractional', calls: 'fractionalHost(frame);', integer: false },
  { name: 'mixed', calls: 'integerHost(frame); fractionalHost(frame);', integer: false },
  { name: 'direct-fractional', calls: 'integerHost(frame); frame(0.5);', integer: false }
]

for (const scenario of scenarios) {
  assert.equal(identity(), initialIdentity, 'Canonical compiler changed during native execution verification')
  const source = domain + scenario.calls
  const result = compile({
    rootFileNames: [entry, declarationFileName],
    projectFileName: null,
    plugins: [plugin],
    sourceOverlay: new Map([[entry, source]]),
    includeIr: true
  })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  for (const functionName of ['frame', 'tick']) {
    const body = result.irBodies.find((candidate) => candidate.functionName === functionName)
    assert.ok(body, `Missing ${functionName} IR body`)
    const name = cppBodyName(body.sourceOwner)
    const signature = new RegExp(`\\b${name}\\([^\\n]*\\b${scenario.integer ? 'long long' : 'double'}\\b`)
    assert.match(result.source, signature, `${scenario.name}: ${functionName} must keep the authenticated parameter carrier`)
    if (scenario.integer) assert.ok(!result.source.includes(`${name}_integral`), `${functionName} retained a duplicate integral body`)
  }
  const executable = resolve(output, `native-callback-signatures-${scenario.name}`)
  execFileSync(
    'clang++',
    [
      '-std=c++20',
      '-O1',
      '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all',
      `-I${resolve(root, 'src/targets/cpp/runtime')}`,
      '-x',
      'c++',
      '-',
      '-o',
      executable
    ],
    { input: `${result.source}\n${nativeHosts}`, env: { ...process.env, TMPDIR: output }, timeout: 180_000 }
  )
  const native = execFileSync(executable, { encoding: 'utf8', timeout: 60_000 })
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const reference = execFileSync(process.execPath, ['--input-type=module'], {
    input: referenceHosts + javascript,
    encoding: 'utf8',
    timeout: 60_000
  })
  assert.equal(native, reference, `${scenario.name}: native callbacks must match Node without truncating fractional values`)
  console.log(`PASS ${scenario.name}: frame/tick signatures and Node output match under ASan/UBSan`)
}
assert.equal(identity(), initialIdentity, 'Canonical compiler changed during native execution verification')
