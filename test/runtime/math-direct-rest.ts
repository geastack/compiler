//! expect: -Infinity Infinity
//! expect: Infinity Infinity -Infinity -Infinity
//! expect: NaN NaN NaN
//! expect: 3 123
//! expect: NaN 12345
//! expect: true true
//! expect: 102 2
//! expect: 99 99 false 4
//! emitted-has: gea::host::Math::maxDirect({
//! emitted-has: gea::host::Math::minDirect({

let order = 0
function argument(value: number): number {
  order = order * 10 + value
  return value
}
console.log(Math.max(), Math.min())
console.log(Math.max(3), Math.min(3), Math.max(-4, 7, 2), Math.min(-4, 7, 2))
console.log(1 / Math.max(-0, 0), 1 / Math.max(0, -0), 1 / Math.min(-0, 0), 1 / Math.min(0, -0))
console.log(1 / Math.max(-0), 1 / Math.min(0))
console.log(Math.max(NaN, 1), Math.max(1, NaN, 2), Math.max(1, NaN))
console.log(Math.min(NaN, 1), Math.min(1, NaN, 2), Math.min(1, NaN))
console.log(Math.max(Infinity, -Infinity), Math.min(Infinity, -Infinity))
console.log(Math.max(argument(1), argument(2), argument(3)), order)
console.log(Math.min(NaN, argument(4), argument(5)), order)
const values = [4, -2, 9]
const maximum = Math.max
const minimum = Math.min
console.log(maximum(4, -2, 9), minimum(4, -2, 9))
console.log(maximum === Math.max, minimum === Math.min)
console.log(Math.max(...values), Math.min(5, ...values), values.length)
const other = {
  max(...numbers: number[]): number {
    return numbers.length + 100
  }
}
console.log(other.max(1, 2), Math['max'](1, 2))
function rest(...numbers: number[]): number[] {
  numbers[0] = 99
  return numbers
}
const first = rest(1, 2)
const second = rest(3, 4)
console.log(first[0], second[0], first === second, values[0])
