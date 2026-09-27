// @ts-nocheck
//! expect: split x true
//! expect: element 1 true
//! expect: split yy element 0
// three's TSLCore fills `proto` with swizzle literals whose `get()` builds a
// SplitNode and index literals whose `get()` builds an ArrayElementNode, then
// installs them on Node.prototype. The literals share one bag slot's record,
// so `get` has one result: either class, not the first literal's alone.
class Node {
  constructor(kind) {
    this.kind = kind
  }
}
class SplitNode extends Node {
  constructor(node, components) {
    super('split')
    this.node = node
    this.components = components
  }
}
class ArrayElementNode extends Node {
  constructor(node, index) {
    super('element')
    this.node = node
    this.index = index
  }
}
const proto = {}
function setSwizzle(property) {
  proto[property] = {
    get() {
      this._cache = this._cache || {}
      let split = this._cache[property]
      if (split === undefined) {
        split = new SplitNode(this, property)
        this._cache[property] = split
      }
      return split
    },
    set(value) {
      console.log('set ' + property + ' ' + value)
    }
  }
}
setSwizzle('x')
setSwizzle('yy')
for (let i = 0; i < 2; i++) {
  proto[i] = {
    get() {
      this._cache = this._cache || {}
      let element = this._cache[i]
      if (element === undefined) {
        element = new ArrayElementNode(this, i)
        this._cache[i] = element
      }
      return element
    },
    set(value) {
      console.log('set ' + i + ' ' + value)
    }
  }
}
Object.defineProperties(Node.prototype, proto)
const node = new Node('input')
console.log(node.x.kind, node.x.components, node.x === node.x)
console.log(node[1].kind, node[1].index, node[1].node === node)
const other = new Node('other')
console.log(other.yy.kind, other.yy.components, other[0].kind, other[0].index)
export {}
