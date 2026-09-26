// @ts-nocheck
// Helper for jsdoc-override-parameter-contradicted-through-base-call.runtime.js.
// This file imports no `Object3D`.
class RenderObject {
  /** @param {Object3D} object */
  constructor(object) {
    /** @type {Object3D} */
    this.object = object
  }
}
export default RenderObject
