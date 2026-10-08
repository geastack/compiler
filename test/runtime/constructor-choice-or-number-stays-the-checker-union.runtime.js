//! expect: or zero 0 Base Derived
// The other side of `constructor-choice-or-null-keeps-the-null`: a right
// operand that is neither a class constructor nor an absence is not a
// constructor choice, so the merge keeps the checker's own type for the
// whole `||` and the number arm stays a number.
class Base {
  constructor() {
    this.size = 1
  }
}
class Derived extends Base {}
/** @type {Map<number, typeof Base | typeof Derived>} */
const registry = new Map()
registry.set(1, Base)
registry.set(2, Derived)
/** @param {number} key @return {typeof Base | typeof Derived | number} */
function orZero(key) {
  return registry.get(key) || 0
}
/** @param {typeof Base | typeof Derived | number} value */
const nameOf = (value) => (typeof value === 'number' ? String(value) : value.name)
console.log('or zero', nameOf(orZero(0)), nameOf(orZero(1)), nameOf(orZero(2)))
