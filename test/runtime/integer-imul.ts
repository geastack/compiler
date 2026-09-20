//! expect: integer-imul ok
//! emitted-has: gea::integerImul(
//! emitted-has: gea::toUint32(
//! emitted-has: gea::host::Math::imul
// A direct builtin call can lose its callable carrier, but must still perform
// ToUint32 for inputs whose storage is a double. Aliases remain real functions.
export {}
function check(actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`imul: ${actual} != ${expected}`)
}
function multiply(a: number, b: number): number {
  return Math.imul(a, b)
}
check(multiply(0xffffffff, 5), -5)
check(multiply(0x80000000, 1), -2147483648)
check(multiply(-5, -5), 25)
check(multiply(3.9, -2.9), -6)
check(multiply(4294967297, 3), 3)
check(multiply(9007199254740992, 3), 0)
check(multiply(NaN, 7), 0)
check(multiply(Infinity, 7), 0)
check(multiply(-Infinity, 7), 0)
check(1 / multiply(-0, 7), Infinity)
const alias = Math.imul
check(alias(-1, 5), -5)
if (alias !== Math.imul) throw new Error('builtin function identity changed')
function shadowed(): number {
  const Math = { imul: (a: number, b: number): number => a + b }
  return Math.imul(3, 4)
}
check(shadowed(), 7)
let calls = 0
function next(): number {
  calls++
  return calls
}
check(Math.imul(next(), next()), 2)
check(calls, 2)
let order = ''
function left(): number {
  order += 'L'
  return 3
}
function right(): number {
  order += 'R'
  return 4
}
check(Math.imul(left(), right()), 12)
if (order !== 'LR') throw new Error('argument evaluation order changed')
console.log('integer-imul ok')
