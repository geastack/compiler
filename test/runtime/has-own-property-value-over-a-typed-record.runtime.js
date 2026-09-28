// @ts-nocheck
//! dynamic-fallback
//! expect: a,b true false
// rfdc's `Object.hasOwnProperty.call(o, k)` and safe-stable-stringify's
// `const { hasOwnProperty } = Object.prototype` over a record the program
// types.
function keys (o) {
  const out = []
  for (const k in o) {
    if (Object.hasOwnProperty.call(o, k) === false) continue
    out.push(k)
  }
  return out.join(',')
}
const { hasOwnProperty } = Object.prototype
const rec = { a: 1, b: 2 }
console.log(keys(rec), hasOwnProperty.call(rec, 'a'), hasOwnProperty.call(rec, 'z'))
