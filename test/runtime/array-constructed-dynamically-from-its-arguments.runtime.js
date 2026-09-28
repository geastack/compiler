// @ts-nocheck
//! dynamic-fallback
//! expect: 3 true 1 x 2 a,b RangeError
// pino's multistream `new Array(this.streams.length)` over a boxed length,
// and the element forms of ECMA-262 23.1.1.1.
const box = JSON.parse('{"streams":[1,2,3],"name":"x"}')
const sized = new Array(box.streams.length)
const one = new Array(box.name)
const two = new Array('a', 'b')
let error = ''
try {
  new Array(JSON.parse('-1'))
} catch (e) {
  error = e.name
}
console.log(sized.length, !(0 in sized), one.length, one[0], two.length, two.join(','), error)
