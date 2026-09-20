// @ts-nocheck
// A Date setter reads its time value BEFORE coercing any argument (step 3
// precedes the ToNumber steps): a `valueOf` that calls `setTime` on the same
// date is observed by the coercion and forgotten by the setter, whose result
// derives from the value read first -- and an invalid time value returns NaN
// without a store, so the coercion's own write stays. test262
// `built-ins/Date/prototype/set*/date-value-read-before-tonumber-when-date-is-{valid,invalid}.js`.
//! expect: 1 true 1
//! expect: 1 true 0
var dt = new Date(0)
var valueOfCalled = 0
var value = {
  valueOf: function () {
    valueOfCalled++
    dt.setTime(NaN)
    return 1
  }
}
var result = dt.setDate(value)
console.log(valueOfCalled, result === dt.getTime(), dt.getDate())
var invalid = new Date(NaN)
var calls = 0
var revive = {
  valueOf: function () {
    calls++
    invalid.setTime(0)
    return 1
  }
}
var r2 = invalid.setDate(revive)
console.log(calls, r2 !== r2, invalid.getTime())
