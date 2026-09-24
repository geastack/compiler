// Names `Node` only in its JSDoc and imports nothing, as three's NodeFrame.js
// does: the checker binds the name to lib.dom's `Node` unless the build
// realizes it as this package's own class.
export class Frame {
  constructor() {
    /** @type {WeakMap<Node, number>} */
    this.visits = new WeakMap()
  }

  /**
   * @param {Node} node
   * @returns {number}
   */
  visit(node) {
    const count = (this.visits.get(node) ?? 0) + 1
    this.visits.set(node, count)
    return count * 100 + node.value()
  }
}
