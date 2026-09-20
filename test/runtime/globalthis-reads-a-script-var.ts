// A script-level `var` is an own data property of the global object
// (ECMA-262 9.1.1.4.17), so `globalThis.X` is the live cell `X` names -- not
// a lookup in the expando dictionary, which holds only what the program
// installed at run time. @hono/node-server's `headers.ts` does exactly
// `export const GlobalHeaders = globalThis.Headers` against a platform class
// this program declares as a `var`; a `??` over a missing one falls through.
class HeadersImpl {
  count = 2
}
var Headers2: typeof HeadersImpl = HeadersImpl
var counter = 1
const Captured = globalThis.Headers2
console.log(Captured === HeadersImpl)
console.log(new Captured().count)
counter += 1
console.log(globalThis.counter)
//! expect: true
//! expect: 2
//! expect: 2
