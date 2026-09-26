// @ts-nocheck
//! expect: M(abs,1,-,-) M(mix,1,2,3) O(+,1,2,[3,4]) O(-,1,-,[]) M(mul,3,0.5,-) O(*,2,0.5,[]) C(1,2) S(x,1,2)
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced: one proxy
// constructs whichever node class it was handed, through a spread of its own
// rest array, so the callee is a sum of constructors with different arities
// -- one of them with a rest formal -- and no checker signature to expand the
// spread against. Each arm binds its named formals from the list's positions
// (`undefined` past the end, which runs a default) and a rest formal takes the
// rest of the list, including a value written after the spread.
class BaseNode {
  constructor() {
    this.isNode = true
  }
}
class ConstNode extends BaseNode {
  constructor(value) {
    super()
    this.value = value
  }
}
const nodeObject = (obj) => (obj !== null && obj !== undefined && obj.isNode === true ? obj : new ConstNode(obj))
const text = (node) => (node === null || node === undefined ? '-' : String(node.value))
class MathNode extends BaseNode {
  constructor(method, aNode, bNode = null, cNode = null) {
    super()
    this.v = `M(${method},${text(aNode)},${text(bNode)},${text(cNode)})`
  }
}
class OperatorNode extends BaseNode {
  constructor(op, aNode, bNode, ...params) {
    super()
    this.v = `O(${op},${text(aNode)},${text(bNode)},[${params.map(text).join(',')}])`
  }
}
class CallNode extends BaseNode {
  constructor(aNode, bNode) {
    super()
    this.v = `C(${text(aNode)},${text(bNode)})`
  }
}
class StructNode extends BaseNode {
  constructor(...members) {
    super()
    this.v = `S(${members.map(text).join(',')})`
  }
}
const nodeArray = (array) => {
  for (let i = 0; i < array.length; i++) array[i] = nodeObject(array[i])
  return array
}
const ShaderNodeProxy = function (NodeClass, scope = null, factor = null) {
  if (scope === null) return (...params) => new NodeClass(...nodeArray(params))
  if (factor !== null) {
    factor = nodeObject(factor)
    return (...params) => new NodeClass(scope, ...nodeArray(params), factor)
  }
  return (...params) => new NodeClass(scope, ...nodeArray(params))
}
const nodeProxy = (NodeClass, scope = null, factor = null) => new ShaderNodeProxy(NodeClass, scope, factor)
const abs = nodeProxy(MathNode, 'abs')
const mix = nodeProxy(MathNode, 'mix')
const add = nodeProxy(OperatorNode, '+')
const sub = nodeProxy(OperatorNode, '-')
const half = nodeProxy(MathNode, 'mul', 0.5)
const halve = nodeProxy(OperatorNode, '*', 0.5)
const call = nodeProxy(CallNode)
const struct = nodeProxy(StructNode)
console.log(
  abs(1).v,
  mix(1, 2, 3).v,
  add(1, 2, 3, 4).v,
  sub(1).v,
  half(3).v,
  halve(2).v,
  call(1, 2, 3).v,
  struct('x', 1, 2).v
)
