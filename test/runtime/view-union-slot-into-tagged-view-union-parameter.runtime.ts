// A binary-document library's `ByteUtils.toLocalBufferType` slot is typed
// `(buffer: Uint8Array | ArrayBufferView | ArrayBuffer) => Uint8Array`, and the
// web implementation stored there declares its parameter as
// `Uint8Array | (ArrayBufferView & { [Symbol.toStringTag]?: string }) | ArrayBuffer`.
// Calling through the slot hands the method every arm the slot names; the
// `ArrayBufferView` arm must reach the method as its tagged view, not be dropped.
type ViewWithTag = ArrayBufferView & { [Symbol.toStringTag]?: string }

type Utils = {
  toLocal: (buffer: Uint8Array | ArrayBufferView | ArrayBuffer) => Uint8Array
}

const webUtils = {
  toLocal(input: Uint8Array | ViewWithTag | ArrayBuffer): Uint8Array {
    if (input instanceof Uint8Array) return input
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
    return new Uint8Array(input)
  }
}

const utils: Utils = webUtils
console.log(Array.from(utils.toLocal(new Uint8Array([1, 2, 3]))).join(','))
console.log(Array.from(utils.toLocal(new Uint8Array([7, 8, 9]).subarray(1))).join(','))
console.log(utils.toLocal(new ArrayBuffer(3)).length)

//! expect: 1,2,3
//! expect: 8,9
//! expect: 3
