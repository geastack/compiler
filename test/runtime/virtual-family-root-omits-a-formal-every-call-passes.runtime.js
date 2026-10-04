// @ts-nocheck
//! expect: count:0
//! expect: count:3:builder
//! expect: count:0
//! expect: direct:none
//! expect: direct:point:builder
//! expect: direct:none
// three's `getArrayCount( /*builder*/ )` on `Node`/`ArrayNode` against
// `VarNode`'s `getArrayCount( builder )`, and `setupDirect( /*builder*/ ) { }`
// on `AnalyticLightNode` against `DirectionalLightNode`'s `setupDirect()` and
// `PointLightNode`'s `setupDirect( builder )`: the root declares fewer formals
// than an override, and the override's formal is a class that cannot hold the
// `undefined` an omitted argument binds. Every call passes the builder, so the
// slot carries it as the builder's own class and no call can omit it.
class NodeBuilder {
  constructor() {
    this.name = 'builder'
  }
}
class Node {
  constructor() {
    this.kind = 'node'
  }
  /** @return {number} */
  getArrayCount(/*builder*/) {
    return 0
  }
}
class ArrayNode extends Node {
  /** @return {number} */
  getArrayCount(/*builder*/) {
    return 0
  }
}
class VarNode extends Node {
  /**
   * @param {NodeBuilder} builder
   * @return {number}
   */
  getArrayCount(builder) {
    console.log('count:3:' + builder.name)
    return 3
  }
}
class AnalyticLightNode {
  /** @return {string} */
  setupDirect(/*builder*/) {
    return 'none'
  }
}
class DirectionalLightNode extends AnalyticLightNode {
  /** @return {string} */
  setupDirect() {
    return 'none'
  }
}
class PointLightNode extends AnalyticLightNode {
  /**
   * @param {NodeBuilder} builder
   * @return {string}
   */
  setupDirect(builder) {
    return 'point:' + builder.name
  }
}
const builder = new NodeBuilder()
/** @type {Node[]} */
const nodes = [new Node(), new VarNode(), new ArrayNode()]
for (const node of nodes) {
  const count = node.getArrayCount(builder)
  if (count === 0) console.log('count:0')
}
/** @type {AnalyticLightNode[]} */
const lights = [new AnalyticLightNode(), new PointLightNode(), new DirectionalLightNode()]
for (const light of lights) console.log('direct:' + light.setupDirect(builder))
export {}
