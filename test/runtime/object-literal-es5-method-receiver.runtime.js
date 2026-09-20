// @ts-nocheck
// An object literal's `function` property is its method spelled the ES5 way:
// `o.m()` binds `this` to the literal, and a hoisted `var` the method assigns
// from a NESTED function is a write the checker's flow analysis never sees
// (it answers `undefined` at the later read) -- the census does. Shaped after
// test262's `built-ins/Date/prototype/set*/arg-coercion-order.js` (an
// argument's `valueOf` records `arguments` and `this`) and the harness's
// `this-value-*` borrows through `Function.prototype.call`.
//! expect: true
//! expect: true true 7
//! expect: 0 true true
var t
var o = {
  m: function () {
    t = this
    return 1
  }
}
o.m()
console.log(t === o)
var caught = function (f) {
  try {
    f()
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}
console.log(
  caught(function () {
    Date.prototype.toISOString.call([])
  }),
  caught(function () {
    Date.prototype.toString.call(0)
  }),
  Date.prototype.getTime.call(new Date(7))
)
var date = new Date(2016, 6)
var args, thisValue
var arg = {
  valueOf: function () {
    args = arguments
    thisValue = this
    return 2
  }
}
var r = date.setDate(arg)
console.log(args.length, thisValue === arg, r === new Date(2016, 6, 2).getTime())
