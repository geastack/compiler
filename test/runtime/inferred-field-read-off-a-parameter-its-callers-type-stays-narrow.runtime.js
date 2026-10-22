// @ts-nocheck
// The caller analysis of the dynamic-store widening: a member read off a
// parameter no census typed (`from.x`) and a method called on one
// (`attribute.getW( index )`) are dynamic only where a call site passes an
// untyped object, and a Map built without type arguments holds what its own
// `set` calls put in it (`names.get( key )`). Every call site here passes a
// typed object, so the fields these fill keep their native carriers
// although the parameters themselves are not typed.
class Vec {
  constructor(x, y) {
    this.x = x
    this.y = y
  }
}
class Attribute {
  constructor(values) {
    this.values = values
  }
  getW(index) {
    return this.values[index]
  }
}
class Quat {
  constructor() {
    this.x = 0
    this.y = 0
    this.w = 1
    this.tag = 'none'
  }
  fromVectors(from, to) {
    this.x = from.y - to.y
    this.y = from.x
    return this
  }
  fromAttribute(attribute, index) {
    this.w = attribute.getW(index)
    return this
  }
  name(key) {
    this.tag = names.get(key)
    return this
  }
}
const names = new Map()
names.set('a', 'alpha')
const q = new Quat()
  .fromVectors(new Vec(1, 2), new Vec(3, 5))
  .fromAttribute(new Attribute([0.5, 0.25]), 1)
  .name('a')
console.log(q.x, q.y, q.w, q.tag)
//! expect: -3 1 0.25 alpha
//! emitted-lacks: gea::Value x;
//! emitted-lacks: gea::Value y;
//! emitted-lacks: gea::Value w;
//! emitted-lacks: gea::Value tag;
export {}
