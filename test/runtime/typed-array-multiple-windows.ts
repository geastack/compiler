//! expect: 1 4 5 6 5 6
//! expect: 1 1 1
//! expect: 7 8 9
//! emitted-has: gea::denseIndexWindow
//! emitted-has: ::readInBounds(
//! emitted-has: ::writeInBounds(

function copyPlusOne(bytes: Uint8Array, from: number, to: number, count: number): void {
  for (let i = 0; i < count; i++) bytes[to + i] = (bytes[from + i] ?? 0) + 1
}
const valid = new Uint8Array([1, 2, 3, 4, 5, 6])
copyPlusOne(valid, 2, 1, 3)
console.log(valid[0], valid[1], valid[2], valid[3], valid[4], valid[5])
const short = new Uint8Array(3)
copyPlusOne(short, 3, 0, 3)
console.log(short[0], short[1], short[2])
const fractional = new Uint8Array([7, 8, 9])
copyPlusOne(fractional, 0, 0.5, 3)
console.log(fractional[0], fractional[1], fractional[2])
