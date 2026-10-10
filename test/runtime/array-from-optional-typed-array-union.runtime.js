// @ts-nocheck
// A 3D library's texture-source `toJSON` copies `Array.from( image.data )`, where `data` is
// one of the typed arrays a DataTexture holds -- or absent. The copy goes by
// the arm the value holds; the absent arm is the TypeError JavaScript throws
// when `Array.from` asks `undefined` for its iterator.

/** @param {{ data?: Float32Array | Uint8Array }} image */
function serialize(image) {
  return Array.from(image.data)
}

console.log(serialize({ data: new Float32Array([1.5, -2]) }).join(','))
console.log(serialize({ data: new Uint8Array([7, 8, 9]) }).join(','))
try {
  serialize({})
  console.log('no throw')
} catch (error) {
  console.log(error instanceof TypeError)
}

//! expect: 1.5,-2
//! expect: 7,8,9
//! expect: true

//! emitted-has: gea_from_sum
