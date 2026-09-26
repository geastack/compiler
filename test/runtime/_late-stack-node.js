// @ts-nocheck
// Helper for jsdoc-field-tag-held-by-silent-writes.runtime.js.
class StackNode {
  /** @param {?StackNode} [parent=null] */
  constructor(parent = null) {
    /** @type {?StackNode} */
    this.parent = parent
    this.nodes = []
  }
  add(node) {
    this.nodes.push(node)
    return this
  }
}
export default StackNode
