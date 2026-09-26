// @ts-nocheck
//! expect: u 3 true
// A `@return` tag stating only an absence over a function that returns a
// value: three's `UniformArrayNode.setup` is tagged `@return {null}` and ends
// `return super.setup( builder )`, which is `Node.setup`'s `?Node`. The
// function returns what its `return` computes, the node or null.
class ShaderNode {
  constructor(name) { this.name = name }
  /**
   * @param {Object} builder
   * @return {?ShaderNode} The output node.
   */
  setup(builder) { return builder.flag ? this : null }
}
class BufferNode extends ShaderNode {}
class UniformArrayNode extends BufferNode {
  /**
   * @param {Object} builder
   * @return {null}
   */
  setup(builder) {
    this.count = 3
    return super.setup(builder)
  }
}
const n = new UniformArrayNode('u')
const out = n.setup({ flag: true })
console.log((out === null ? 'none' : out.name) + ' ' + n.count + ' ' + (n.setup({ flag: false }) === null))
