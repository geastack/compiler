// @ts-nocheck
// `Entry` is named in a tag and imported nowhere here, as three's
// `NodeBuilder.js` names `VarNode`.
export class VarSlot {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}
export class Builder {
  constructor() {
    this.nodes = new Map()
  }
  /**
   * @param {Entry} node
   * @param {number} hash
   */
  setHashNode(node, hash) {
    this.nodes.set(hash, node)
  }
  /** @param {number} hash */
  getNodeFromHash(hash) {
    return this.nodes.get(hash)
  }
  /** @param {VarSlot} node */
  getVarFromNode(node) {
    return 'var_' + node.name
  }
}
