//! expect: not bytes
//! expect: bytes

// `@hono/node-server` narrows a cached response body down to one shim class
// and still asks `body instanceof Uint8Array`. A program class's instance is a
// C++ object of that class's own layout and the only native base this compiler
// links is the intrinsic Error family, so the answer is settled `false` -- and
// was renderable all along, merely unclaimed.
class StreamBody {
  readonly kind = 'stream'
}

const describe = (body: StreamBody | Uint8Array): string => (body instanceof Uint8Array ? 'bytes' : 'not bytes')

console.log(describe(new StreamBody()))
console.log(describe(new Uint8Array([7])))
