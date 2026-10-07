// @ts-nocheck
//! expect-refusal: the @param type of parameter "name" of accept was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A blanked field tag is no evidence, but the field's own writes are. Here
// `Member` stores a `@param {number} value` under `@type {NotString}`; the
// first round blanks the field tag and reads nothing off it. The program
// compiled next types the field by its store, a number, and the settled
// round finds that number passed to `@param {string} name`: the tag is
// erased. With the census of `accept`'s callers left open by
// `callback.bind( this )`, `name` cannot be typed from its complete callers,
// and as a dynamic parameter it would box the number. It is refused by name.
class NotString {
  constructor() {
    this.x = 1
  }
}
class Member {
  /** @param {number} value */
  constructor(value) {
    /** @type {NotString} */
    this.value = value
  }
  /** @param {Sink} sink */
  run(sink) {
    return sink.accept(this.value)
  }
}
class Sink {
  /** @param {string} name */
  accept(name) {
    return String(name)
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.sink = new Sink()
    this.member = new Member(7)
  }
}
const holder = new Holder()
console.log(holder.member.run(holder.sink))
