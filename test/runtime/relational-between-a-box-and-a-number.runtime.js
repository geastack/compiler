// @ts-nocheck
//! dynamic-fallback
//! expect: true false true true false false
// IsLessThan with one boxed operand is decided by what the box holds: a string
// against a number compares numerically, a string against a string would not.
function count(queue) { return queue.length }
const o = JSON.parse('{"n": 3, "s": "10", "q": [1, 2]}')
console.log(o.n >= 3, o.n < 2, 2 <= o.n, o.s > 9, o.s < 5, count(o.q) > o.n)
