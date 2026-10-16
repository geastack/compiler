import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// Automatically registered by test/run.mjs; the .runtime.ts entry is also
// registered by the ordinary runtime suite. --node-only never reads dist.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/class-construction-liveness')
const nodeOutput = resolve(output, 'node')
mkdirSync(nodeOutput, { recursive: true })
writeFileSync(resolve(nodeOutput, 'package.json'), JSON.stringify({ type: 'commonjs' }))
const cases = [
  {
    entry: 'class-definition-construction-effects.runtime',
    dependencies: ['_class-definition-construction-effects'],
    expected: [
      'computed',
      'dormant-static',
      'base-static',
      'derived-static',
      'entry',
      'base-instance',
      'base-constructor',
      'derived-instance',
      'derived-constructor',
      'direct 1',
      'base-instance',
      'base-constructor',
      'derived-instance',
      'derived-constructor',
      'escaped 1',
      ''
    ].join('\n'),
    absent: ['DORMANT_INSTANCE_MUST_NOT_RUN', 'DORMANT_CONSTRUCTOR_MUST_NOT_RUN']
  },
  {
    entry: 'class-construction-type-only-namespace.runtime',
    dependencies: ['_construction-type-export-module', '_construction-type-export-hidden', '_construction-type-export-values'],
    expected: ['value-module', 'value-class', 'visible-module', 'visible-constructor', 'visible-value 1', ''].join('\n'),
    absent: [
      'TYPE_ONLY_MODULE_EFFECT_MUST_NOT_RUN',
      'TYPE_ONLY_CLASS_EFFECT_MUST_NOT_RUN',
      'TYPE_ONLY_CONSTRUCTOR_MUST_NOT_RUN',
      'TYPE_ONLY_SHADOW_EFFECT_MUST_NOT_RUN'
    ]
  }
]
for (const { entry, dependencies, expected: oracle, absent } of cases) {
  for (const name of [...dependencies, entry]) {
    const source = readFileSync(resolve(root, 'test/runtime', `${name}.ts`), 'utf8')
    const javascript = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    writeFileSync(resolve(nodeOutput, `${name}.js`), javascript)
  }
  const expected = execFileSync(process.execPath, [resolve(nodeOutput, `${entry}.js`)], { encoding: 'utf8' })
  assert.equal(expected, oracle)
  writeFileSync(resolve(output, `${entry}.node-expected.txt`), expected)
  if (process.argv.includes('--node-only')) {
    process.stdout.write(`${entry}:\n${expected}`)
  } else {
    const native = execFileSync(
      process.execPath,
      [
        resolve(root, 'scripts/run-emitted.mjs'),
        resolve(root, 'test/runtime', `${entry}.ts`),
        '--out-dir',
        resolve(output, 'native', entry),
        '--expect',
        expected,
        ...absent.flatMap((text) => ['--emitted-lacks', text])
      ],
      { encoding: 'utf8', env: { ...process.env, GEA_NATIVE_JOBS: '1' } }
    )
    process.stdout.write(native)
  }
}
