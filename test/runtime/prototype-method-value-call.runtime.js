// @ts-nocheck
// A builtin prototype method read as a VALUE and invoked through
// `Function.prototype.call`: `thisTimeValue(this value)` (21.4.4) throws a
// TypeError for every receiver that is not a Date, and dispatches to the
// method for one that is -- the shape of test262's
// `built-ins/Date/prototype/*/this-value-{non-date,non-object,valid-date}.js`.
//! expect: function true true true true true true
//! expect: object true true true
//! expect: valid 5 1975 2
var getTime = Date.prototype.getTime
var setFullYear = Date.prototype.setFullYear
var args = (function () {
  return arguments
})()
var symbol = Symbol()
var caught = function (f) {
  try {
    f()
    return false
  } catch (e) {
    return e instanceof TypeError
  }
}
console.log(
  typeof getTime,
  caught(function () {
    getTime.call(0)
  }),
  caught(function () {
    getTime.call(true)
  }),
  caught(function () {
    getTime.call(null)
  }),
  caught(function () {
    getTime.call(undefined)
  }),
  caught(function () {
    getTime.call('')
  }),
  caught(function () {
    getTime.call(symbol)
  })
)
console.log(
  'object',
  caught(function () {
    getTime.call({})
  }),
  caught(function () {
    getTime.call([])
  }),
  caught(function () {
    getTime.call(args)
  })
)
var d = new Date(5)
console.log(
  'valid',
  getTime.call(d),
  new Date(setFullYear.call(d, 1975)).getFullYear(),
  new Date(setFullYear.call(new Date(0), 1975, 2)).getMonth()
)
