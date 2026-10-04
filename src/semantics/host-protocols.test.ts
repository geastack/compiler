import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { runFrontend } from './frontend.js'
import { installedProducers } from './normalize/producers/installed.js'

const directory = resolve('test/fixtures/host-protocols-jsdoc-parameter')
const entry = resolve(directory, 'entry.js')
const ambient = resolve(directory, 'ambient.d.ts')

/** The host protocols the census bound for `text`, by name. */
const protocolsOf = (text: string): ReadonlySet<string> => {
  const result = runFrontend({
    rootFileNames: [entry, ambient],
    javaScriptSources: true,
    sourceOverlay: new Map([
      [entry, text],
      [ambient, 'declare function withContext(use: (gl: WebGL2RenderingContext) => void): void\n']
    ]),
    producers: installedProducers(() => [])
  })
  return new Set([...result.hostProtocols.values()].map((binding) => binding.protocol))
}

const isWebGl = (name: string): boolean => name.startsWith('WebGL')

// three documents `@param {WebGL2RenderingContext} gl` on functions a WebGPU
// build never calls with a context. The tag is a written annotation, as
// `(gl: WebGL2RenderingContext)` would be in TypeScript, so it states a type
// rather than handing the program an ambient value whose members seed the
// host closure.
test('a JSDoc-annotated JavaScript parameter does not seed the host closure', () => {
  const protocols = protocolsOf(
    ['/** @param {WebGL2RenderingContext} gl */', 'export const clear = (gl) => gl.createBuffer()', ''].join('\n')
  )
  assert.deepEqual([...protocols].filter(isWebGl), [])
})

test('an unannotated callback parameter still seeds it from its ambient contextual type', () => {
  const protocols = protocolsOf(['withContext((gl) => gl.createBuffer())', 'export {}', ''].join('\n'))
  assert.ok(protocols.has('WebGLBuffer'), [...protocols].join(', '))
})
