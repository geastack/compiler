// @ts-nocheck
// A number or boolean held as a dynamic value reads its prototype's methods:
// `value.toFixed(3)` on a member of a parsed document. The runtime modelled no
// prototype for a boxed primitive, so every key read `undefined` and the call
// threw "Value is not a function" where Node formats the number. The forms
// without an argument follow ECMA-262: `toFixed()` is zero digits,
// `toPrecision()` and `toString()` are ToString. A key the prototype does not
// hold still reads `undefined`.
const v = JSON.parse('{"w":0.6071,"n":255,"b":true,"big":12345.678}')
console.log(
  v.w.toFixed(3),
  v.w.toFixed(),
  v.n.toString(16),
  v.n.toString(),
  v.big.toPrecision(4),
  v.big.toPrecision(),
  v.big.toExponential(2)
)
console.log(v.n.valueOf() + 1, v.b.toString(), v.b.valueOf(), typeof v.n.toFixed, v.n.missing, typeof v.b.toFixed)
try {
  v.n.nope()
} catch (e) {
  console.log(e instanceof TypeError)
}
//! expect: 0.607 1 ff 255 1.235e+4 12345.678 1.23e+4
//! expect: 256 true true function undefined undefined
//! expect: true
export {}
