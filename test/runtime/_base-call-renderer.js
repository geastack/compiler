// @ts-nocheck
// Helper for jsdoc-override-parameter-contradicted-through-base-call.runtime.js.
// This file imports no `Backend` and no `RenderObject`.
class Renderer {
  /** @param {Backend} backend */
  constructor(backend) {
    /** @type {Backend} */
    this.backend = backend
  }
  /** @param {RenderObject} renderObject */
  build(renderObject) {
    const builder = this.backend.createNodeBuilder(renderObject.object, this)
    return builder.object.name + ' ' + builder.language
  }
}
export default Renderer
