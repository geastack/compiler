import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// TypeScript and IR contracts cannot detect a broken C++ declaration order.
// Check the one shared header before calling a compiler build green; stdin
// and syntax-only mode require neither a scratch tree nor an output artifact.
const root = resolve(import.meta.dirname, '..')
// The ESP32 toolchains build this header with a 16-bit `wchar_t`
// (xtensa-esp32s3-elf-g++ reports `__SIZEOF_WCHAR_T__ 2`); a host clang has
// 32. A `static_assert` on the width once refused every embedded program from
// a header this check had passed, so both widths are checked here.
for (const [label, flags] of [
  ['native', []],
  ['16-bit wchar_t', ['-fshort-wchar']]
]) {
  const result = spawnSync(
    process.env.CXX ?? 'clang++',
    ['-std=c++20', '-fsyntax-only', ...flags, `-I${resolve(root, 'src/targets/cpp/runtime')}`, '-x', 'c++', '-'],
    { input: '#include "gea_runtime.h"\n', encoding: 'utf8' }
  )
  if (result.status !== 0 || result.error) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.error) process.stderr.write(`${result.error}\n`)
    process.exit(1)
  }
  process.stdout.write(`Runtime header: ${label} C++ syntax passed\n`)
}
