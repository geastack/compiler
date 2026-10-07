// @ts-nocheck
//! expect-refusal: the @param type of parameter "record" of accept was erased because its callers contradict it
//! expect-refusal: the @param type of parameter "record" of read was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// Excess members are no contradiction, but a missing member and a member of
// another type are: `{ y: 2 }` lacks the `x` the tag requires, and `{ x:
// 'one', y: 2 }` writes it as a string. Both tags are erased, and with the
// census of the callers left open by `callback.bind( this )`, neither
// parameter can be typed from its complete callers. As dynamic parameters
// they would box the records; both are refused by name.
class Sink {
  /** @param {{x: number}} record */
  accept(record) {
    return String(record.x)
  }
  /** @param {{x: number}} record */
  read(record) {
    return String(record.x)
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
console.log(holder.sink.accept({ y: 2 }) + ' ' + holder.sink.read({ x: 'one', y: 2 }))
