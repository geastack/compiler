// @ts-nocheck
//! expect: add 1 2
//! expect: mul 3 4
//! expect: imm 5 6
// TSLCore's spreads into callees that state no frame: a method chained onto
// the Node prototype calls the element it was handed with
// `nodeElement( this, ...params )`, and `ShaderNodeProxy`/`ShaderNodeImmutable`
// construct through the class a caller passed with
// `new NodeClass( scope, ...nodeArray( params ) )`. The call gets the flat
// argument list; the construction fills each candidate class's formals.
class BaseNode {
  constructor() {
    this.isNode = true
  }
}
class OpNode extends BaseNode {
  constructor(op, a, b) {
    super()
    this.op = op
    this.a = a
    this.b = b
  }
}
class ImmNode extends BaseNode {
  constructor(a, b) {
    super()
    this.a = a
    this.b = b
  }
}
const nodeArray = (list) => list.map((x) => x)
/**
 * @param {string} name
 * @param {Function} nodeElement
 */
function addMethodChaining(name, nodeElement) {
  BaseNode.prototype[name] = function (...params) {
    return this.isStackNode ? null : nodeElement(this, ...params)
  }
}
const ShaderNodeProxy = function (NodeClass, op) {
  return (...params) => new NodeClass(op, ...nodeArray(params))
}
const ShaderNodeImmutable = function (NodeClass, ...params) {
  return new NodeClass(...nodeArray(params))
}
const add = ShaderNodeProxy(OpNode, 'add')
const mul = ShaderNodeProxy(OpNode, 'mul')
addMethodChaining('mul', (self, x, y) => mul(x, y))
const a = add(1, 2)
console.log(a.op, a.a, a.b)
const m = a.mul(3, 4)
console.log(m.op, m.a, m.b)
const i = ShaderNodeImmutable(ImmNode, add(5, 0).a, add(6, 0).a)
console.log('imm', i.a, i.b)
