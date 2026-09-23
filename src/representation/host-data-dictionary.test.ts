import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../compiler.js'
import { noPluginCapabilities, type CompilerPlugin } from '../plugins/model.js'

/**
 * node-compat's `process.env`: a host member of a natively carried `Process`
 * hands back `ProcessEnv`, an ambient interface that is only an index
 * signature and that no host names a carrier for. The host-object closure
 * binds it anyway; with no carrier, reading it as a handle demands a native
 * boundary nothing can register. It is data this compiler lays out itself --
 * the host's own C++ returns a string dictionary -- while an interface that
 * states operations keeps the handle.
 */
const directory = resolve('test/fixtures/host-data-dictionary')
const hostDeclaration = resolve(directory, 'host.d.ts')
const entry = resolve(directory, 'entry.ts')
const processCarrier = 'test::Process'

const plugin: CompilerPlugin = {
  name: 'host-data-dictionary-test',
  instantiate: () => ({
    producers: () => [],
    lower: () => false,
    capabilities: {
      ...noPluginCapabilities,
      nativeTypesByDeclaration: new Map([
        ['Process', { declarationName: 'Process', declarationFileName: hostDeclaration, native: processCarrier }]
      ]),
      hostSingletonDeclarations: new Map([['process', { declarationName: 'process', declarationFileName: hostDeclaration }]]),
      hostMembers: new Map([[`${processCarrier}.env`, { kind: 'property', emit: 'test::process_env()', store: null }]])
    }
  })
}

const boundaryRootsOf = (environment: string): readonly string[] =>
  compile({
    rootFileNames: [entry, hostDeclaration],
    projectFileName: null,
    plugins: [plugin],
    sourceOverlay: new Map([
      [hostDeclaration, `${environment} interface Process { readonly env: ProcessEnv } declare var process: Process`],
      [entry, 'const present = process.env ? 1 : 0\nconsole.log(present)']
    ])
  })
    .diagnostics.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'root' && diagnostic.message.includes('native-boundary:ProcessEnv')
    )
    .map((diagnostic) => diagnostic.message)

test('an ambient dictionary a host hands back with no carrier is carried structurally', () => {
  assert.deepEqual(boundaryRootsOf('interface ProcessEnv { [key: string]: string | undefined }'), [])
})

test('an ambient interface stating operations stays a host handle and refuses without a carrier', () => {
  assert.notDeepEqual(boundaryRootsOf('interface ProcessEnv { get(key: string): string | undefined }'), [])
})
