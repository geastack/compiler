// @ts-nocheck
//! expect: vt sv string
//! expect: op - 1
//! expect: el 2 uv
//! emitted-has: gea_crossed
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced: `scope = null`
// is a string or null from its callers, and the branches that take a scope
// call `new NodeClass( scope, ...params )` on whichever class the proxy was
// built for. The dispatch is typed for every class any proxy holds, so the
// string reaches `ArrayElementNode( node )` too, whose `@param {BaseNode}`
// it never meets at run time. That arm converts the argument where it
// arrives, through the dynamic boundary, instead of refusing the construction.
class BaseNode {
  constructor(nodeType = null) {
    this.nodeType = nodeType
  }
}
class UVNode extends BaseNode {
  constructor() {
    super('vec2')
    this.label = 'uv'
  }
}
const screenUV = new UVNode()
class ViewportTextureNode extends BaseNode {
  constructor(uvNode = screenUV, levelNode = null) {
    super('vec4')
    this.uvNode = uvNode
    this.levelNode = levelNode
  }
}
class OperatorNode extends BaseNode {
  constructor(op, aNode, bNode) {
    super()
    this.op = op
    this.aNode = aNode
    this.bNode = bNode
  }
}
class ArrayElementNode extends BaseNode {
  /**
   * @param {BaseNode} node
   * @param {number} indexNode
   */
  constructor(node, indexNode) {
    super()
    this.node = node
    this.indexNode = indexNode
  }
}
const direct = new ArrayElementNode(screenUV, 1)
const nodeArray = (array) => array
const nodeObject = (obj) => obj
const ShaderNodeProxy = function (NodeClass, scope = null, factor = null, settings = null) {
  let fn
  if (scope === null) {
    fn = (...params) => new NodeClass(...nodeArray(params))
  } else if (factor !== null) {
    factor = nodeObject(factor)
    fn = (...params) => new NodeClass(scope, ...nodeArray(params), factor)
  } else {
    fn = (...params) => new NodeClass(scope, ...nodeArray(params))
  }
  return fn
}
const nodeProxy = (NodeClass, scope = null, factor = null, settings = null) => new ShaderNodeProxy(NodeClass, scope, factor, settings)
const viewportTexture = nodeProxy(ViewportTextureNode)
const element = nodeProxy(ArrayElementNode)
const sub = nodeProxy(OperatorNode, '-')
const mul = nodeProxy(OperatorNode, '*', 2)
const v = viewportTexture(new UVNode())
console.log('vt', v.uvNode.label === 'uv' ? 'sv' : 'x', typeof sub(1, 2).op)
const o = sub(1, 2)
console.log('op', o.op, o.aNode)
console.log(mul(3).bNode)
console.log('el', element(screenUV, 2).indexNode, direct.node.label)
