// @ts-nocheck
// `Function.prototype.toString` held in a module constant and later called
// with a receiver -- Zag's `isPlainObject` (@zag-js/utils guard.ts) does this.
// Neither `Function` nor `Function.prototype` has an object in this backend,
// so the authenticated chain is one intrinsic value (20.2.3.5): it answers a
// callable's source text and throws a TypeError for anything else.
//! expect: function named() { return 1 }
//! expect: true
//! expect: function toString 0 true true
var fnToString = Function.prototype.toString
// The expectation is the function's own source text, so it must stay on one line.
// prettier-ignore
function named() { return 1 }
console.log(fnToString.call(named))
console.log(Function.prototype.toString.call(named) === fnToString.call(named))
var caught = function (f) {
  try {
    f()
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}
console.log(
  typeof fnToString,
  fnToString.name,
  fnToString.length,
  caught(function () {
    fnToString.call(1)
  }),
  caught(function () {
    fnToString.call({})
  })
)
