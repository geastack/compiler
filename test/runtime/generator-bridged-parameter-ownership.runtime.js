// @ts-nocheck
// A generator body is split into an ordinary outer function plus a private
// coroutine (`ir/generator-split.ts`), and a value the prologue computes that
// the rest of the body still needs -- a destructured or defaulted parameter --
// is BRIDGED across as a fresh parameter of that coroutine. A bridged
// parameter's passing mode is its carrier's OWN, read through
// `defaultOwnershipPolicy.forParameter`, exactly as every real function's ABI
// reads it. Hardcoding it `owned` overrode `shared-refcount` down to a bare
// struct for every refcounted carrier: the outer half passed the array as the
// `gea::Ref` it is actually stored as while the inner coroutine declared its
// formal as an unwrapped `gea::ArrayObject`, and clang rejected the call the
// emitter had just made to the declaration it had just written. The shape of
// test262's `language/expressions/class/dstr/gen-meth-ary-ptrn-elem-ary-rest-init.js`
// and its neighbours, where a rest element with an initializer puts an array
// carrier in the bridged position.
//! expect: 2,1,3
//! expect: tagged 4,5
class C {
  *method([[...x] = [2, 1, 3]]) {
    yield x
  }
}
for (const each of new C().method([[2, 1, 3]])) {
  console.log(each.join(','))
}
class D {
  constructor() {
    this.tag = 'tagged'
  }
  *method([...x] = [4, 5]) {
    yield this.tag + ' ' + x.join(',')
  }
}
for (const each of new D().method()) {
  console.log(each)
}
