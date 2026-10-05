// @ts-nocheck
//! expect: sub - true null true 0 true:0
//! expect: neg neg true n float true nodeType,intent,version,method,aNode,label
//! expect: abs abs false undefined
//! expect: mip mip false true 5
//! expect: parsed parsed p 3 false:3
//! expect: direct * true 9 n true
// three's `ShaderNodeProxy` (`nodes/tsl/TSLCore.js`), reduced: `nodeProxyIntent`
// hands `{ ...settings, intent: true }` to a proxy whose `settings` also takes
// `null` and other shapes (here a parsed object, which is what makes the formal
// dynamic in this reduction), so the source reaches `Object.assign( node, settings )`
// dynamic, and the target is a `Node` instance (`OperatorNode` for
// `screenCoordinate.sub( viewport.xy )` in `ScreenNode.js`). The runtime's
// `Object.assign` demanded an own-property table of both and aborted on a boxed
// record source and a boxed class instance target. A key the class declares has
// to land in its field, where a typed read (`describe`, through `this`) sees it;
// any other key is an expando.
class BaseNode {
  constructor(nodeType = null) {
    this.nodeType = nodeType
    this.intent = false
    this.version = 0
  }
  toVarIntent() {
    return this
  }
  describe() {
    return this.intent + ':' + this.version
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
class MathNode extends BaseNode {
  constructor(method, aNode) {
    super('float')
    this.method = method
    this.aNode = aNode
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
  return (...params) => assignNode(scope === null ? new NodeClass(...params) : new NodeClass(scope, ...params))
}
const nodeProxy = (NodeClass, scope = null, factor = null, settings = null) => new ShaderNodeProxy(NodeClass, scope, factor, settings)
const nodeProxyIntent = (NodeClass, scope = null, factor = null, settings = {}) =>
  new ShaderNodeProxy(NodeClass, scope, factor, { ...settings, intent: true })

const sub = nodeProxyIntent(OperatorNode, '-')
const neg = nodeProxyIntent(MathNode, 'neg', null, { label: 'n' })
const abs = nodeProxy(MathNode, 'abs')
const mip = nodeProxy(MathNode, 'mip', null, { generateMipmaps: true })
const parsed = nodeProxy(MathNode, 'parsed', null, JSON.parse('{"label":"p","version":3}'))

const a = sub(1, 2)
console.log('sub', a.op, a.intent, a.nodeType, a instanceof OperatorNode, a.version, a.describe())
const n = neg(3)
console.log('neg', n.method, n.intent, n.label, n.nodeType, n instanceof MathNode, Object.keys(n).join(','))
const m = abs(4)
console.log('abs', m.method, m.intent, m.label)
const t = mip(5)
console.log('mip', t.method, t.intent, t.generateMipmaps, t.aNode)
const p = parsed(6)
console.log('parsed', p.method, p.label, p.version, p.describe())

// The same copy into an instance the program also holds typed: the declared
// key is read back through the class's own field.
const applySettings = (node, settings) => {
  Object.assign(node, settings)
}
const settingsFor = (label) => (label === null ? null : { label, intent: true })
const direct = new OperatorNode('*', 3, 4)
applySettings(direct, settingsFor('n'))
applySettings(direct, settingsFor(null))
applySettings(direct, JSON.parse('{"version":9}'))
console.log('direct', direct.op, direct.intent, direct.version, /** @type {any} */ (direct).label, direct instanceof OperatorNode)
