//! expect: null
//! expect: str:hi
//! expect: stream:reader
// `@hono/node-server` listener.ts `responseViaCache`, line 192 -- FORMERLY
// PINNED AS A REFUSAL. Since the node-compat campaign the `instanceof
// Uint8Array` arm over `string | StreamLite | null` is proved false from the
// declared type and pruned, and the program prints what node prints, which is
// what is pinned now. The hazard the history below describes -- hono's slot
// holding a `Uint8Array` its declared type excludes -- is not expressible in
// a program whose types are honest, and stays upstream in hono's types.
//
// `InternalCache[1]` is declared `string | ReadableStream | null`, and the
// function still asks `body instanceof Uint8Array`: hono stores a whole
// `BodyInit` through an `any`-typed symbol expando and reads it back with an
// unchecked `as InternalCache`, so the declared type is narrower than what the
// slot holds. TypeScript cannot discard the arm, so the branch's type is
// `ReadableStream & Uint8Array`.
//
// Both carriers for that intersection refuse, in different places, and the
// refusal is correct either way:
//   - the nominal class (today's answer) carries the branch, and passing it to
//     `end(chunk?: string | Uint8Array)` has no `class-ref -> optional(string |
//     uint8)` conversion;
//   - letting the typed array outrank the nominal class in `deriveIntersection`
//     (tried, measured, reverted) only moves the refusal one node earlier, onto
//     the narrowing itself: `optional(string | class-ref, null)` is physically a
//     string or a `gea::Ref<StreamLite>` and there is no Uint8Array inside it to
//     narrow to.
//
// The value really is a Uint8Array at runtime, so proving the `instanceof`
// false and pruning the branch would be a silent miscompile of every binary
// response. The honest repair is upstream of this compiler -- `InternalCache`
// has to admit what hono puts in it -- so the refusal stands and is pinned here.
class StreamLite {
  getReader(): string {
    return 'reader'
  }
}

type CachedBody = string | StreamLite | null

const end = (chunk?: string | Uint8Array): string =>
  chunk === undefined ? 'end' : typeof chunk === 'string' ? `end:${chunk}` : `end:${chunk.byteLength}`

const write = (body: CachedBody): string => {
  if (body === null) return 'null'
  if (typeof body === 'string') return `str:${body}`
  if (body instanceof Uint8Array) return end(body)
  return `stream:${body.getReader()}`
}

console.log(write(null))
console.log(write('hi'))
console.log(write(new StreamLite()))
