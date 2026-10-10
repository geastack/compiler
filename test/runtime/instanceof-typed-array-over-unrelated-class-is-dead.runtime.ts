// An HTTP server adapter's `responseViaCache` reads a cached
// body typed `string | ReadableStream | null` and tests it against a typed
// array it can never be:
//
//   } else if (body instanceof Uint8Array) {
//     outgoing.end(body)
//
// TypeScript narrows the class arm by intersecting instead of discarding it, so
// the true branch's `body` is `ReadableStream & Uint8Array`. No object is both a
// compiled class instance and a native typed array, so that branch is dead and
// nothing has to be converted into `end`'s `string | Uint8Array` parameter.
class Stream {
  readonly chunks: string[] = []
}

const sizeOf = (data?: string | Uint8Array): number => (data === undefined ? 0 : data.length)

function send(body: string | Stream | null): number {
  if (body === null) return sizeOf()
  if (typeof body === 'string') return sizeOf(body)
  if (body instanceof Uint8Array) return sizeOf(body)
  return body.chunks.length + 100
}

const stream = new Stream()
stream.chunks.push('a', 'b')
//! expect: 0 5 102
console.log(send(null) + ' ' + send('hello') + ' ' + send(stream))
