// @ts-nocheck
// A bare `WeakMap` that caches an array per key holds that array in its value
// slot, so the slot, the cell the array is read back into and both `[]`
// literals are one storage (three's WebGLState `drawBuffers`: `let drawBuffers
// = []`, then `drawBuffers = this.currentDrawbuffers.get( framebuffer )`, a
// late `drawBuffers = []` under `=== undefined`, and
// `this.currentDrawbuffers.set( framebuffer, drawBuffers )`). The value slot
// used to take the checker's `any[]` for the stored array while the literals
// took the census's `number`, and the cell met both.
/**
 * @param {Array<number>} buffers - The buffers to draw.
 * @return {string} The buffers, joined.
 */
function draw(buffers) {
  return buffers.join('/')
}
class State {
  constructor() {
    this.currentDrawbuffers = new WeakMap()
    this.calls = 0
    this.log = []
  }
  drawBuffers(textures, framebuffer) {
    let drawBuffers = []
    let needsUpdate = false
    if (textures !== null) {
      drawBuffers = this.currentDrawbuffers.get(framebuffer)
      if (drawBuffers === undefined) {
        drawBuffers = []
        this.currentDrawbuffers.set(framebuffer, drawBuffers)
      }
      if (drawBuffers.length !== textures.length || drawBuffers[0] !== 36064) {
        for (let i = 0, il = textures.length; i < il; i++) drawBuffers[i] = 36064 + i
        drawBuffers.length = textures.length
        needsUpdate = true
      }
    } else if (drawBuffers[0] !== 1029) {
      drawBuffers[0] = 1029
      needsUpdate = true
    }
    if (needsUpdate) {
      this.calls++
      this.log.push(draw(drawBuffers))
    }
  }
}
const s = new State()
const a = { id: 1 }
const b = { id: 2 }
s.drawBuffers([1, 2], a)
s.drawBuffers([1, 2], a)
s.drawBuffers([1, 2, 3], b)
s.drawBuffers(null, a)
console.log(s.calls, s.log.join(' '))
//! expect: 3 36064/36065 36064/36065/36066 1029
