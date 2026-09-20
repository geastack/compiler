import { executableSuffix } from './executable-suffix.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const compileFixture = (name) => compile({ rootFileNames: [resolve(root, `test/fixtures/${name}.ts`)], projectFileName: null })
const assertNativeOperations = (source) => {
  // Classes expose an unused adapter for reads through genuinely dynamic
  // values. Check executable program operations, including console arguments,
  // without mistaking that adapter's definition for a typed value being boxed.
  const operations = source.replace(/  (?:virtual )?bool gea_readOwnField\([^]*?\n  }/g, '')
  assert.ok(!/gea_cpp_value|gea::Value::box/.test(operations), 'typed program operations must not introduce boxed values')
}

for (const [name, expected] of [
  ['embedded-null-string', '9 0 word\ntrue false\n3 7\n9'],
  ['type-only-import', '17'],
  ['valueless-return', 'true 7 true present\ntrue\n11'],
  [
    'bigint-native',
    '-4294967295 18446744073709551615\n340282366920938463463374607431768211459 -5 -2\n-6 -5 4\nff 1 9007199254740992\ntrue true false true\n1255 true\n1 2\n3'
  ],
  ['default-parameter-patterns', '7 9 11 7 2\n8 14 3 9'],
  ['conditional-overload-return', 'true 17'],
  ['object-union-literal-layout', 'legacy\nmodern'],
  ['typed-array-intersection-carrier', '2 7'],
  ['explicit-void-this', '5 7 0.6931471805599453'],
  ['iterable-return-carrier', '7'],
  ['switch-completion', '10 20 21 30\n1 2 3 4'],
  ['computed-literal-union-keys', '3 3 2\n7 7'],
  ['switch-lazy-labels', '10 1\n10 12\n10 123\n20 1234\n20 12345\n30 12345\n40 \n40 getter'],
  ['optional-chain-tails', '-1\n-1\n-1\n-1\n0\n7\n9\n9\n11\n3\n-1 7']
]) {
  test(`${name} certifies and executes with native carriers`, () => {
    const result = compileFixture(name)
    const errors = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
    assert.ok(result.certificate, JSON.stringify(errors, null, 2))
    assert.deepEqual(result.loweringBlockers, [])
    assert.deepEqual(result.emissionRefusals, [])
    assert.ok(result.source)
    assertNativeOperations(result.source)
    const binary = resolve(root, 'measurements', name)
    execFileSync('clang++', ['-std=c++20', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary], {
      input: `${result.source}\nint main() { __gea_top_level(); }\n`,
      encoding: 'utf8'
    })
    assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), expected)
  })
}

// A clause block that can complete normally falls through into the next
// clause, carrying its guard forward (80eae0558); the program compiles and
// prints what node prints instead of being refused.
test('a block that can complete normally falls through into the next clause', () => {
  const result = compileFixture('switch-normal-completion')
  const errors = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(result.certificate, JSON.stringify(errors, null, 2))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const binary = resolve(root, 'measurements', 'switch-normal-completion')
  execFileSync('clang++', ['-std=c++20', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary], {
    input: `${result.source}\nint main() { __gea_top_level(); }\n`,
    encoding: 'utf8'
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), '5')
})

test('a typed-array intersection method returning this does not request a record layout', () => {
  const result = compileFixture('typed-array-intersection-self-method')
  const errors = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(result.certificate, JSON.stringify(errors, null, 2))
  assert.deepEqual(result.loweringBlockers, [])
  assert.ok(
    result.emissionRefusals.some((refusal) => refusal.reason.includes('swap32')),
    result.emissionRefusals
  )
  assert.ok(
    result.emissionRefusals.every((refusal) => !refusal.reason.includes('no record layout')),
    result.emissionRefusals
  )
  const method = [...result.representations.plan.selected.values()].find(
    (carrier) => carrier.kind === 'function-value-dispatch' && carrier.abi.result.kind === 'typed-array'
  )
  assert.ok(method)
})

test('optional chains preserve nullish checks and parenthesized boundaries', () => {
  const result = compileFixture('optional-chain-boundaries')
  const errors = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(result.certificate, JSON.stringify(errors, null, 2))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  assertNativeOperations(result.source)
  const binary = resolve(root, `measurements/optional-chain-boundaries${executableSuffix}`)
  execFileSync('clang++', ['-std=c++20', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary], {
    input: `${result.source}\nint main() { __gea_top_level(); }\n`,
    encoding: 'utf8'
  })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), '-1 -1 10 1\nundefined threw 8\nthrew threw 8')
})

test('dynamic JSON parses and stringifies through its declared carrier', () => {
  const result = compileFixture('dynamic-json')
  const errors = result.diagnostics.diagnostics.filter((diagnostic) => diagnostic.severity === 'root')
  assert.ok(result.certificate, JSON.stringify(errors, null, 2))
  assert.deepEqual(result.loweringBlockers, [])
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  const binary = resolve(root, `measurements/dynamic-json${executableSuffix}`)
  execFileSync(
    'clang++',
    ['-std=c++20', '-fsanitize=address,undefined', `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-', '-o', binary],
    { input: `${result.source}\nint main() { __gea_top_level(); }\n` }
  )
  assert.equal(
    execFileSync(binary, { encoding: 'utf8' }),
    execFileSync(process.execPath, [resolve(root, 'test/fixtures/dynamic-json.ts')], { encoding: 'utf8' })
  )
})
