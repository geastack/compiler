// @ts-nocheck
//! expect-refusal: "Array.from" of a "keyed-collection(set,tagged-union
//! expect: 2
//! expect: 1 2
//
// three's RenderObject.getAttributes fills a bare `new Set()` with `.add`
// calls and stores `Array.from( vertexBuffers.values() )` into
// `@type {?Array<BufferAttribute|InterleavedBuffer>} this.vertexBuffers`.
// The checker types the copy from the Set's defaulted `any`, so the array was
// `any[]` beside a Set whose key the collection census had bound, and the
// store into the stated field had no conversion (RenderObject.js:566).
// The copy now takes the Set's bound key as its element, so the program
// certifies. What is pinned is the refusal AFTER certification: C++ emission
// of `Array.from` over a Set is the backend's piece. When it lands, drop the
// `expect-refusal` line; the `expect` lines are the program's answer.
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
    this.list = null
  }
  fill(flag) {
    const set = new Set()
    set.add(flag ? new A() : new B())
    set.add(new B())
    this.list = Array.from(set)
  }
}
const h = new Holder()
h.fill(true)
console.log(h.list.length)
console.log(h.list[0].a, h.list[1].b)
export {}
