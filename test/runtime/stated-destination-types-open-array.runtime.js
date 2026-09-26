// @ts-nocheck
// An empty array whose writes leave its element open (an untyped value, or
// no write at all) is laid out as the checker's `any[]`, while the stated
// parameter it is passed to and the stated field it is stored in keep their
// statement: one storage, two array carriers, and no conversion between them
// that keeps the array's identity. The statement is the only fact about the
// element, so the storage takes it (three's `hashArray( values )` under
// `@param {Array<number>}`, and `MRTNode`'s `members` stored into
// `OutputStructNode`'s `@type {Array<Node>}`).
class GraphNode {
  /** @param {number} v - The value. */
  constructor(v) {
    this.v = v
    this.kids = []
  }
  /** @return {number} The key. */
  getCacheKey() {
    const values = []
    for (const { childNode } of this._getChildren()) values.push(childNode.v, childNode.getCacheKey())
    return hashArray(values) + this.v
  }
  _getChildren() {
    const out = []
    for (const c of this.kids) out.push({ property: 'x', childNode: c })
    return out
  }
}
/**
 * @param {Array<number>} array - The array to be hashed.
 * @return {number} The hash.
 */
const hashArray = (array) => {
  let h = 0
  for (let i = 0; i < array.length; i++) h = (h * 31 + array[i]) | 0
  return h
}
function addMethodChaining(name, fn) {
  GraphNode.prototype[name] = function (...params) {
    return fn(this, ...params)
  }
}
addMethodChaining('convert', (node, t) => new GraphNode(Number(node.v) + Number(t)))
class OutputStructNode extends GraphNode {
  /** @param {...GraphNode} members - The members. */
  constructor(...members) {
    super(0)
    /** @type {Array<GraphNode>} */
    this.members = members
  }
  total() {
    let t = 0
    for (const m of this.members) t += m.v
    return t
  }
}
class MRTNode extends OutputStructNode {
  /** @param {Object<string, GraphNode>} outputNodes - The outputs. */
  constructor(outputNodes) {
    super()
    /** @type {Object<string, GraphNode>} */
    this.outputNodes = outputNodes
  }
  /**
   * @param {number} index - The first index.
   * @return {number} The total.
   */
  setup(index) {
    const outputNodes = this.outputNodes
    const members = []
    for (const name in outputNodes) {
      members[index] = outputNodes[name].convert(index)
      index++
    }
    this.members = members
    return this.total()
  }
}
const root = new GraphNode(1)
root.kids.push(new GraphNode(2))
const mrt = new MRTNode({ a: new GraphNode(1), b: new GraphNode(2) })
console.log(root.getCacheKey(), mrt.setup(0), mrt.members.length)
//! expect: 65 4 2
