// @ts-nocheck
//! expect: flow 1 2 4 b,c,a
// three's ContextNode.getFlowContextData: `Object.assign( {}, ...children )`
// over a list of typed context records. The spread list is the sources
// themselves, in order (20.1.2.1), so it is passed to the copy loop as it is:
// packing it into the dynamic rest array behind the target would box each
// record.
class ContextNode {
  /**
   * @param {?ContextNode} parent
   * @param {{ a?: number, b?: number, c?: number }} value
   */
  constructor(parent, value) {
    this.parent = parent
    this.value = value
  }
  getFlowContextData() {
    /** @type {Array<{ a?: number, b?: number, c?: number }>} */
    const children = []
    for (let node = this; node !== null; node = node.parent) children.push(node.value)
    return Object.assign({}, ...children)
  }
}
const root = new ContextNode(null, { a: 1, b: 2 })
const leaf = new ContextNode(root, { b: 3, c: 4 })
const data = leaf.getFlowContextData()
console.log('flow', data.a, data.b, data.c, Object.keys(data).join(','))
