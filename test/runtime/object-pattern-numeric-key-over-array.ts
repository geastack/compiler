//! expect: 7 8 9 undefined 3 outer
//! expect: 5 9

// An object pattern's NUMERIC key over a plain array reads the element WITH
// `undefined` -- position 3 of a three-element array is `undefined` to the
// language, and a read typed bare aborted at runtime as an out-of-range index.
// `length` stays an ordinary member read, and a default replaces the absence.
let outer = 'outer'
let [...{ 0: v, 1: w, 2: x, 3: y, length: z }] = [7, 8, 9]
console.log(v, w, x, y, z, outer)
const arr: number[] = [9]
const { 1: d = 5, 0: e = 4 } = arr
console.log(d, e)
