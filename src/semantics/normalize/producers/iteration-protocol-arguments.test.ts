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
const scriptFixture = resolve('test/runtime/iteration-protocol-arguments-probe.js')

const compileSource = (source: string, root = fixture) =>
  compile({
    rootFileNames: [root],
    projectFileName: null,
    sourceOverlay: new Map([[root, source]]),
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

// three's WebGLState.drawBuffers: in unchecked JS `let drawBuffers = []`
// reassigned from a WeakMap's `get` is `any` to the checker at the call, so
// its acceptance vouches for nothing; the census's array is the evidence, and
// only when its element is the element the slot states.
const drawBuffersState = (element: string) => `// @ts-nocheck
class State {
  /** @param {WebGL2RenderingContext | null} gl */
  constructor(gl) { this.gl = gl; this.current = new WeakMap() }
  update(key, count) {
    const { gl } = this
    let drawBuffers = []
    drawBuffers = this.current.get(key)
    if (drawBuffers === undefined) { drawBuffers = []; this.current.set(key, drawBuffers) }
    for (let i = 0; i < count; i++) drawBuffers[i] = ${element}
    if (gl) gl.drawBuffers(drawBuffers)
    return drawBuffers.length
  }
}
console.log(new State(document.createElement('canvas').getContext('webgl2')).update({}, 2))
`

test('an any-typed JS argument enters an Iterable<T> slot as the array its census holds', () => {
  const result = compileSource(drawBuffersState('36064 + i'), scriptFixture)

  assert.deepEqual(conversionRefusals(result), [], JSON.stringify(result.refusals))
  assert.ok(result.certificate, JSON.stringify(result.refusals))
  assert.match(result.source ?? '', /CallableObject<void\(gea::Ref<gea::ArrayObject<double>>\)>/)
})

test('an any-typed JS argument whose census element is not the stated element keeps its refusal', () => {
  const result = compileSource(drawBuffersState("'back'"), scriptFixture)

  assert.equal(result.certificate, null)
  assert.ok(
    conversionRefusals(result).some((row) => row.key.startsWith('conversion:array-object(string,')),
    JSON.stringify(result.refusals)
  )
})
