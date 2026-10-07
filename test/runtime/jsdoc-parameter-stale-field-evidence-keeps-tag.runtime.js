// @ts-nocheck
//! expect: 3
//! emitted-lacks: gea::Value::box
// A field tag the same round blanks is no evidence against a parameter tag.
// `Member` states `@type {NotString}` over the `@param {string} value` it
// stores; the store contradicts the field tag, which is blanked. Read at that
// tag, `sink.accept( this.value )` passed a `NotString` and erased the
// correct `@param {string} name` too, and the census of `accept`'s callers,
// left open by `callback.bind( this )`, refused the parameter. The program
// compiled next types the field by its store, a string, and the tag stands:
// `name` is a native string. three's `MemberNode` states `@type {Node}` over
// its `@param {string} property` and passes it to every `getMemberType`.
class NotString {
  constructor() {
    this.x = 1
  }
}
class Member {
  /** @param {string} value */
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
    return name.length
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.sink = new Sink()
    this.member = new Member('abc')
  }
}
const holder = new Holder()
console.log(holder.member.run(holder.sink))
