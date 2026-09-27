// @ts-nocheck
//! expect: 2 true true false
//
// A Set whose census key is a union of two classes holds a tagged union per
// key. Adding the same object twice keeps one key, and `has` finds a key only
// when it holds the same arm and the same object (SameValueZero over the
// union: `gea::sameValueZero` for `TaggedUnion`). Before, the Set's key
// comparison had no rendering for a tagged union and the C++ did not compile.
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
const a = new A()
const b = new B()
class Holder {
  count(flag) {
    const set = new Set()
    set.add(flag ? a : b)
    set.add(b)
    set.add(flag ? a : b)
    return `${set.size} ${set.has(flag ? a : b)} ${set.has(b)} ${set.has(flag ? new A() : b)}`
  }
}
console.log(new Holder().count(true))
export {}
