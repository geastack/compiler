// @ts-nocheck
//! expect: 1 3
//! emitted-has: , const gea::Ref<gea_record_type_
//! emitted-lacks: gea::Value gea_arg_0
// A literal with members the tag does not state is still the record the tag
// states. `{ x: 1, y: 2 }` failed only the checker's excess-member check on a
// fresh literal, which is about how the literal is written, and erased
// `@param {{x: number}} record`; the census of `accept`'s callers, left open
// by `callback.bind( this )`, then refused the parameter. Read without its
// freshness, as the same record bound to a local is read, it has every
// member the tag requires, and the tag stands: `record` is a native record.
// three's `ShadowNode` passes `setupShadowFilter` a literal with two members
// its tag does not state.
class Sink {
  /** @param {{x: number}} record */
  accept(record) {
    return record.x
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
const bound = { x: 3, z: 4 }
console.log(holder.sink.accept({ x: 1, y: 2 }) + ' ' + holder.sink.accept(bound))
