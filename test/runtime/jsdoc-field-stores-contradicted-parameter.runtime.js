// @ts-nocheck
//! expect: gpu-cube 6 gpu
// A field tagged with the type its constructor parameter's tag states, and
// filled from that parameter: three's `CubeCamera( near, far, renderTarget )`
// stores `this.renderTarget = renderTarget` under `@type
// {WebGLCubeRenderTarget}`, and the WebGPU `CubeRenderTarget` constructs it
// with itself, which is no `WebGLCubeRenderTarget`.
class RenderTarget {
  constructor(size) { this.size = size }
}
class WebGLCubeRenderTarget extends RenderTarget {
  constructor(size) { super(size); this.kind = 'gl' }
  label() { return 'gl-cube' }
}
class CubeCamera {
  /**
   * @param {number} near - The near plane.
   * @param {WebGLCubeRenderTarget} renderTarget - The cube render target.
   */
  constructor(near, renderTarget) {
    this.near = near
    /**
     * The cube render target.
     *
     * @type {WebGLCubeRenderTarget}
     */
    this.renderTarget = renderTarget
  }
  update() { return this.renderTarget.label() + ' ' + this.renderTarget.size }
}
class CubeRenderTarget extends RenderTarget {
  constructor(size) { super(size); this.kind = 'gpu' }
  label() { return 'gpu-cube' }
  camera() { return new CubeCamera(1, this) }
}
const target = new CubeRenderTarget(6)
const camera = target.camera()
console.log(camera.update() + ' ' + camera.renderTarget.kind)
