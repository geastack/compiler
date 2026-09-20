//! expect: error arm
//! expect: bytes 3
//! expect: absent

// `@hono/node-server` reads a buffered body back as `Buffer | Error` and as
// `Buffer | Error | undefined`, then asks `instanceof Error` to tell the
// failure apart from the payload. Both carriers are composite -- a tagged
// union and an optional over one -- and the arms are settled physical
// allocations, so the discriminant answers every arm the `gea::runtime::Error`
// handle does not answer itself.
const describe = (value: Uint8Array | Error): string => (value instanceof Error ? `error arm` : `bytes ${value.length}`)

const describeMaybe = (value: Uint8Array | Error | undefined): string => {
  if (value === undefined) {
    return 'absent'
  }
  return value instanceof Error ? 'error arm' : 'absent'
}

console.log(describe(new RangeError('out of range')))
console.log(describe(new Uint8Array([1, 2, 3])))
console.log(describeMaybe(undefined))
