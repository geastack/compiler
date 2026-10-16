// Class definition evaluates heritage, every computed name, then static effects.
function effect(label: string): number {
  console.log(label)
  return 1
}
function first(): 'first' {
  effect('key-first')
  return 'first'
}
function second(): 'second' {
  effect('key-second')
  return 'second'
}
class Base {}
function heritage(): typeof Base {
  effect('heritage')
  return Base
}
class Ordered extends heritage() {
  static before = effect('field-before');
  [first()]() {
    console.log('UNUSED_METHOD_MUST_NOT_RUN')
  }
  static {
    effect('block-first')
    console.log('identity', this === Ordered)
  }
  [second()]() {
    console.log('UNUSED_SECOND_METHOD_MUST_NOT_RUN')
  }
  static after = effect('field-after')
  static {
    effect('block-last')
  }
}
effect('after')
//! expect: heritage
//! expect: key-first
//! expect: key-second
//! expect: field-before
//! expect: block-first
//! expect: identity true
//! expect: field-after
//! expect: block-last
//! expect: after
//! emitted-lacks: UNUSED_METHOD_MUST_NOT_RUN
//! emitted-lacks: UNUSED_SECOND_METHOD_MUST_NOT_RUN
