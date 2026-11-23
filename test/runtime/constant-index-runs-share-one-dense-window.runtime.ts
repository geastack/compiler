//! expect: product 30 36 42 66 81 96 102 126 150
//! expect: aliased 30 36 42 66 81 96 102 126 150
//! expect: frozen threw true kept 1
//! expect: short 1 2 0 4 length 4
//! expect: holes 1 absent 3
//! expect: alias seen 9 9
//! emitted-has: gea::denseWindowCellsMutable
// A run of constant-index reads and stores of one array checks the array's
// storage once, at its first access, and the rest use its cells: a matrix
// product reads nine elements of each operand and stores nine. Every case the
// per-access checks answered still holds: the output may be an operand, a
// frozen array still refuses the store, an array shorter than the run grows
// on the plain path, a hole still reads absent, and a store through one name
// is seen by a read through another name of the same array.

const multiply = (out: number[], a: number[], b: number[]): number[] => {
  const a11 = a[0],
    a12 = a[1],
    a13 = a[2]
  const a21 = a[3],
    a22 = a[4],
    a23 = a[5]
  const a31 = a[6],
    a32 = a[7],
    a33 = a[8]
  const b11 = b[0],
    b12 = b[1],
    b13 = b[2]
  const b21 = b[3],
    b22 = b[4],
    b23 = b[5]
  const b31 = b[6],
    b32 = b[7],
    b33 = b[8]
  out[0] = a11 * b11 + a12 * b21 + a13 * b31
  out[1] = a11 * b12 + a12 * b22 + a13 * b32
  out[2] = a11 * b13 + a12 * b23 + a13 * b33
  out[3] = a21 * b11 + a22 * b21 + a23 * b31
  out[4] = a21 * b12 + a22 * b22 + a23 * b32
  out[5] = a21 * b13 + a22 * b23 + a23 * b33
  out[6] = a31 * b11 + a32 * b21 + a33 * b31
  out[7] = a31 * b12 + a32 * b22 + a33 * b32
  out[8] = a31 * b13 + a32 * b23 + a33 * b33
  return out
}

const m = [1, 2, 3, 4, 5, 6, 7, 8, 9]
console.log('product ' + multiply([0, 0, 0, 0, 0, 0, 0, 0, 0], m, m).join(' '))
const inPlace = [1, 2, 3, 4, 5, 6, 7, 8, 9]
console.log('aliased ' + multiply(inPlace, inPlace, [1, 2, 3, 4, 5, 6, 7, 8, 9]).join(' '))

const fill = (target: number[]): void => {
  'use strict'
  target[0] = target[0]! + 5
  target[1] = target[1]! + 5
}
const frozen = Object.freeze([1, 2]) as number[]
let threw = false
try {
  fill(frozen)
} catch {
  threw = true
}
console.log('frozen threw ' + threw + ' kept ' + frozen[0])

const grow = (target: number[]): void => {
  target[0] = 1
  target[1] = 2
  target[3] = 4
}
const short: number[] = []
grow(short)
console.log('short ' + short[0] + ' ' + short[1] + ' ' + (short[2] ?? 0) + ' ' + short[3] + ' length ' + short.length)

const sparse: number[] = [1]
sparse[2] = 3
const firstAndThird = (values: number[]): string =>
  values[0] + ' ' + (values[1] === undefined ? 'absent' : String(values[1])) + ' ' + values[2]
console.log('holes ' + firstAndThird(sparse))

const writeThenRead = (left: number[], right: number[]): string => {
  const before = right[0]
  left[0] = 9
  return before === 9 ? 'stale' : right[0] + ' ' + left[0]
}
const shared = [1, 2]
console.log('alias seen ' + writeThenRead(shared, shared))
