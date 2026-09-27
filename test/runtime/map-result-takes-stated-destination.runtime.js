// @ts-nocheck
// A `.map` result is a fresh array. When its callback's results are untyped
// the checker lays it out as `any[]`, while the parameter it is passed to
// states `@param {Array<TNode>}`: one array, two carriers, and no conversion
// between array elements that keeps its identity. The array takes the
// statement, and each untyped result converts into the element at its
// `return` (three's `TSLCore` `ConvertType` into `new JoinNode( nodes, type )`).
class TNode {
  constructor(t) {
    this.nodeType = t
    this.isNode = true
  }
}
class ConstNode extends TNode {
  constructor(value, t) {
    super(t)
    this.value = value
    this.isConstNode = true
  }
}
class JoinNode extends TNode {
  /**
   * @param {Array<TNode>} [nodes=[]] - The joined nodes.
   * @param {?string} [nodeType=null] - The node type.
   */
  constructor(nodes = [], nodeType = null) {
    super(nodeType)
    this.nodes = nodes
  }
  /** @return {string} The joined node types. */
  describe() {
    return this.nodes.map((node) => node.nodeType ?? '-').join(',')
  }
}
const cache = new Map()
const getConstNode = (value, type) => {
  if (cache.has(value)) return cache.get(value)
  else if (value.isNode === true) return value
  return new ConstNode(value, type)
}
const convert = function (type) {
  return (...params) => {
    if (params.length === 1) return getConstNode(params[0], type)
    const nodes = params.map((param) => getConstNode(param))
    return new JoinNode(nodes, type)
  }
}
const join = function (type) {
  return (...params) => {
    const nodes = params.map(function (param) {
      if (param === 0) return getConstNode(param, 'zero')
      return getConstNode(param, 'int')
    })
    return new JoinNode(nodes, type)
  }
}
const vec3 = convert('vec3')
cache.set(true, new ConstNode(true, 'bool'))
console.log(vec3(1, 2, new ConstNode(3, 'float')).describe(), vec3(true).nodeType, join('ivec2')(0, 5).describe())
//! expect: -,-,float bool zero,int
