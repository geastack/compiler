// @ts-nocheck
// Operators over two genuinely dynamic operands -- members of a parsed
// document -- follow ECMA-262 through the runtime's own ToPrimitive,
// ToNumber and comparison algorithms: `+` concatenates when either side is a
// string, the other arithmetic, bitwise and shift operators work on Numbers,
// relational operators compare strings by code unit and everything else as
// Numbers, `==` coerces and `===` does not, and the unary `-`, `+`, `~` take
// ToNumber. A `+` of two dynamic operands, a relational, an equality or a
// unary operator over one had no spelling and refused the whole program.
const d = JSON.parse('{"a":3,"b":4,"s":"x","n":null,"t":"5"}')
const a = d.a,
  b = d.b,
  s = d.s,
  t = d.t
console.log(a + b, s + a, a + t, a - b, a * b, b / a, b % a, a ** 2, a - t)
console.log(a < b, a <= t, s > a, a == t, a === t, a != b, a !== b, d.n == undefined)
console.log(a & b, a | b, a ^ b, a << 2, b >> 1, -a >>> 28, -a, +t, !a, ~a, typeof a)
let c = d.a
c += d.b
c++
c -= 1
console.log(c, c * 2 + 1, 'b' > 'a', s < t, d.n == 0, d.n === null)
//! expect: 7 x3 35 -1 12 1.3333333333333333 1 9 -2
//! expect: true true false false false true true true
//! expect: 0 7 7 12 2 15 -3 5 false -4 number
//! expect: 7 15 true false false true
export {}
