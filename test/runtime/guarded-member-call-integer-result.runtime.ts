// A record member called through its guarded candidate (a `getInt32LE` helper
// in a binary-document serializer) returns an integer on every input, so the cursor it advances is an
// integer cell. The read is checked where the call returns, because the member
// could hold another callable by then.
//! expect: 14 3 -2
//! emitted-has: gea::requireIntegralCallResult(

interface Codec {
  readLength(bytes: Uint8Array, at: number): number
  readSigned(bytes: Uint8Array, at: number): number
}

const Codec: Codec = {
  readLength(bytes: Uint8Array, at: number): number {
    return bytes[at]! | (bytes[at + 1]! << 8)
  },
  readSigned(bytes: Uint8Array, at: number): number {
    return (bytes[at]! << 24) >> 24
  }
}

function walk(bytes: Uint8Array): string {
  let index = 0
  let frames = 0
  while (index + 2 <= bytes.length) {
    index += 2 + Codec.readLength(bytes, index)
    frames++
  }
  return `${index} ${frames}`
}

const bytes = new Uint8Array([3, 0, 254, 1, 2, 0, 0, 5, 0, 9, 9, 9, 9, 9])
console.log(`${walk(bytes)} ${Codec.readSigned(bytes, 2)}`)
