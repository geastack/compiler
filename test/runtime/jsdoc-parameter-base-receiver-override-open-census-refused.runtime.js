// @ts-nocheck
//! expect-refusal: the @param type of parameter "value" of erase was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A receiver typed by the base class may be any descendant, so a call through
// it runs every override: `run( item )` passes a string to `item.erase( ... )`
// with `item` a `@param {Base}`, and a `Left` reaching it runs `Left.erase`
// under `@param {number}`. The string contradicts that tag, which is erased.
// With the census of `erase`'s callers left open by `callback.bind( this )`,
// the parameter cannot be typed from its complete callers, and as a dynamic
// parameter it would box the number and the string. It is refused by name.
class Base {
  /** @param {Object} value */
  erase(value) {
    return 1
  }
}
class Left extends Base {
  /** @param {number} value */
  erase(value) {
    return value + 1
  }
}
class Right extends Base {}
class Runner {
  /** @param {Base} item */
  run(item) {
    return item.erase('string')
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.left = new Left()
    this.right = new Right()
  }
}
const holder = new Holder()
const runner = new Runner()
console.log(holder.left.erase(1) + ' ' + runner.run(holder.left) + ' ' + runner.run(holder.right))
