// A database client's request signing hands a `Uint8Array` to Web Crypto's
// `digest(algorithm, data: BufferSource)`; the body tells a view from a bare
// ArrayBuffer with `ArrayBuffer.isView` and reads the view's window.
function windowOf(data: BufferSource): string {
  if (ArrayBuffer.isView(data)) return `view ${data.byteOffset} ${data.byteLength} ${data.buffer.byteLength}`
  return `buffer ${data.byteLength}`
}
const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
console.log(windowOf(backing))
console.log(windowOf(backing.subarray(2, 5)))
console.log(windowOf(backing.buffer))
//! expect: view 0 6 6
//! expect: view 2 3 6
//! expect: buffer 6
