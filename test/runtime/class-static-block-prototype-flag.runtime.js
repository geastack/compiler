// @ts-nocheck
//! expect: isVector3 true true 5
//! expect: shadow false true
// three's `math/Vector3.js` exactly: a data property on the class prototype
// from a static block (plan 1.2's leftover). An own write shadows it on one
// instance only.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  static {
    Vector3.prototype.isVector3 = true
  }
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z)
  }
}
const v = new Vector3(3, 4, 0)
console.log('isVector3', v.isVector3 === true, new Vector3().isVector3, v.length())
v.isVector3 = false
console.log('shadow', v.isVector3, new Vector3().isVector3)
