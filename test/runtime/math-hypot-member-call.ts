//! expect: 5 13 0 Infinity NaN
//! expect: 17 29
//! expect: hypot of a spread true

// `Math.hypot(...)` called as a member: the function never reads its receiver,
// so the call carries none, whether it names `Math`, an alias, or a `.call`.
const values = [6, 8]
console.log(Math.hypot(3, 4), Math.hypot(5, 12), Math.hypot(), Math.hypot(NaN, -Infinity), Math.hypot(NaN, 1))
const hypotenuse = Math.hypot
console.log(hypotenuse(8, 15), hypotenuse.call(values, 20, 21))
console.log('hypot of a spread', Math.hypot(...values) === 10)
