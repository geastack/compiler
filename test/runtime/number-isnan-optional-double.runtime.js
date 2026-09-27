// @ts-nocheck
//! expect: false true false true
// Number.isNaN on a value laid out as an optional number: an absent value is
// not a Number, so the answer is false, as it is for any other non-Number.
function pick(k) {
  let v = k > 0 ? k * 1.5 : null
  if (k > 5) v = Number.NaN
  return v
}
const a = pick(2)
const b = pick(9)
const c = pick(-1)
console.log(Number.isNaN(a) + ' ' + Number.isNaN(b) + ' ' + Number.isNaN(c) + ' ' + (c === null))
