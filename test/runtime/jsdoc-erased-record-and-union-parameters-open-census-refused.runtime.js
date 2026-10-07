// @ts-nocheck
//! expect-refusal: the @param type of parameter "options" of read was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "node" of read was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A record without the tag's member and a `number | Vec` field each
// contradict an `@param {Other}` tag, so both tags are erased. With the census
// of `read`'s callers left open by `callback.bind( this )`, neither parameter
// can be typed from its complete callers: as dynamic parameters they would
// take the record and the typed union boxed. Both are refused by name.
class Vec {
  constructor() {
    this.x = 1
  }
}
class Other {
  constructor() {
    this.z = 3
  }
}
class Library {
  constructor(flag) {
    /** @type {number|Vec} */
    this.value = flag ? 1 : new Vec()
    this.text = this.read({ y: 2 }, this.value)
  }
  /** @param {Other} options @param {Other} node */
  read(options, node) {
    return String(options.y) + ' ' + String(node)
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.library = new Library(true)
  }
}
console.log(new Holder().library.text)
