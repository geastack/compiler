// @ts-nocheck
//! expect: 3
//! emitted-has: , const gea::Ref<gea_record_type_
//! emitted-lacks: gea::Value gea_arg_0
// A literal member typed nullable is the record the tag states where its
// present value is the one the tag names. `{ shadow, depth: 2 }` carries the
// `?Shadow` field, and whole-record assignability read that `null` arm as a
// contradiction of `inputs.shadow`, which a direct argument's absence never
// is; with the census of `accept`'s callers left open by `callback.bind(
// this )`, the erased tag refused the parameter. Each member is now read as
// a direct argument is, by its present arms, and the tag stands: `inputs` is
// a native record. three's `ShadowNode.setupShadowFilter` is passed the
// `?LightShadow` it has already dereferenced under `@param {LightShadow}
// inputs.shadow`.
class Shadow {
  constructor() {
    this.value = 1
  }
}
class Sink {
  /**
   * @param {Object} inputs
   * @param {Shadow} inputs.shadow
   * @param {number} inputs.depth
   */
  accept({ shadow, depth }) {
    return shadow.value + depth
  }
}
class Holder {
  constructor() {
    function callback() {}
    this.listener = callback.bind(this)
    this.sink = new Sink()
    /** @type {?Shadow} */
    this.shadow = new Shadow()
  }
  run() {
    const { shadow } = this
    return this.sink.accept({ shadow, depth: 2 })
  }
}
console.log(new Holder().run())
