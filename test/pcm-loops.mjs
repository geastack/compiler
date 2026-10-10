import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { compile } from '../dist/compiler.js'

const root = resolve(import.meta.dirname, '..')
const file = resolve(root, 'test/fixtures/typed-array-pcm-map.ts')
const source = readFileSync(file, 'utf8')
const kernel = 'gea::runtime::audio::float32ToPcm16('
const emitted = (text) => {
  const result = compile({ rootFileNames: [file], sourceOverlay: new Map([[file, text]]) })
  assert.ok(result.certificate, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.emissionRefusals, [])
  assert.ok(result.source)
  return result.source
}

assert.ok(emitted(source).includes(kernel))
for (const [name, text] of [
  ['wrong positive scale', source.replace('32767', '32766')],
  ['different clamp threshold', source.replace('sample > 1', 'sample > 0.9')],
  ['missing NaN normalization', source.replace(' || 0', '')],
  ['side effect in body', source.replace('let sample =', 'console.log(index); let sample =')],
  ['side effect in header', source.replace('index < count', 'index < (console.log(index), count)')],
  ['non-unit stride', source.replace('index++', 'index += 2')],
  ['different source element', source.replaceAll('Float32Array', 'Float64Array')],
  ['different destination element', source.replaceAll('Int16Array', 'Uint16Array')],
  [
    'observable scratch binding',
    source
      .replace('  for (let index', '  let sample = 0\n  for (let index')
      .replace('    let sample =', '    sample =')
      .replace('\n}\n', '\n  console.log(sample)\n}\n')
  ]
])
  assert.ok(!emitted(text).includes(kernel), `must refuse ${name}`)
console.log('PCM IR admission and fail-closed counterexamples passed')

if (!process.argv.includes('--emit-only')) {
  const prefix = source.slice(0, source.indexOf('const input ='))
  const cases = [
    source,
    `${prefix}
const input = new Float32Array([-Infinity, -1, -0.5000152587890625, -0, 0, 0.5000152587890625, 1, Infinity, NaN])
const output = new Int16Array(12)
capture(input, output, 1, 2, 7)
console.log(output.toString())`,
    `${prefix}
const buffer = new ArrayBuffer(32)
const input = new Float32Array(buffer, 0, 8)
const output = new Int16Array(buffer, 4, 8)
input.set([-0.25, 0.5, 0.75, -0.5, 1, -1, 0, 0.125])
capture(input, output, 0, 0, 8)
console.log(output.toString())`,
    `${prefix}
const input = new Float32Array([0.25, 0.5, -0.75])
const output = new Int16Array(4)
capture(input, output, 0, 0, 2.5)
console.log(output.toString())`
  ]
  const env = { ...process.env, TMPDIR: resolve(root, 'dist') }
  const binary = resolve(root, 'dist/pcm-map-test')
  for (const text of cases) {
    const cpp = `${emitted(text)}\nint main() { __gea_top_level(); }\n`
    execFileSync(
      'clang++',
      [
        '-std=c++20',
        ...nativeOptimization('correctness'),
        '-fsanitize=address,undefined',
        '-fsized-deallocation',
        `-I${resolve(root, 'src/targets/cpp/runtime')}`,
        '-x',
        'c++',
        '-',
        '-o',
        binary
      ],
      { input: cpp, stdio: ['pipe', 'inherit', 'inherit'], env }
    )
    const actual = execFileSync(binary, { encoding: 'utf8', env })
    const expected = execFileSync(
      process.execPath,
      ['-e', ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText],
      { encoding: 'utf8' }
    )
    assert.equal(actual, expected)
  }
  console.log('PCM emitted native execution, exact edge cases, overlap fallback and fractional-count fallback passed under ASan/UBSan')
}
