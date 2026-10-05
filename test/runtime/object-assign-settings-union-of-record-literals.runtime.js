// @ts-nocheck
//! expect: mip mip true undefined
//! expect: sub - undefined true
//! expect: abs abs undefined undefined
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced: its `settings =
// null` is filled only with record literals of different shapes --
// `viewportMipTexture`'s `{ generateMipmaps: true }` through `nodeProxy`, and
// `nodeProxyIntent`'s `{ ...settings, intent: true }` -- so the source of
// `Object.assign( node, settings )` is an optional over a union of two records.
// Each arm has a field list, and the copy has to peel both wrappers and copy
// the live arm rather than refuse the union as one unenumerable carrier.
class BaseNode {
  constructor(nodeType = null) {
    this.nodeType = nodeType
  }
  toVarIntent() {
    return this
  }
}
class MathNode extends BaseNode {
  constructor(method, aNode) {
    super('float')
    this.method = method
    this.aNode = aNode
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
const nodeObject = (node) => node
const ShaderNodeProxy = function (NodeClass, scope = null, factor = null, settings = null) {
  function assignNode(node) {
    if (settings !== null) {
      node = nodeObject(Object.assign(node, settings))
      if (settings.intent === true) node = node.toVarIntent()
    } else {
      node = nodeObject(node)
    }
    return node
  }
  return (...params) => assignNode(new NodeClass(scope, ...params))
}
const nodeProxy = (NodeClass, scope = null, factor = null, settings = null) => new ShaderNodeProxy(NodeClass, scope, factor, settings)
const nodeProxyIntent = (NodeClass, scope = null, factor = null, settings = {}) =>
  new ShaderNodeProxy(NodeClass, scope, factor, { ...settings, intent: true })

const mip = nodeProxy(MathNode, 'mip', null, { generateMipmaps: true })
const sub = nodeProxyIntent(OperatorNode, '-')
const abs = nodeProxy(MathNode, 'abs')
const t = mip(5)
console.log('mip', t.method, t.generateMipmaps, t.intent)
const s = sub(1, 2)
console.log('sub', s.op, s.generateMipmaps, s.intent)
const a = abs(4)
console.log('abs', a.method, a.generateMipmaps, a.intent)
