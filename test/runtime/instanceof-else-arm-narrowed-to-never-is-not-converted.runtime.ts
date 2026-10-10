// A binary-document serializer's object-id class normalizes a byte view it
// has already narrowed to `Uint8Array`:
//
//   } else if (ArrayBuffer.isView(workingId) && workingId.byteLength === 12) {
//     this.setFromBytes(workingId instanceof Uint8Array ? workingId : bytes.toLocalBufferType(workingId))
//
// The parameter admits no other view, so the conditional's else arm reads a
// `never`: no value of the program's own types reaches it, and nothing has to
// be converted into `toLocalBufferType`'s parameter there.
const toLocalBufferType = (buffer: Uint8Array | ArrayBufferView | ArrayBuffer): Uint8Array =>
  buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.byteLength)

function bytesOf(input?: string | number | Uint8Array): Uint8Array | string {
  if (ArrayBuffer.isView(input) && input.byteLength === 3) {
    return input instanceof Uint8Array ? input : toLocalBufferType(input)
  }
  return String(input)
}

const bytes = bytesOf(new Uint8Array([1, 2, 3]))
//! expect: 3 7
console.log((typeof bytes === 'string' ? -1 : bytes.length) + ' ' + bytesOf(7))
