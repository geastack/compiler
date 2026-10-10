// A method whose parameter names an intersection over `ArrayBufferView`
// (a binary-document library's byte-utility `toLocalBufferType`) stored in a slot whose function
// type names plain `ArrayBufferView`: the adapter's parameter conversion must
// carry every arm, not select the shared ones.
type ViewWithTag = ArrayBufferView & { [Symbol.toStringTag]?: string }

type Utils = {
  toLocal: (buffer: Uint8Array | ArrayBufferView | ArrayBuffer) => Uint8Array
}

const webUtils = {
  toLocal(input: Uint8Array | ViewWithTag | ArrayBuffer): Uint8Array {
    const tag = input?.[Symbol.toStringTag] ?? Object.prototype.toString.call(input)
    if (tag === 'Uint8Array') return input as Uint8Array
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
    }
    return new Uint8Array(input as ArrayBuffer)
  }
}

const pick = (web: boolean): Utils =>
  web ? webUtils : { toLocal: (buffer) => (buffer instanceof Uint8Array ? buffer : new Uint8Array(0)) }

const utils = pick(true)
console.log(Array.from(utils.toLocal(new Uint8Array([1, 2, 3]))).join(','))
console.log(utils.toLocal(new ArrayBuffer(3)).length)

//! expect: 1,2,3
//! expect: 3
