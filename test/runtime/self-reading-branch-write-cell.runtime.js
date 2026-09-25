// @ts-nocheck
//! expect: scratch 3 3
// three's `RangeNode.setup`: a module cell written from its own value, `min =
// min || new Vector4()`, from inside a method. The branch that reads the cell
// adds nothing to what the cell holds; the instance does.
class Vec {
  constructor() {
    this.x = 0
  }
  /** @param {number} s */
  setScalar(s) {
    this.x = s
    return this
  }
}
let scratch = null
class RangeSetup {
  setup() {
    scratch = scratch || new Vec()
    scratch.setScalar(scratch.x + 3)
    return scratch.x
  }
}
const range = new RangeSetup()
console.log('scratch ' + range.setup() + ' ' + (range.setup() - 3))
