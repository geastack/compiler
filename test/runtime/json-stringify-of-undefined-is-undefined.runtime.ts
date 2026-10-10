// `JSON.stringify` returns `undefined`, not a string, for a value with no JSON
// form -- `undefined` itself, a function, a symbol -- although lib.d.ts
// declares it `string`. A database client's handshake relies on it:
// `JSON.stringify(hello.maxWireVersion) ?? 0` reads a field an old server
// omits, and the `?? 0` arm TypeScript considers dead is the live one.
type Doc = { [key: string]: any }

function describe(hello: Doc): string {
  return `max ${JSON.stringify(hello.maxWireVersion) ?? 0}`
}

console.log(describe({}), describe({ maxWireVersion: 21 }), describe({ maxWireVersion: 'x' }))
//! expect: max 0 max 21 max "x"
