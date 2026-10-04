// @ts-nocheck
//! expect: swizzle x n true
//! expect: index 3 n
//! expect: set y=5 1=9
// three's TSLCore: `proto[ property ] = { get() {...}, set( value ) {...} }`
// for every swizzle name and `proto[ i ] = { get, set }` for every index,
// then `Object.defineProperties( Node.prototype, proto )`. ECMA-262
// 20.1.2.3.1 reads each table entry with ToPropertyDescriptor and installs
// its accessor halves as functions the [[Get]]/[[Set]] call with the
// instance as `this`.
class TslNode {
  /** @param {string} name */
  constructor(name) {
    this.name = name
  }
}
class SplitNode {
  /** @param {any} node @param {string} components */
  constructor(node, components) {
    this.node = node
    this.components = components
  }
}
class ElementNode {
  /** @param {any} node @param {number} index */
  constructor(node, index) {
    this.node = node
    this.index = index
  }
}
const proto = {}
/** @param {string} property */
function setProtoSwizzle(property) {
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
    /** @param {any} value */
    set(value) {
      this._last = property + '=' + value
    }
  }
}
for (const p of ['x', 'y', 'xy']) setProtoSwizzle(p)
for (let i = 0; i < 4; i++) {
  proto[i] = {
    get() {
      return new ElementNode(this, i)
    },
    /** @param {any} value */
    set(value) {
      this._index = i + '=' + value
    }
  }
}
Object.defineProperties(TslNode.prototype, proto)
const n = new TslNode('n')
console.log('swizzle', n.x.components, n.xy.node.name, n.x === n.x)
console.log('index', n[3].index, n[3].node.name)
n.y = 5
n[1] = 9
console.log('set', n._last, n._index)
