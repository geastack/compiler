// @ts-nocheck
//! expect: 10 15
// three's `WebGLBufferRenderer.mode`: declared `this.mode = null` in the
// constructor and set only through an instance (`renderer.mode = gl.POINTS`
// in WebGLBackend). The two spellings name one field; its writes are all of
// them.
class BufferRenderer {
  constructor() {
    this.mode = null
    this.index = 0
  }
  render(count) {
    const { mode, index } = this
    return mode * count + index
  }
}
class Backend {
  constructor() {
    this.bufferRenderer = new BufferRenderer()
  }
  /** @param {boolean} points */
  draw(points) {
    const renderer = this.bufferRenderer
    if (points) renderer.mode = 2
    else renderer.mode = 3
    return renderer.render(5)
  }
}
const backend = new Backend()
console.log(backend.draw(true), backend.draw(false))
