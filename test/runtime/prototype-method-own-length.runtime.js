// @ts-nocheck
// A builtin prototype method read as a value carries its own `length` -- the
// shape of test262's `built-ins/{String,Number}/prototype/*/S15.*_A8/A11.js`
// and `toFixed/S15.7.4.5_A2_T01.js` (hasOwnProperty("length") then the read).
//! expect: true 1 true 1
console.log(
  String.prototype.charAt.hasOwnProperty('length'),
  String.prototype.charAt.length,
  Number.prototype.toFixed.hasOwnProperty('length'),
  Number.prototype.toFixed.length
)
