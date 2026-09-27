// @ts-nocheck
//! expect: 3 true 4 true
// three's ContextNode `context( nodeOrValue = null, value = {} )`, stated as
// `@param {Node|Object}`: `Object` is carried as the open box, which holds a
// node, a record, `null` and `undefined` alike, so the parameter is that box
// rather than a sum whose arms no test can tell apart. ReferenceNode's
// `@param {?Object} [object=null]` is the same box.
class GNode {
  constructor(v) {
    this.v = v
    this.isNode = true
  }
}
class ContextNode extends GNode {
  constructor(node, value) {
    super(0)
    this.node = node
    this.value = value
  }
}
/**
 * @param {GNode|Object} [nodeOrValue={}] - The node or the context data.
 * @param {Object} [value={}] - The modified context data.
 * @returns {ContextNode}
 */
const context = (nodeOrValue = null, value = {}) => {
  let node = nodeOrValue
  if (node === null || node.isNode !== true) {
    value = node || value
    node = null
  }
  return new ContextNode(node, value)
}
/** @param {GNode} node - n. */
const uniformFlow = (node) => context(node, { uniformFlow: true })
class RefNode extends GNode {
  /**
   * @param {string} property - p.
   * @param {?Object} [object=null] - o.
   */
  constructor(property, object = null) {
    super(1)
    this.property = property
    this.object = object
  }
}
const reference = (name, object) => new RefNode(name, object)
const nodeProxy = (n) => new Proxy(n, { get: (target, key) => target[key] })
const c = uniformFlow(nodeProxy(new GNode(3)))
const d = context({ a: 1 })
const r = reference('x', nodeProxy(new GNode(4)))
console.log(c.node.v + ' ' + (d.node === null) + ' ' + r.object.v + ' ' + (context().node === null))
