// @ts-nocheck
// Helper for jsdoc-override-parameter-contradicted-through-base-call.runtime.js.
// This file imports no `RenderObject`; the override's tag is stale prose.
import { WGSLNodeBuilder } from './_base-call-builders.js'
export class Backend {
  /**
   * @abstract
   * @param {RenderObject} renderObject - The render object.
   * @param {Renderer} renderer - The renderer.
   * @return {NodeBuilder} The node builder.
   */
  createNodeBuilder(/* renderObject, renderer */) {}
}
export class WebGPUBackend extends Backend {
  /**
   * @param {RenderObject} object - The render object.
   * @param {Renderer} renderer - The renderer.
   * @return {WGSLNodeBuilder} The node builder.
   */
  createNodeBuilder(object, renderer) {
    return new WGSLNodeBuilder(object, renderer)
  }
}
