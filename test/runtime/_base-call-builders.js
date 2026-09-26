// @ts-nocheck
// Helper for jsdoc-override-parameter-contradicted-through-base-call.runtime.js.
// This file imports no `Object3D`.
export class NodeBuilder {
  /** @param {Object3D} object - The 3D object. */
  constructor(object) {
    /** @type {Object3D} */
    this.object = object
  }
}
export class WGSLNodeBuilder extends NodeBuilder {
  /** @param {Object3D} object - The 3D object. */
  constructor(object) {
    super(object)
    this.language = 'wgsl'
  }
}
