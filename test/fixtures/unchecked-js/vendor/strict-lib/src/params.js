export class Node {
  constructor(name) {
    this.name = name
  }
}
export class Uniform {
  constructor(name) {
    this.name = name
  }
}
export class Builder {
  /**
   * @param {Node} node
   * @param {number} hash
   * @param {('vertex'|'fragment')} stage
   */
  describe(node, hash, stage) {
    return node.name + hash + stage
  }
}
/** @param {string} stage */
export const run = (stage) => new Builder().describe(new Uniform('u'), 1, stage)
export class Shape {
  /** @param {?(string|Shape)} [output=null] */
  build(output = null) {
    return output === null ? '' : 'shape'
  }
}
export class Stack extends Shape {
  /** @param {number} depth */
  build(depth) {
    return new Shape().build(this) + depth
  }
}
