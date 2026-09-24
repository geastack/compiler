// A file that declares its own `Node` keeps it.
class Node {
  constructor() {
    this.own = true
  }
}

/** @param {Node} node */
export const own = (node) => node.own
