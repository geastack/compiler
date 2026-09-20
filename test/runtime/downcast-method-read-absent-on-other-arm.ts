// READING A METHOD THROUGH AN `as` DOWNCAST OFF A UNION WHOSE LIVE ARM DOES
// NOT HAVE IT, AND ONLY TESTING WHAT CAME BACK.
//
// `@hono/node-server`'s `Request` constructor duck-types a stream body with
// `typeof (options?.body as ReadableStream)?.getReader !== 'undefined'`, where
// `body` is a `string | Buffer | ReadableStream | ...` union. The `as` is an
// unchecked assertion: it changes the checker's type, never the value, so on
// the string arm 6.2.5.5 GetV reads `undefined` and the test answers `false`.
// Nothing is called, so nothing may throw. The checker's type for the read is
// a bare callable, which cannot hold that `undefined`; the read's carrier has
// to be widened to the member's value on every arm, not the asserted one's.

class Stream {
  getReader(): string {
    return 'reader'
  }
}

const isStreamLike = (body: string | Stream | undefined): boolean => typeof (body as Stream)?.getReader !== 'undefined'

//! expect: stream=true
console.log('stream=' + isStreamLike(new Stream()))

//! expect: string=false
console.log('string=' + isStreamLike('plain'))

//! expect: absent=false
console.log('absent=' + isStreamLike(undefined))

const readerOf = (body: string | Stream): string => {
  const read = (body as Stream).getReader
  return read === undefined ? 'none' : 'some'
}

//! expect: read-stream=some
console.log('read-stream=' + readerOf(new Stream()))

//! expect: read-string=none
console.log('read-string=' + readerOf('plain'))
