// @ts-nocheck
//
// A cell that starts `null` and is later written a conditional whose operands
// are dynamic (three's NodeMaterial `setupDiffuseColor`: `let alphaTestNode =
// null`, then `alphaTestNode = this.alphaTestNode !== null ? float(
// this.alphaTestNode ) : materialAlphaTest`, both operands untyped). The
// conditional's arm is contributed as `any` so the cell goes dynamic, but the
// join answered the `null` placeholder (`any` is assignable to it): the cell
// was laid out as bare `null`, the store unboxed the material node into it,
// and every later read of the cell was a read of `null`.
class Mat {
  constructor() {
    this.alphaTestNode = null
    this.alphaTest = 0.5
  }
  setup(dyn) {
    let alphaTestNode = null
    if (this.alphaTestNode !== null || this.alphaTest > 0) {
      alphaTestNode = this.alphaTestNode !== null ? dyn.float(this.alphaTestNode) : dyn.test
      return alphaTestNode.k
    }
    return alphaTestNode === null ? -1 : 0
  }
}
const dynSource = JSON.parse('{"test":{"k":7}}')
console.log(new Mat().setup(dynSource))
const m = new Mat()
m.alphaTest = 0
console.log(m.setup(dynSource))
//! expect: 7
//! expect: -1
