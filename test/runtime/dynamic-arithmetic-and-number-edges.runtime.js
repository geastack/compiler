// @ts-nocheck
//! dynamic-fallback
//! expect: 3 12 2.5 1 8 -8 -3 true false true true 5 TypeError NaN NaN NaN true -Infinity
// Two operands that are both dynamic meet an arithmetic, bitwise or relational
// operator through the language's own dispatch: ToNumeric on each, the BigInt
// or Number operation, IsLessThan for the comparisons (two strings compare as
// strings). ToNumber of a BigInt is a TypeError. And the Number operations
// themselves: `1 ** NaN` and `(-1) ** Infinity` are NaN, which C's `pow` is
// not, and a remainder takes its dividend's sign even when it is zero.
const values = JSON.parse('[5, 2, "10", "b", "a", 4, 3, -4]')
const [five, two, ten, b, a, four, three, minusFour] = values
const out = []
const note = (value) => out.push(String(value))
note(five - two)
note(four * three)
note(five / two)
note(five % two)
note(two ** three)
note(-two << two)
note(~two)
note(a < b)
note(ten < two)
note('10' < '9')
note(b >= a)
note(five & 7)
try {
  note(isNaN(BigInt(1)))
} catch (error) {
  note(error.name)
}
note(1 ** NaN)
note((-1) ** Infinity)
note(Math.pow(1, NaN))
note(Object.is(four % -2, 0))
note(1 / (minusFour % two))
console.log(out.join(' '))
