// @ts-nocheck
//! expect: true false false
//! emitted-lacks: gea::Value gea_arg_0
//! emitted-lacks: gea::Value::box(gea::Value::Tag::Object
// A union value passed only past a test of it is no evidence that its other
// arms reach. `run( value )` states `@param {A|C}` and passes `value` to
// `accept( value )`, under `@param {B|C}`, only inside `if ( value.isC )`.
// The checker does not narrow by that member, and reading the whole `A | C`
// erased the callee's tag; the census of `accept`'s callers, left open by
// `callback.bind( this )`, then refused the parameter. Which arms pass the
// test is not known there, so the tag stands, and converting the narrowed
// value into it is the native conversion's question. three's `Renderer`
// passes its `Vector2 | Vector4` to `Vector4.copy( v )`, under `@param
// {Vector3|Vector4}`, only past `rectangle.isVector4`.
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
    if (value.isC) return this.accept(value)
    return false
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
