// `view.buffer` is typed `ArrayBufferLike` (`ArrayBuffer | SharedArrayBuffer`),
// so `new Uint8Array(view.buffer.slice(a, b))` -- a binary-document
// library's `toLocalBufferType` -- constructs over a native SUM of the two
// block kinds. Either arm is ECMA-262 23.2.5.1's buffer overload over that
// block: a view of the sliced copy, not a second copy of it. The result's
// `.buffer.byteLength` is read off that same sum's arm natively.
function copyOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}
function tailOf(view: ArrayBufferView, from: number): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + from)
}

function listed(view: Uint8Array): string {
  let out = ''
  for (let i = 0; i < view.length; i++) out += (i === 0 ? '' : ',') + String(view[i])
  return out
}

const source = new Uint8Array([10, 20, 30, 40, 50])
const middle = source.subarray(1, 4)
const copied = copyOf(middle)
source[2] = 99
console.log(copied.length, listed(copied), copied.byteOffset, copied.buffer.byteLength)
//! expect: 3 20,30,40 0 3
const tail = tailOf(middle, 1)
console.log(tail.length, listed(tail))
//! expect: 3 99,40,50
