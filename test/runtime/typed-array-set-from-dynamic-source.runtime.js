// @ts-nocheck
//! expect: typed 1,2,3,0
//! expect: array 0,7,0,9
//! expect: like 5,6,0,0
//! expect: string 0,1,2,0
//! expect: null TypeError
//! expect: empty 0,0,0,0
//! emitted-has: gea::typedArraySetFromValue(
// `%TypedArray%.prototype.set` from a source the checker types `any`
// (three's `previousBoneMatrices.set( skeleton.boneMatrices )` reads the
// skeleton off an untyped callback argument). ECMA-262 23.2.3.26 picks the
// algorithm from the VALUE, not the type: a typed array is copied through its
// own element type (SetTypedArrayFromTypedArray), and anything else is
// ToObject'd and read as an array-like -- "length", then each index through
// [[Get]] and ToNumber (SetTypedArrayFromArrayLike).
/** @param {any} source @param {number} offset */
const into = (source, offset) => {
  const target = new Int16Array(4)
  target.set(source, offset)
  return target.toString()
}
/** @type {any[]} */
const sources = [new Uint8Array([1, 2, 3]), [7, undefined, 9], { length: 2, 0: '5', 1: 6 }, '12']
console.log('typed', into(sources[0], 0))
console.log('array', into(sources[1], 1))
console.log('like', into(sources[2], 0))
console.log('string', into(sources[3], 1))
try {
  into(null, 0)
  console.log('null none')
} catch (error) {
  console.log('null', error instanceof TypeError ? 'TypeError' : 'other')
}
// A source with no "length" is an empty array-like: nothing is written, and
// an offset at the very end still fits.
console.log('empty', into({}, 4))
