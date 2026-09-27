// @ts-nocheck
//! expect: -1 2.5
// three's NodeMaterial.setupDiffuseColor shape (alphaTestNode): a `let` cell first written `null`,
// then a union of node classes, then a method call on it. The receiver is
// carried as an optional union, so the method read goes through the present
// view of the cell, and the call has to find that read's dispatch.
class GNode {
  constructor(v) {
    this.v = v
  }
  add(o) {
    return new GNode(this.v + (o === this ? 1 : 2))
  }
}
class FloatNode extends GNode {}
class RefNode extends GNode {}
class OtherNode extends GNode {}
/** @param {...any} params @returns {any} */
const float = (p) => new FloatNode(p.v)
const pick = (k) => (k > 0 ? new RefNode(0.5) : new OtherNode(0.25))
const materialAlphaTest = pick(1)
class Material {
  constructor() {
    this.alphaTestNode = null
    this.alphaTest = 0
  }
  setup() {
    let alphaTestNode = null
    if (this.alphaTestNode !== null || this.alphaTest > 0) {
      alphaTestNode = this.alphaTestNode !== null ? float(this.alphaTestNode) : materialAlphaTest
      return alphaTestNode.add(1).v
    }
    return -1
  }
}
const m = new Material()
const r0 = m.setup()
m.alphaTest = 1
console.log(r0 + ' ' + m.setup())
