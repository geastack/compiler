// The negative half of `@gea-host-typed-array-element-writes`: a host method
// that states NO effect contract, handed a typed array, may put any key on any
// intrinsic that array's prototype chain reaches, so the global host-mutation
// census distrusts them and a binary-document library's `%TypedArray%.prototype[@@toStringTag]`
// getter proof must stay refused. The same program with the method tagged is
// `host-mutation-keys.test.ts`'s positive case; this pins that the contract,
// not the shape of the call, is what clears it.
export {}
declare global {
  interface HostBytes {
    fill(target: Uint8Array): void
  }
}
declare function makeHost(): HostBytes
const holder: { escaped: unknown } = { escaped: null }
holder.escaped = globalThis
makeHost().fill(new Uint8Array(1))
const tagOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!
console.log(tagOf.call(new Uint8Array(1)))
//! expect-refusal: native-boundary:Uint8Array.prototype@1
