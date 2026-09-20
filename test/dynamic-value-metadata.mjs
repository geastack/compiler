import { executableSuffix } from './executable-suffix.mjs'
import { sanitizerArguments, sanitizerEnvironment } from './sanitizer.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'test/runtime/dynamic-value-metadata-runtime.cpp')
const binary = resolve(root, `measurements/dynamic-value-metadata-runtime${executableSuffix}`)

execFileSync('clang++', [
  '-std=c++20',
  '-O0',
  '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all',
  ...sanitizerArguments,
  `-I${resolve(root, 'src/targets/cpp/runtime')}`,
  source,
  '-o',
  binary
])
const sanitized = sanitizerEnvironment()
execFileSync(binary, { stdio: 'inherit', env: sanitized })

const overlap = spawnSync(binary, ['overlapping-class-union'], { encoding: 'utf8', env: sanitized })
assert.notEqual(overlap.status, 0, 'a boxed Derived value must not select the first arm of Base | Derived')

const nullable = spawnSync(binary, ['nullable-callable'], { encoding: 'utf8', env: sanitized })
assert.notEqual(nullable.status, 0, 'a callable Optional<T> boundary must not conflate null with undefined')

const functionUnion = spawnSync(binary, ['function-union-string'], { encoding: 'utf8', env: sanitized })
assert.notEqual(functionUnion.status, 0, 'a Function | number callable boundary must reject a string')

console.log('DYNAMIC_VALUE_METADATA_RUNTIME_OK')
