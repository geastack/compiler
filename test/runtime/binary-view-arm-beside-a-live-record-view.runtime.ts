// node-compat's `Request` reads `init.body.buffer` off a `BodyInit` holding
// both a `Buffer` and a structural `ArrayBufferView<ArrayBuffer>` record, and
// that record is a LIVE VIEW of a Document whenever a dynamic body (hono's
// `cloneRawRequest` assigns `await req[cacheKey]()`) is read as it. The read
// is that view's descriptor route on one arm and the typed array's own
// `buffer` internal slot on the other.
export {}

interface ByteView {
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

const lengthOf = (body: Uint8Array | ByteView): number => {
  const buffer = body.buffer
  return buffer.byteLength * 1000 + body.byteOffset * 10 + body.byteLength
}

const bytes = new Uint8Array(new ArrayBuffer(8), 2, 4)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamic: any = JSON.parse('{"byteOffset": 1, "byteLength": 3}')
dynamic.buffer = new ArrayBuffer(5)
const viewed: ByteView = dynamic
console.log(lengthOf(bytes), lengthOf(viewed))
//! expect: 8024 5013
