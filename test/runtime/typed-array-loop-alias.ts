//! expect: 1065353216 2 2 2 2
//! expect: 0 1 2 3 4
//! expect: 1065353216 0
//! emitted-has: gea::denseIndexWindow
//! emitted-has: ::readInBounds(
//! emitted-has: ::writeInBounds(

// Differently typed views alias the same bytes. The range proof does not
// authorize C++ type-based alias assumptions or reordering a read past a store.
function mixed(words: Uint32Array, floats: Float32Array, count: number): number {
  let sum = 0
  for (let i = 0; i < count; i++) {
    words[i] = 1065353216
    sum += floats[i] ?? 0
    floats[i] = 2
  }
  return sum
}
const bytes = new ArrayBuffer(16)
const words = new Uint32Array(bytes)
const floats = new Float32Array(bytes)
console.log(mixed(words, floats, 4) * 266338304, floats[0], floats[1], floats[2], floats[3])

function overlap(source: Uint8Array, target: Uint8Array, count: number): void {
  for (let i = 0; i < count; i++) target[i] = (source[i] ?? 0) + 1
}
const buffer = new ArrayBuffer(5)
const whole = new Uint8Array(buffer)
overlap(new Uint8Array(buffer, 0, 4), new Uint8Array(buffer, 1, 4), 4)
console.log(whole[0], whole[1], whole[2], whole[3], whole[4])
// A fifth read is absent; a non-finite bound enters no iterations. Neither
// case may turn the optional element read into an unchecked native access.
console.log(mixed(words, floats, 5) * 266338304, mixed(words, floats, NaN))
