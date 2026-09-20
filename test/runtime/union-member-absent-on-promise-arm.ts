// READING A MEMBER OFF A UNION ONE OF WHOSE ARMS IS A PROMISE THAT CANNOT
// HAVE IT.
//
// hono's `resolveCallback` reads `(str as HtmlEscapedString).callbacks` off a
// `string | HtmlEscapedString | Promise<string>` and immediately tests
// `!callbacks?.length`. The `as` names the arm the author means; the other two
// arms are expected to answer `undefined`, which is what the test is for.
//
// The string arm already answered that way -- `String.prototype`'s member set
// is modelled, so a name outside it is absent rather than unimplemented. The
// promise arm did not, and refused the whole union. A promise's member set is
// just as closed: ECMA-262 27.2.5 states `then`/`catch`/`finally`, the rest
// comes from `Object.prototype`, and this runtime's promise has no
// dynamic-property sidecar for anything else to arrive through.

interface Marked {
  readonly tags?: string[]
}

const tagsOf = (value: string | Marked | Promise<string>): number => {
  const tags = (value as Marked).tags
  return tags?.length ?? -1
}

//! expect: record=2
console.log('record=' + tagsOf({ tags: ['a', 'b'] }))

//! expect: string=-1
console.log('string=' + tagsOf('plain'))

//! expect: promise=-1
console.log('promise=' + tagsOf(Promise.resolve('deferred')))
