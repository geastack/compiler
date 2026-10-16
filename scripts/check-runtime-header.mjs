import './host-toolchain.mjs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// TypeScript and IR contracts cannot detect a broken C++ declaration order.
// Check the one shared header before calling a compiler build green; stdin
// and syntax-only mode require neither a scratch tree nor an output artifact.
const root = resolve(import.meta.dirname, '..')
// The ESP32 toolchains build this header with a 16-bit `wchar_t`
// (xtensa-esp32s3-elf-g++ reports `__SIZEOF_WCHAR_T__ 2`); a host clang has
// 32. A `static_assert` on the width once refused every embedded program from
// a header this check had passed, so both widths are checked here. The regex
// anchor rewrite for a standard library without LWG 2503's `multiline` is
// compiled only on such a library, which a host clang does not use; the
// simulation macro selects it so it is checked too.
for (const [label, flags] of [
  ['native', []],
  ['16-bit wchar_t', ['-fshort-wchar']],
  ['legacy regex anchors', ['-DGEA_REGEX_SIMULATE_LEGACY_MULTILINE=1']]
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

// The fenced try shape (GEA_EH_FENCED, the MSVC ABI's default) must cost
// nothing on the normal path. Its fences were once empty volatile asm
// statements, which clang hands LLVM with no memory effects, so every try
// statement -- makeRef's in every allocation -- was two barriers no load could
// be forwarded across. A load right after a fenced statement must fold at
// -O2, the release level (-O1's EarlyCSE forwards across no volatile store).
// Each host checks its own spelling of the fence: the MSVC one on Windows.
const fenceProbe = `#include "gea_runtime.h"
extern "C" int gea_fence_probe(int* p) {
  *p = 1;
  GEA_EH_TRY_ANY(gea_probe_failed) {
  } GEA_EH_CATCH_ANY(gea_probe_failed) {
    return -1;
  } GEA_EH_END
  return *p;
}
`
const probe = spawnSync(
  process.env.CXX ?? 'clang++',
  [
    '-std=c++20',
    '-O2',
    '-DGEA_EH_FENCED=1',
    '-S',
    '-emit-llvm',
    '-o',
    '-',
    `-I${resolve(root, 'src/targets/cpp/runtime')}`,
    '-x',
    'c++',
    '-'
  ],
  { input: fenceProbe, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
)
const probeBody = /define [^\n]*@gea_fence_probe\([^\n]*\{\n([\s\S]*?)\n\}/.exec(probe.stdout ?? '')?.[1]
if (probe.status !== 0 || probe.error || probeBody === undefined || /asm sideeffect/.test(probeBody) || !/ret i32 1\b/.test(probeBody)) {
  process.stderr.write(probe.stderr ?? '')
  if (probe.error) process.stderr.write(`${probe.error}\n`)
  process.stderr.write(`Runtime header: a fenced try statement is a barrier on its normal path:\n${probeBody ?? '(probe not compiled)'}\n`)
  process.exit(1)
}
process.stdout.write('Runtime header: fenced try shape passed, with no barrier on the normal path\n')
