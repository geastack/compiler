//! expect: -0 1 -0
//! expect: 0 0
//! expect: -0 x
//! expect: neg -0 pos 0
//! expect: nz -0 none

// Node formats console arguments with util.inspect, which prints negative
// zero as `-0`; ToString (`String(-0)`, a template) still answers `0`.
const xs = [0]
// A fractional step keeps `zero` a double; an integer-narrowed slot cannot hold -0 at all.
const zero = xs.length / 2 - 0.5
console.log(-0, xs.length, -zero)
console.log(String(-0), `${-zero}`)
const mixed: number | string = xs.length > 0 ? -zero : 'never'
console.log(mixed, 'x')
const values: unknown[] = []
values.push('neg', -zero, 'pos', zero)
console.log(...values)
const maybe: number | undefined = xs.length > 0 ? -zero : undefined
const absent: number | undefined = xs.length > 5 ? 1 : undefined
console.log('nz', maybe, absent === undefined ? 'none' : absent)
