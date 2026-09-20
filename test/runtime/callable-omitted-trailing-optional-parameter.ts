//! expect: one a
//! expect: two b
// hono's `utils/url.ts` publishes its wide implementation through a narrower
// declared type:
//
//   export const getQueryParam: (url: string, key?: string) => ... = _getQueryParam as (...)
//
// `_getQueryParam` declares one more parameter than the slot -- a trailing
// OPTIONAL -- and a wider result. Calling through the slot omits that formal,
// which is the language's own rule for a declared-optional parameter, not an
// argument the adapter invents.
type Wide = string | string[]

const implementation = (label: string, key?: string, multiple?: boolean): string | Wide[] | undefined =>
  multiple === true ? [label, key ?? ''] : `${label} ${key ?? ''}`

const narrowed: (label: string, key?: string) => string | undefined = implementation as (label: string, key?: string) => string | undefined

console.log(narrowed('one', 'a') ?? 'absent')
console.log(narrowed('two', 'b') ?? 'absent')
