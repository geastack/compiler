// `Math.abs` of an integer and `Math.clz32` of anything are integers, so a
// vorticity confinement's `Math.abs(gx)`, `Math.clz32(length)` and every
// shift and product after them stay in the integers (geastack/demos ripple:
// they were doubles, soft-float per cell on the ESP32-S31). The double
// answers -- `Math.abs(-2.5)`, `Math.abs(-0)`, NaN -- must be unchanged.
//! emitted-has: gea::integerAbs(static_cast<long long>(
//! emitted-has: gea::integerClz32(
//! expect: field -1967542924
//! expect: clz 32 31 0 0 32 32 29 1
//! expect: abs 2.5 Infinity NaN 7
//! expect: abs-int 5 0 2147483648

function field(values: Int32Array): number {
  let sum = 0
  for (let c = 1; c < values.length - 1; c++) {
    const gx = values[c + 1] - values[c - 1]
    const ax = Math.abs(gx)
    const length = ax + 1
    const shift = Math.max(0, 22 - Math.clz32(length))
    sum = (sum + (gx >> shift) * ((length >> shift) & 1023)) | 0
  }
  return sum
}

const values = new Int32Array(4096)
for (let i = 0; i < values.length; i++) values[i] = ((i * 2654435761) | 0) >> 3
console.log('field', field(values))

const zero = 0
const big = 2 ** 32 + 7
console.log(
  'clz',
  Math.clz32(zero),
  Math.clz32(1),
  Math.clz32(-1),
  Math.clz32(-2147483648),
  Math.clz32(NaN),
  Math.clz32(0.5),
  Math.clz32(big - 2 ** 32 - 3 + 2 ** 32),
  Math.clz32(1 << 30)
)
const negativeZero = -0
const notNumber = NaN
console.log('abs', Math.abs(-2.5), 1 / Math.abs(negativeZero), Math.abs(notNumber), Math.abs(-7))
let i = -5
console.log('abs-int', Math.abs(i), Math.abs(i + 5), Math.abs((i | 0) - 2147483643))
