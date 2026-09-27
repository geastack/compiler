// @ts-nocheck
//! expect: 2 1 2
//! expect: 2 1 2
//
// three's RenderObject.getAttributes stores `Array.from( vertexBuffers.values() )`
// into a stated `?Array<...>` field. The checker instantiates `values()` and
// `keys()` from the Set's defaulted `any`, so the iterator's cursor stated a
// dynamic element over a Set whose key the census had bound, and emission
// refused `set.prototype.values`. Over a bound Set both calls are now the
// `SetIterator` of its key, and the copy iterates the native keys.
class A {
  constructor() {
    this.a = 1
  }
}
class B {
  constructor() {
    this.b = 2
  }
}
class Holder {
  constructor() {
    /** @type {?Array<A|B>} */
    this.values = null
    /** @type {?Array<A|B>} */
    this.keys = null
  }
  fill(flag) {
    const set = new Set()
    set.add(flag ? new A() : new B())
    set.add(new B())
    this.values = Array.from(set.values())
    this.keys = Array.from(set.keys())
  }
}
const h = new Holder()
h.fill(true)
console.log(h.values.length, h.values[0].a, h.values[1].b)
console.log(h.keys.length, h.keys[0].a, h.keys[1].b)
export {}
