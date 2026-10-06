// An unproved Number from JSON keeps one general body. Integer, fractional,
// and negative-zero calls must retain their behavior without speculative copies.
//! expect: 9 2 1
//! expect: 0 0 1
//! expect: 3 -0 1
//! emitted-lacks: gea::carriesExactInteger(
//! emitted-lacks: _integral(

function scan(bytes: Uint8Array, start: number): string {
  let offset = start
  let fields = 0
  let total = 0
  while (offset < bytes.length) {
    const size = bytes[offset]! | 0
    if (size === 0) break
    total += size
    offset += size
    fields++
  }
  return `${total} ${fields} ${offset - start - total + 1}`
}

const options = JSON.parse('{"index": 0, "fraction": 0.5, "negativeZero": -0}') as { index: number; fraction: number; negativeZero: number }
const bytes = new Uint8Array([4, 1, 2, 3, 5, 0, 0, 0, 0, 0])
console.log(scan(bytes, options.index))
console.log(scan(bytes, options.fraction))
const zero = scan(new Uint8Array([3, 0, 0]), options.negativeZero)
console.log(zero.split(' ')[0], Object.is(options.negativeZero, -0) ? '-0' : '0', zero.split(' ')[2])
