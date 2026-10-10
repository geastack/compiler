//! expect: null
//! expect: str:hi
//! expect: stream:reader
// A Node HTTP adapter's cached-response writer. node prints
// `null` / `str:hi` / `stream:reader`.
//
// `InternalCache[1]` is declared `string | ReadableStream | null`, and the
// function still asks `body instanceof Uint8Array`: the adapter stores a whole
// `BodyInit` through an `any`-typed symbol key and reads it back with an
// unchecked `as InternalCache`. TypeScript cannot discard the arm, so the
// branch's type is `StreamLite & Uint8Array`.
//
// This was pinned as a refusal (2026-09-23), on the argument that pruning the
// branch would silently miscompile every binary response. It does not: the
// native carrier of `string | StreamLite | null` is physically a string or a
// `gea::Ref<StreamLite>`, so no Uint8Array can reach this test -- a value the
// program lies about is refused LOUDLY at the conversion into the declared
// type (the slot write, or the `as InternalCache` read), never routed into a
// branch. A user class is never a Uint8Array, so the intersection is
// uninhabited (`derive.ts`'s `isUninhabitedClassTypedArrayIntersection`) and
// the `instanceof` is the constant `false` it is for every value this carrier
// can hold. `instanceof-typed-array-over-unrelated-class-is-dead.runtime.ts`
// pins the same rule on its own.
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
