// @ts-nocheck
//! expect: vt sv string
//! expect: op - 1
//! expect: el 2 uv
//! expect: os 2 uv
//! emitted-has: gea_crossed
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced to the arm whose
// constructor is all rest: `OutputStructNode( ...members )`, `@param {...Node}`.
// The branches that take a scope call `new NodeClass( scope, ...params )` on
// whichever class the proxy was built for, and the dispatch is typed for every
// class any proxy holds. For a rest arm `scope` is not a named formal but the
// first element of the rest array, so it converts into the rest element,
// `BaseNode`, which a string or null never reaches at run time there. That
// element converts where it arrives, through the dynamic boundary, exactly as a
// named formal of the same arm does, instead of refusing the construction.
export {}
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
class OutputStructNode extends BaseNode {
  /** @param {...BaseNode} members */
  constructor(...members) {
    super()
    this.members = members
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
const outputStruct = nodeProxy(OutputStructNode)
const sub = nodeProxy(OperatorNode, '-')
const mul = nodeProxy(OperatorNode, '*', 2)
const v = viewportTexture(new UVNode())
console.log('vt', v.uvNode.label === 'uv' ? 'sv' : 'x', typeof sub(1, 2).op)
const o = sub(1, 2)
console.log('op', o.op, o.aNode)
console.log(mul(3).bNode)
console.log('el', element(screenUV, 2).indexNode, direct.node.label)
const s = outputStruct(screenUV, new UVNode())
console.log('os', s.members.length, s.members[1].label)
