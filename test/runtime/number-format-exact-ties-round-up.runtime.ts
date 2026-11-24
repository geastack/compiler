export {}

// ECMA-262 21.1.3.3/2/5: toFixed, toExponential and toPrecision round the
// EXACT binary value once, and on an exact tie "pick the larger n" -- half up
// on the magnitude, where printf breaks the tie to even.
//
// 260042689.0618805 sits 9e-10 below the midpoint, but `x * 1e6` rounds onto
// .5 and a pre-scaled round printed "...061881". 1.45, 0.045 and 5e-7 are the
// same false tie at smaller scale.
// 1143989562988.28125 is a true tie where the next double up is itself a
// kept digit away, so nudging the value instead of the digits read ".2815".
const fixed: [number, number][] = [
  [260042689.0618805, 6],
  [1.005, 2],
  [0.5, 0],
  [2.5, 0],
  [-2.5, 0],
  [1.45, 1],
  [0.045, 2],
  [5e-7, 6],
  [0.125, 2],
  [99.995, 2],
  [999.5, 0],
  [1143989562988.28125, 4],
  [-0, 2],
  [-1e-7, 2],
  [-1e21, 2]
]
console.log('fixed ' + fixed.map(([value, digits]) => value.toFixed(digits)).join(' '))

const exponential: [number, number][] = [
  [2.5, 0],
  [-2.5, 0],
  [12.5, 1],
  [9.5, 0],
  [125, 1],
  [-0, 1]
]
console.log('exponential ' + exponential.map(([value, digits]) => value.toExponential(digits)).join(' '))

const precision: [number, number][] = [
  [2.5, 1],
  [12.5, 2],
  [9.5, 1],
  [0.000125, 2],
  [-0, 2]
]
console.log('precision ' + precision.map(([value, digits]) => value.toPrecision(digits)).join(' '))

//! expect: fixed 260042689.061880 1.00 1 3 -3 1.4 0.04 0.000000 0.13 100.00 1000 1143989562988.2813 0.00 -0.00 -1e+21
//! expect: exponential 3e+0 -3e+0 1.3e+1 1e+1 1.3e+2 0.0e+0
//! expect: precision 3 13 1e+1 0.00013 0.0
