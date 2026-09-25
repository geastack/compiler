// @ts-nocheck
// three's `NodeMaterial.copy` as written: each member of `source` is either
// copied into this one's own (`this[ property ].copy( value )`) or assigned.
// The carriers resolve (see `for-in-this-copy-narrowed-member.runtime.js`);
// what stops it is emission: the computed read of `source[ property ]` on a
// class instance publishes an optional over a tagged union of the class's
// member types, methods included, and the box has no tag for that.
//! expect-refusal: which this backend has no box tag for
class Vec {
  constructor(x) {
    this.x = x
  }

  /** @param {Vec} other */
  copy(other) {
    this.x = other.x
    return this
  }
}

class Material {
  constructor() {
    this.name = ''
  }

  /** @param {Material} source */
  copy(source) {
    this.name = source.name
    return this
  }
}

class NodeMat extends Material {
  constructor() {
    super()
    /** @type {?Vec} */
    this.colorNode = null
    this.fog = true
    this.offset = new Vec(0)
  }

  /** @param {NodeMat} source */
  copy(source) {
    for (const property in this) {
      if (/^_/.test(property)) continue
      if (this[property] !== undefined && source[property] !== undefined) {
        const value = source[property]
        if (this[property] && this[property].copy !== undefined) {
          this[property].copy(value)
        } else {
          this[property] = value
        }
      }
    }
    return super.copy(source)
  }
}

const a = new NodeMat()
const b = new NodeMat()
b.name = 'b'
b.fog = false
b.offset.x = 4
b.colorNode = new Vec(2)
a.copy(b)
console.log(a.name, a.fog, a.offset.x, a.colorNode === b.colorNode)
