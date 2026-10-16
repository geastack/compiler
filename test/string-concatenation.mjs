import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'test/runtime/string-concatenation.cpp')
const include = `-I${join(root, 'src/targets/cpp/runtime')}`
if (process.argv.includes('--riscv')) {
  const toolRoot = join(process.env.IDF_TOOLS_PATH || join(homedir(), '.espressif'), 'tools/riscv32-esp-elf')
  const compiler = readdirSync(toolRoot, { recursive: true })
    .filter((file) => file.endsWith('/bin/riscv32-esp-elf-g++'))
    .sort()
    .at(-1)
  if (!compiler) throw new Error(`Missing Mosaico GCC toolchain in ${toolRoot}`)
  execFileSync(
    join(toolRoot, compiler),
    [
      '-std=c++20',
      '-O2',
      '-Werror=array-bounds',
      '-Werror=stringop-overflow',
      '-DGEA_CONCAT_COMPILE_ONLY=1',
      include,
      '-c',
      source,
      '-o',
      join(root, 'measurements/string-concatenation-riscv.o')
    ],
    { stdio: 'inherit' }
  )
  console.log('RISC-V GCC optimized string concatenation: passed')
} else {
  const binary = join(root, 'measurements/string-concatenation')
  execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-g', '-fsanitize=address,undefined', include, source, '-o', binary], {
    stdio: 'inherit'
  })
  execFileSync(binary, { stdio: 'inherit' })
  console.log('String concatenation: ASan/UBSan passed')
}
