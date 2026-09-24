//! expect: mixed {"k":[1,{"z":true}]}
//! expect: nullable {"k":[{"z":true},null]}
//! expect: deep {"outer":{"inner":{"deep":[1,"two",{"three":3}]}}}
//! expect: holes [1,null,"x",null]
//! expect: field {"v":"one","w":[2,{"z":false}]}
//! expect: plain {"a":{"b":1,"c":[2,3]},"d":"x"}
//! expect: parsed 7 seven
// `JSON.stringify` of a literal whose nested members are held BY VALUE --
// `{ z: true }` inside an array beside a number, or beside a `null` -- has no
// native writer for the union around it, so the call took the boxed route,
// and a box cannot read a by-value record out of an array: every one of these
// but `plain` aborted on reading `length`. They are written natively now,
// each union by its live arm. `parsed` checks that the read side of an
// ordinary record is untouched.
const flag = (text: string): boolean => text.length > 3

console.log('mixed', JSON.stringify({ k: [1, { z: true }] }))
console.log('nullable', JSON.stringify({ k: [{ z: true }, null] }))
const nested = { outer: { inner: { deep: [1, 'two', { three: 3 }] } } }
console.log('deep', JSON.stringify(nested))
console.log('holes', JSON.stringify([1, undefined, 'x', null]))
console.log('field', JSON.stringify({ v: flag('long') ? 'one' : 1, w: [2, { z: false }] }))
console.log('plain', JSON.stringify({ a: { b: 1, c: [2, 3] }, d: 'x' }))

interface Reading {
  n: number
  s: string
}
const reading = JSON.parse('{"n":7,"s":"seven"}') as Reading
console.log('parsed', reading.n, reading.s)
