//! expect: pattern
//! expect: literal
//! expect: buffer
//! expect: not a buffer

// hono's trie router carries a route matcher as `RegExp | true` and asks
// `matcher instanceof RegExp`; node-compat's `Response` constructor narrows
// `BodyInit` down to `ArrayBuffer | <shim classes>` and asks `body instanceof
// ArrayBuffer`. Both are a discriminant test over arms whose identity IS their
// physical carrier here -- one native pattern layout, one byte block, and a
// program class that is neither.
const describeMatcher = (matcher: RegExp | true): string => (matcher instanceof RegExp ? 'pattern' : 'literal')

class FormPayload {
  readonly name = 'form'
}

const describeBody = (body: ArrayBuffer | FormPayload): string => (body instanceof ArrayBuffer ? 'buffer' : 'not a buffer')

console.log(describeMatcher(/abc/))
console.log(describeMatcher(true))
console.log(describeBody(new ArrayBuffer(4)))
console.log(describeBody(new FormPayload()))
