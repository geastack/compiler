// @ts-nocheck
//! expect-refusal: the @param type of parameter "inputs" of accept was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "inputs" of read was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A nullable member is read by its present arms, and a present arm the tag
// excludes is still a contradiction: `{ shadow: this.label }` writes a
// `?string` and `{ shadow: this.other }` a `?Other` where `inputs.shadow`
// states a `Shadow`. Both tags are erased, and with the census of the
// callers left open by `callback.bind( this )`, neither parameter can be
// typed from its complete callers. As dynamic parameters they would box the
// records; both are refused by name.
class Shadow {
  constructor() {
    this.value = 1
  }
}
class Other {
  constructor() {
    this.value = 2
  }
}
class Sink {
  /**
   * @param {Object} inputs
   * @param {Shadow} inputs.shadow
   */
  accept(inputs) {
    return String(inputs.shadow)
  }
  /**
   * @param {Object} inputs
   * @param {Shadow} inputs.shadow
   */
  read(inputs) {
    return String(inputs.shadow.value)
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.sink = new Sink()
    /** @type {?string} */
    this.label = 'one'
    /** @type {?Other} */
    this.other = new Other()
  }
  run() {
    return this.sink.accept({ shadow: this.label }) + ' ' + this.sink.read({ shadow: this.other })
  }
}
console.log(new Holder().run())
