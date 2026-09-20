import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createProgram, defaultCompilerOptions } from './program.js'
import type { HostMethodBindingTable } from './host-methods.js'

const host = resolve('test/fixtures/builtin-module-reachability-host.d.ts')
const entry = resolve('test/fixtures/builtin-module-reachability-entry.ts')
const builtin = resolve('test/fixtures/builtin-module-reachability-demo.ts')

const bindings: HostMethodBindingTable = new Map([
  [
    host,
    new Map([
      [
        'Host.getBuiltinModule',
        {
          protocol: 'test::Host',
          member: 'getBuiltinModule',
          builtinModuleLookup: true
        }
      ]
    ])
  ]
])

const compile = (source: string) =>
  createProgram({
    rootFileNames: [entry, host],
    options: defaultCompilerOptions,
    sourceOverlay: new Map([
      [host, 'interface Host { getBuiltinModule(id: string): object | undefined } declare const host: Host'],
      [entry, source],
      [builtin, 'export const retained = true']
    ]),
    hostMethodBindings: bindings,
    commonJsBuiltinModules: new Map([
      ['demo', 'demo'],
      ['node:demo', 'demo']
    ]),
    commonJsBuiltinModuleSources: new Map([['demo', builtin]])
  })

test('a literal host builtin lookup retains its exact runtime source record', () => {
  const program = compile(`host.getBuiltinModule('node:demo')`)
  assert.deepEqual(
    // The compiler spells a file name its own way; `builtin` is `resolve`d.
    program.commonJsSourceFiles.map((file) => resolve(file.fileName)),
    [builtin]
  )
})

test('nonliteral and unavailable host builtin lookups retain no guessed source', () => {
  const program = compile(`const name = 'demo'; host.getBuiltinModule(name); host.getBuiltinModule('v8')`)
  assert.deepEqual(program.commonJsSourceFiles, [])
})
