// @ts-nocheck
//! expect: 2,3 | 4 true
// `i * itemSize + itemSize` over an untyped `itemSize` is a `+` that may
// concatenate, so the sum is `dynamic`; a typed array's `subarray` end and an
// Array's `length` take it through ToNumber. three's `WebGPUAttributeUtils`
// (`array.subarray( i * itemSize, i * itemSize + itemSize )`, `itemSize` read
// off an untyped record) and `ClippingContext` (`dstClippingPlanes.length =
// offset + l`) pass such sums.
const bufferData = JSON.parse('{"_itemSize": 2}')
function slice(array, i) {
  const itemSize = bufferData._itemSize
  return array.subarray(i * itemSize, i * itemSize + itemSize)
}
const context = JSON.parse('{"planes": [1, 2, 3]}')
function grow(destination, l) {
  const offset = context.planes.length
  if (destination.length !== offset + l) destination.length = offset + l
  return destination
}
const planes = grow([0], 1)
console.log(Array.from(slice(new Float32Array([0, 1, 2, 3, 4]), 1)).join(','), '|', planes.length, planes[3] === undefined)
