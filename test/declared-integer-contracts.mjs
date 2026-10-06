import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { compile } from '../dist/compiler.js'
import { noPluginCapabilities } from '../dist/plugins/model.js'
import { cppBodyName } from '../dist/targets/cpp/types.js'

const root = resolve(import.meta.dirname, '..')
const entry = resolve(root, 'test/native-function-signatures.ts')
const declarationFileName = resolve(root, 'test/native-function-signatures.d.ts')
const header = resolve(root, 'test/native-signatures.h')
const aliases = `declare const integerBrand: unique symbol;
declare const narrowBrand: unique symbol;
type int = number & { readonly [integerBrand]?: never };
type i32 = number & { readonly [narrowBrand]?: never };
type int32 = number & { readonly [narrowBrand]?: never };
declare function integerHost(callback: (value: int) => void): number;`
const plugin = {
  name: 'integer-contract-fixture',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      nativeFunctionDeclarations: [
        {
          declarationFileName,
          declarationName: 'integerHost',
          inspection: { cppFunction: 'gea::signature_test::integerAlias', headers: [header] }
        }
      ],
      hostFunctions: new Map([['integerHost', 'gea::signature_test::integerAlias']]),
      hostPreambles: new Map([['gea::signature_test::integerAlias', [`#include "${header}"`]]])
    }
  })
}
const scenarios = [
  {
    name: 'integer-css-union-fields',
    source: `interface Style { left?: number | string; top?: number | string }
      class Position { x: int32 = 0; y: int = 0; }
      function coordinates(x: int32, y: int): Style {
        const position = new Position(); position.x = x; position.y = y;
        return { left: position.x, top: position.y };
      }
      const style = coordinates(-2147483648, 4294967296);
      console.log(style.left, style.top);
      style.left = undefined; style.top = '10px';
      console.log(style.left, style.top);`,
    expected: '-2147483648 4294967296\nundefined 10px\n',
    signature: /int32_t, long long/,
    noBoxing: true
  },
  {
    name: 'integer-css-union-absence',
    source: `function css(value: int32 | string | null | undefined): number | string | null | undefined { return value; }
      function wide(value: int | undefined): number | string | undefined { return value; }
      function main(value: int32, other: int) {
        console.log(css(value), css('12px'), css(null), css(undefined));
        console.log(wide(other), wide(undefined));
      }
      main(37, 4294967296);`,
    expected: '37 12px null undefined\n4294967296 undefined\n',
    signature: /int32_t, long long/,
    noBoxing: true
  },
  {
    name: 'numeric-union-integer-storage',
    source: `function tagged(value: number): int32 | string { return value; }
      console.log(tagged(3.75), tagged(2147483648), tagged(NaN), tagged(Infinity));`,
    expected: '3 -2147483648 0 0\n',
    signature: /int32_t/,
    noBoxing: true
  },
  {
    name: 'wide-integer-number-view-and-overflow',
    source: `function inc(value: int): int { return value + 1; }
      function numeric(value: int): number { return value; }
      function fractional(value: int): number { return value + 0.5; }
      let value: int = 9223372036854774784;
      for (let i = 0; i < 1023; i++) value = inc(value);
      console.log(numeric(value) > 0);
      console.log(inc(value) < 0);
      console.log((value + 0) < Infinity);
      console.log(fractional(3));`,
    expected: 'true\ntrue\ntrue\n3.5\n',
    signature: /CallableObject<long long\(long long\)>/
  },
  {
    name: 'explicit-number-callback-retains-fractions',
    source: 'function frame(value: number) { console.log(value); } integerHost(frame); frame(0.5);',
    expected: '37\n0.5\n',
    signature: /CallableObject<void\(long long\)>/,
    host: 'namespace gea::signature_test { int integerAlias(IntegerCallback callback) { callback(37); return 1; } }'
  },
  {
    name: 'native-bound-through-integer-contract',
    source: `function tick(value: number) {
      let result = value % 1000;
      ${Array.from({ length: 9 }, (_, index) => `result = (result + ${index + 1}) % 1000;`).join('\n')}
      console.log(result);
    } integerHost(value => tick(value));`,
    expected: '82\n',
    signature: /CallableObject<void\(long long\)>/,
    host: 'namespace gea::signature_test { int integerAlias(IntegerCallback callback) { callback(37); return 1; } }',
    noDuplicates: true
  },
  {
    name: 'retained-capture',
    source: 'function register(seed: int) { integerHost(value => console.log(seed + value)); } register(37);',
    expected: '42\n',
    signature: /CallableObject<void\(long long\)>/,
    host: 'namespace gea::signature_test { IntegerCallback retained; int integerAlias(IntegerCallback callback) { retained = callback; return 1; } }',
    postlude: 'gea::signature_test::retained(5);'
  },
  {
    name: 'ambient-inferred-callback',
    source: 'integerHost(value => console.log(value));',
    expected: '0\n37\n2147483647\n-2147483648\n',
    signature: /CallableObject<void\(long long\)>/,
    host: 'namespace gea::signature_test { int integerAlias(IntegerCallback callback) { callback(0); callback(37); callback(2147483647); callback(-2147483647 - 1); return 1; } }'
  },
  {
    name: 'stored-parameter-and-return',
    source: 'function inc(value: int): int { return value + 1; } const stored: (value: int) => int = inc; console.log(stored(37));',
    expected: '38\n',
    signature: /CallableObject<long long\(long long\)>/
  },
  {
    name: 'narrow-parameter-return-and-field',
    source:
      'function hold(value: i32): i32 { return value; } class State { value: i32 = 0; } const state = new State(); state.value = hold(2147483648); console.log(state.value);',
    expected: '-2147483648\n',
    signature: /CallableObject<int32_t\(int32_t\)>/
  },
  {
    name: 'numeric-boundaries',
    source:
      'function hold(value: int): int { return value; } console.log(hold(3.75)); console.log(hold(NaN)); console.log(hold(Infinity)); const value: unknown = 5.75; console.log(hold(value as int));',
    expected: '3\n0\n0\n5\n',
    signature: /CallableObject<long long\(long long\)>/
  },
  {
    name: 'ordinary-brand',
    source:
      'declare const ordinaryBrand: unique symbol; type Label = number & { readonly [ordinaryBrand]?: never }; function hold(value: Label): Label { return value; } console.log(hold(3.75));',
    expected: '3.75\n',
    signature: /CallableObject<double\(double\)>/
  }
]

for (const scenario of scenarios) {
  const result = compile({
    rootFileNames: [entry, declarationFileName],
    projectFileName: null,
    includeIr: true,
    plugins: [plugin],
    sourceOverlay: new Map([
      [entry, scenario.source],
      [declarationFileName, aliases]
    ])
  })
  assert.equal(result.diagnostics.planClean, true, `${scenario.name}: ${JSON.stringify(result.diagnostics)}`)
  assert.ok(result.source, `${scenario.name}: missing generated source`)
  assert.deepEqual(result.emissionRefusals, [], scenario.name)
  assert.match(result.source, scenario.signature, scenario.name)
  assert.doesNotMatch(result.source, /_integral/)
  if (scenario.noBoxing) {
    assert.equal(result.dynamicFallback.valueCount, 0)
    assert.doesNotMatch(result.source, /gea::Value::box/)
  }
  if (scenario.noDuplicates) {
    const tick = result.irBodies.find((body) => body.functionName === 'tick')
    assert.ok(tick)
    assert.match(result.source, new RegExp(`void ${cppBodyName(tick.sourceOwner)}\\(long long`))
  }
  if (scenario.name === 'ambient-inferred-callback') assert.doesNotMatch(result.source, /CallableObject<void\(double\)>/)
  const executable = resolve(root, 'measurements', `declared-integer-contracts-${scenario.name}`)
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
    {
      input: `${result.source}\n${scenario.host ?? ''}\nint main() { __gea_top_level(); ${scenario.postlude ?? ''} }`,
      env: { ...process.env, TMPDIR: resolve(root, 'measurements') },
      timeout: 180_000
    }
  )
  assert.equal(execFileSync(executable, [], { encoding: 'utf8', timeout: 30_000 }), scenario.expected, scenario.name)
  console.log(`${scenario.name}: passed`)
}
