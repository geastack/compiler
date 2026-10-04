// @ts-nocheck
//! expect: count:0
//! expect: count:3:builder
//! expect: count:0
//! expect: direct:3:json
// three's `getArrayCount`: `Node` and `ArrayNode` declare no formal, and the
// one override that declares it leaves it untagged (`VarNode.getArrayCount(
// builder )`), so it holds a box -- here, as in three, because a direct caller
// hands the override a value the program cannot type. Every call through the
// family passes the builder, so the slot carries that same box and each call
// converts the `NodeBuilder` into it -- the conversion a direct call to the
// override makes. The override then reads the builder's fields through the
// box, which works only if the census saw the builder enter it at the call.
class NodeBuilder {
  constructor() {
    this.name = 'builder'
  }
}
class Node {
  /** @return {string} */
  getArrayCount(/*builder*/) {
    return '0'
  }
}
class ArrayNode extends Node {
  /** @return {string} */
  getArrayCount(/*builder*/) {
    return '0'
  }
}
class VarNode extends Node {
  constructor() {
    super()
    this.count = 3
  }
  /**
   * @param {any} builder
   * @return {string}
   */
  getArrayCount(builder) {
    return this.count + ':' + builder.name
  }
}
const builder = new NodeBuilder()
/** @type {Node[]} */
const nodes = [new Node(), new VarNode(), new ArrayNode()]
for (const node of nodes) console.log('count:' + node.getArrayCount(builder))
console.log('direct:' + new VarNode().getArrayCount(JSON.parse('{"name":"json"}')))
export {}
