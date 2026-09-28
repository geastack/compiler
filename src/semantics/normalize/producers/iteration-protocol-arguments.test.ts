import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { compile } from '../../../compiler.js'

// An array handed to an ambient method whose resolved overload states the slot
// as an iteration protocol. lib.dom.iterable merges `drawBuffers(buffers:
// Iterable<GLenum>)` ahead of lib.dom's `drawBuffers(buffers: GLenum[])`, so
// the checker picks the Iterable form; `Iterable` states how a value is used,
// never how it is stored, and interned as a layout it is an empty record the
// array had no conversion into. The callee's frame at this call is the only
// frame an ambient callee has, so the slot is the array the call passes.

const fixture = resolve('test/runtime/iteration-protocol-arguments-probe.ts')

const compileSource = (source: string) =>
  compile({
    rootFileNames: [fixture],
    projectFileName: null,
    sourceOverlay: new Map([[fixture, source]]),
    // The built-in WebGL host lowers `getContext` itself; this test is about
    // the lib.dom declaration the checker resolves, not that host.
    webglPlugin: false
  })

const conversionRefusals = (result: ReturnType<typeof compileSource>) => result.refusals.filter((row) => row.key.startsWith('conversion:'))

test('an array passed to a lib.dom Iterable<T> overload enters as the array', () => {
  const result = compileSource(`
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    const buffers: number[] = []
    for (let i = 0; i < 2; i++) buffers.push(36064 + i)
    if (gl) gl.drawBuffers(buffers)
    console.log(buffers.length)
  `)

  assert.deepEqual(conversionRefusals(result), [], JSON.stringify(result.refusals))
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.match(result.source ?? '', /"drawBuffers"/)
})

// Typed-array construction from an array certified before this frame existed;
// retyping its Iterable slot must keep it so.
test('an array passed to an ES Iterable<T> overload still enters', () => {
  const result = compileSource(`
    const xs: number[] = []
    for (let i = 0; i < 3; i++) xs.push(i * 3)
    const bytes = Uint8Array.from(xs)
    const wide = new Float32Array(xs)
    console.log(bytes.length, bytes[2], wide[1])
  `)

  assert.deepEqual(conversionRefusals(result), [], JSON.stringify(result.refusals))
  assert.ok(result.certificate, JSON.stringify(result.refusals))
})
