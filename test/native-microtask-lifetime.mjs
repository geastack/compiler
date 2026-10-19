import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { executableSuffix } from './executable-suffix.mjs'

const root = resolve(import.meta.dirname, '..')
const corePackage = process.env.GEA_CORE
assert.ok(
  corePackage && existsSync(resolve(corePackage, 'include/gea/embedded.h')),
  'Set GEA_CORE to the real @geastack/core package source'
)
const packages = resolve(corePackage, '..')
const output = resolve(root, 'measurements/cxx-allocation-runtime')
mkdirSync(output, { recursive: true })
const binary = resolve(output, `native-microtask-lifetime-test${executableSuffix}`)
const args = ['-std=c++20', '-O1', '-g', '-fsanitize=address,undefined', '-I', resolve(root, 'src/targets/cpp/runtime')]
for (const path of ['core', 'core/include', 'engine', 'engine/ui', 'host/include', 'elements/ui']) args.push('-I', resolve(packages, path))
args.push(resolve(root, 'test/runtime/native-microtask-lifetime.cpp'), '-o', binary)
const environment = { ...process.env, TMPDIR: output, GEA_AUDIO_DISABLED: '1' }
const built = spawnSync(process.env.CXX || 'clang++', args, { encoding: 'utf8', env: environment, timeout: 180000 })
process.stdout.write((built.stdout || '') + (built.stderr || ''))
assert.equal(built.error, undefined)
assert.equal(built.status, 0)
const ran = spawnSync(binary, [], { encoding: 'utf8', env: environment, timeout: 10000 })
process.stdout.write((ran.stdout || '') + (ran.stderr || ''))
assert.equal(ran.error, undefined)
assert.equal(ran.status, 0)
