// @ts-nocheck
//! expect: get x vec3 true true true
//! expect: alias true xy
//! expect: set 5 7
//! expect: sub true float
//! expect: index 0 true 2
//! expect: own nodeType,_cache | nodeType
// three's TSL swizzles: accessor descriptors built in a loop into a plain
// table, then `Object.defineProperties(Node.prototype, proto)`. Each getter
// runs with the node the read resolved on -- never the descriptor literal --
// caches its result in an instance expando (`this._cache`), and each setter
// calls a method through the getter (`this[k].assign(v)`). Subclass
// instances inherit them; the cache is an own key, the accessors are not.
class ExtShaderNode {
  constructor(nodeType) {
    this.nodeType = nodeType
  }
  assign(value) {
    this.assigned = value
    return this
  }
}
class ExtSplitNode extends ExtShaderNode {
  constructor(node, components) {
    super('float')
    this.node = node
    this.components = components
  }
}
class ExtFloatNode extends ExtShaderNode {}

const proto = {}
function setProtoSwizzle(property, altA) {
  proto[property] = proto[altA] = {
    get() {
      this._cache = this._cache || {}
      let split = this._cache[property]
      if (split === undefined) {
        split = new ExtSplitNode(this, property)
        this._cache[property] = split
      }
      return split
    },
    set(value) {
      this[property].assign(value)
    }
  }
}
setProtoSwizzle('x', 'r')
setProtoSwizzle('xy', 'rg')
for (let i = 0; i < 4; i++) {
  proto[i] = {
    get() {
      this._cache = this._cache || {}
      let element = this._cache[i]
      if (element === undefined) {
        element = new ExtSplitNode(this, String(i))
        this._cache[i] = element
      }
      return element
    }
  }
}
Object.defineProperties(ExtShaderNode.prototype, proto)

const node = new ExtShaderNode('vec3')
const x = node.x
console.log('get', x.components, x.node.nodeType, x.node === node, node.x === x, x instanceof ExtSplitNode)
console.log('alias', node.r === x, node.rg.components)
node.x = 5
node.xy = 7
console.log('set', x.assigned, node.xy.assigned)
const sub = new ExtFloatNode('float')
console.log('sub', sub.x.node === sub, sub.x.node.nodeType)
console.log('index', node[0].components, node[0] === node[0], node[2].components)
console.log('own', Object.keys(node).join(','), '|', Object.keys(new ExtShaderNode('int')).join(','))
