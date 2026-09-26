// @ts-nocheck
// `Builder` is named in the tags and imported nowhere here, as three's
// `Node.js` and `UniformNode.js` name `NodeBuilder`.
export class Entry {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
  /** @return {string} */
  getHash() {
    return 'entry:' + this.name
  }
  /** @param {Builder} builder */
  register(builder) {
    builder.setHashNode(this, this.getHash())
  }
  /**
   * @param {Builder} builder
   * @return {Entry}
   */
  getShared(builder) {
    const shared = builder.getNodeFromHash(this.getHash())
    return shared === undefined ? this : shared
  }
  /** @param {Builder} builder */
  varName(builder) {
    return builder.getVarFromNode(this)
  }
}
