import { nativeOptimization } from '../scripts/native-optimization.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { executableSuffix } from './executable-suffix.mjs'

const root = resolve(import.meta.dirname, '..')
const cxx = process.env.CXX || 'clang++'
const include = `-I${resolve(root, 'src/targets/cpp/runtime')}`
const binary = resolve(root, `dist/compact-runtime-test${executableSuffix}`)
const peer =
  '#include "gea_runtime.h"\nextern "C" const void* floorIdentityFromPeer() { return gea::host::Math::floor.identified().functionObjectIdentity().get(); }\n'
for (const compact of [false, true]) {
  for (const name of ['host-builtin-constants', 'callable-identity-lazy', 'native-expando-reclaim', 'allocation-cycle-safepoint']) {
    execFileSync(
      cxx,
      [
        '-std=c++20',
        ...nativeOptimization('allocation'),
        '-g',
        '-fsanitize=address,undefined',
        '-DGEA_PROFILE_ALLOCATIONS=1',
        ...(compact ? ['-DGEA_RUNTIME_COMPACT_CODE=1', '-DGEA_RUNTIME_COMPACT_ALLOCATION=1', '-fsized-deallocation'] : []),
        ...(name === 'host-builtin-constants' ? ['-DGEA_HOST_BUILTIN_PEER=1'] : []),
        include,
        resolve(root, 'test/runtime', `${name}.cpp`),
        ...(name === 'host-builtin-constants' ? ['-x', 'c++', '-'] : []),
        '-o',
        binary
      ],
      name === 'host-builtin-constants' ? { input: peer, stdio: ['pipe', 'inherit', 'inherit'] } : { stdio: 'inherit' }
    )
    execFileSync(binary, { stdio: 'inherit' })
    console.log(`${name}: ASan/UBSan passed (${compact ? 'compact' : 'normal'})`)
  }
}

// A math-free program must not retain builtin thunks merely by including the
// runtime. Compile from stdin so the probe needs no generated source file.
// A Windows executable carries no symbol table for nm to read; the linker's
// map lists what the link kept, under Microsoft-mangled names.
const windows = process.platform === 'win32'
const linkMap = `${binary}.map`
execFileSync(
  cxx,
  [
    '-std=c++20',
    ...nativeOptimization('size'),
    '-ffunction-sections',
    '-fdata-sections',
    ...(process.platform === 'darwin' ? ['-Wl,-dead_strip'] : windows ? ['-Wl,/opt:ref', `-Wl,/map:${linkMap}`] : ['-Wl,--gc-sections']),
    include,
    '-x',
    'c++',
    '-',
    '-o',
    binary
  ],
  { input: '#include "gea_runtime.h"\nint main() { return 0; }\n', stdio: ['pipe', 'inherit', 'inherit'] }
)
execFileSync(binary, { stdio: 'inherit' })
if (windows) assert.doesNotMatch(readFileSync(linkMap, 'utf8'), /\?\w+_invoke@detail@Math@host@gea@@/)
else assert.doesNotMatch(execFileSync('nm', ['-C', binary], { encoding: 'utf8' }), /gea::host::Math::detail::\w+_invoke/)
console.log('Unused Math thunks: absent from linked program')
