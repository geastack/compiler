// @ts-nocheck
//! dynamic-fallback
//! expect: 7 5 number true 9 number
// A helper whose return the checker inferred from `Atomics.load` over a view
// it saw as `any`, so from the BigInt overload. The census types the view
// `Int32Array`, which rules that overload out even though the `string |
// number` index fits neither exactly, and the helper returns the Number the
// load produces -- at its declaration, at every call, and through a caller
// whose own return the checker inferred from that one.
function poke (view, index, value) {
  Atomics.store(view, index, value)
  return Atomics.load(view, index)
}
/** @type {any} */
const shared = new Int32Array(new SharedArrayBuffer(16))
const first = poke(shared, '1', 7)
const second = poke(shared, 2, 5)
const again = (view, index) => poke(view, index, 9)
const third = again(shared, 3)
console.log(first, second, typeof first, first + 1 === 8, third, typeof third)
