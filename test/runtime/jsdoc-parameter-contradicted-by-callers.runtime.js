// @ts-nocheck
//! expect: node:position var:v0 uniform:u1
//! expect: hash abc -> 3
//! expect: plain as vec2 as float
//! expect: to uint
// three's `NodeBuilder.getPropertyName( node )` under `@param {Node} node`,
// called with a `NodeVar` and a `NodeUniform` too, which are no `Node` (here
// `GraphNode`, `GraphVar`, `GraphUniform`); and
// `getNodeFromHash( hash )` under `@param {number} hash`, called with the
// string `node.getHash()` returns. The body reads only what every argument
// has; the parameter holds what its callers pass. A tag with a `null` default
// (`Node.build( builder, output = null )`'s shape) blanks to an untagged
// parameter, typed from its callers beside the null.
class GraphNode {
  constructor(name) {
    this.name = name
  }
}
class GraphVar {
  constructor(name) {
    this.name = name
  }
}
class GraphUniform {
  constructor(name) {
    this.name = name
  }
}
class Builder {
  constructor() {
    this.lastHash = ''
    this.lastValue = 0
  }
  /**
   * @param {GraphNode} node
   * @return {string}
   */
  getPropertyName(node) {
    return node.name
  }
  /**
   * @param {number} hash
   * @param {number} value
   */
  setHash(hash, value) {
    this.lastHash = hash
    this.lastValue = value
  }
  /**
   * @param {number} hash
   * @return {number}
   */
  getFromHash(hash) {
    return hash === this.lastHash ? this.lastValue : -1
  }
}
/** @return {string} */
const hashOf = () => 'abc'
const builder = new Builder()
console.log(
  'node:' +
    builder.getPropertyName(new GraphNode('position')) +
    ' var:' +
    builder.getPropertyName(new GraphVar('v0')) +
    ' uniform:' +
    builder.getPropertyName(new GraphUniform('u1'))
)
builder.setHash(hashOf(), 3)
console.log('hash ' + hashOf() + ' -> ' + builder.getFromHash(hashOf()))
class Stage {
  /**
   * @param {Builder} builder
   * @param {?number} [output=null]
   * @return {string}
   */
  build(builder, output = null) {
    return output === null ? 'plain' : 'as ' + output
  }
  /**
   * @param {?number} [output=null]
   * @return {string}
   */
  convert(output = null) {
    return output === null ? 'none' : 'to ' + output
  }
}
const stage = new Stage()
console.log(stage.build(builder) + ' ' + stage.build(builder, 'vec2') + ' ' + stage.build(builder, 'float'))
console.log(stage.convert('uint'))
