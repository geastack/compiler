// `Array.from` over a sum of typed-array views -- a 3D library's `image.data` is any
// of the nine element kinds. The copy goes by the arm the value holds, each
// arm the same `fromTypedArray` a single-view source takes.
function copy(data: Float32Array | Uint8Array | Int16Array): number[] {
  return Array.from(data)
}

const wide = copy(new Float32Array([1.5, 2.5]))
const bytes = copy(new Uint8Array([3, 4, 5]))
const shorts = copy(new Int16Array([-7]))
console.log(wide.join(','), bytes.join(','), shorts.join(','))

//! expect: 1.5,2.5 3,4,5 -7
