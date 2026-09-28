// @ts-nocheck
//! dynamic-fallback
//! expect: true 7 true 3
// thread-stream's `const WeakRef = cond ? FakeWeakRef : global.WeakRef ||
// FakeWeakRef`: `new WeakRef(stream)` constructs through whichever arm is live.
class FakeWeakRef {
  constructor (value) {
    this._value = value
  }

  deref () {
    return this._value
  }
}
const choose = (fake) => (fake ? FakeWeakRef : globalThis.WeakRef || FakeWeakRef)
const target = { n: 7 }
const Ref = choose(JSON.parse('false'))
const ref = new Ref(target)
const Fake = choose(JSON.parse('true'))
const fake = new Fake({ n: 3 })
console.log(ref.deref() === target, ref.deref().n, fake instanceof FakeWeakRef, fake.deref().n)
