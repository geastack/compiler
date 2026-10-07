// @ts-nocheck
//! expect-refusal: the @param type of parameter "value" of accept was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// The same `A | C` passed with no test of it: every arm of it is a value
// `accept`'s parameter holds, and `B|C` states no arm an `A` fits, so the tag
// is contradicted and erased, as three's `Node | Array<Node>` compute group
// contradicts `@param {RenderContext|ComputeNode}`. With the census of
// `accept`'s callers left open by `callback.bind( this )`, the parameter
// cannot be typed from its complete callers; as a dynamic parameter it would
// box the instances passed to it. It is refused by name.
class A {
  constructor() {
    this.a = 1
    this.isC = false
  }
}
class B {
  constructor() {
    this.b = 2
    this.isC = false
  }
}
class C {
  constructor() {
    this.c = 3
    this.isC = true
  }
}
class Sink {
  /** @param {B|C} value */
  accept(value) {
    return value.isC
  }
  /** @param {A|C} value */
  run(value) {
    return this.accept(value)
  }
}
class Holder {
  constructor() {
    function cb() {}
    this.listener = cb.bind(this)
    this.sink = new Sink()
  }
}
const holder = new Holder()
console.log(holder.sink.run(new C()) + ' ' + holder.sink.run(new A()) + ' ' + holder.sink.accept(new B()))
