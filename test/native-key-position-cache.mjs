import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'measurements/native-key-position-cache')

execFileSync(
  'clang++',
  [
    '-std=c++20',
    ...nativeOptimization('correctness'),
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    resolve(root, 'test/runtime/native-key-position-cache.cpp'),
    '-o',
    output
  ],
  { env: { ...process.env, TMPDIR: resolve(root, 'measurements') } }
)

execFileSync(output, { stdio: 'inherit' })
const symbols = execFileSync('nm', [output], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
// Mach-O emits a TLS descriptor, backing initializer and (for a lazy owner)
// an initialization guard. The guard is not another position cache.
// ELF names the TLS slot of an inline function's static a weak symbol (`W`).
const hints = [
  ...new Set(
    symbols
      .split('\n')
      .filter((line) => /\s[bBdDsSwW]\s.*hints/.test(line))
      .map((line) =>
        line
          .trim()
          .split(/\s+/)
          .at(-1)
          .replace(/\$tlv\$init$/, '')
      )
      .filter((symbol) => !/^_+ZGV/.test(symbol))
  )
]
assert.equal(
  hints.filter((line) => /noteNativeDeclaredKeyCreated/.test(line)).length,
  0,
  'Native record types must not allocate their own per-task TLS caches'
)
assert.equal(
  hints.filter((line) => /nativeDeclaredKeyPositionHints/.test(line)).length,
  1,
  'All native record layouts must share one per-thread position cache'
)
console.log('PASS 64 native layouts share bounded TLS and validate cross-layout cache hits')
