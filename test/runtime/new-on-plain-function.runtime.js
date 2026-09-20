//! expect: object object 1 2
// A plain JavaScript function with nothing to initialise is still a
// constructor: `new F()` allocates an instance of `F`'s (empty) instance
// type. The checker only infers a construct signature from evidence inside
// the body, so `new-callee-class-tag-source-transform.ts` states the fact
// with a `@class` tag; the construct thunk then builds a receiver-less body
// (`translation-unit.ts`'s `constructThunkOf`) instead of faulting.
function F() {}
var o = new F()
var H = function () {}
var h = new H()
/** @param {number} n */
function G(n) {
  this.n = n
}
var g = new G(1)
console.log(typeof o, typeof h, g.n, new G(2).n)
