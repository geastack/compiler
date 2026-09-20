// `Array.isArray(x) ? x[0] : x` -- the one-or-many normalization that
// `@hono/node-server`'s `createUpgradeRequest` and hono's trie router both
// write, over a type NO constituent of which is assignable to `any[]`:
//
//   headers.append(key, Array.isArray(value) ? value[0] : value)   // value: string
//   const key = Array.isArray(pattern) ? pattern[0] : p            // Pattern = readonly [...] | '*'
//
// `Array.isArray`'s `lib.es5.d.ts` signature is `arg is any[]`, and when the
// narrowing finds nothing to keep TypeScript falls back to the INTERSECTION
// `T & any[]` and types the element read `any`. That `any` is a checker
// artifact of a failed narrowing, not a dynamic boundary the program declared:
// the value is a `std::string` or a fixed tuple and the read has a stated
// answer either way. Carried as `dynamic` it reached the String index read as
// a result the backend has no absence materialization for, and boxing the code
// unit to make it compile would be the forbidden shortcut.
//
// The narrowing states one thing -- the value is an array here -- so the arm's
// honest type is the array/tuple constituents of `T`, and where there are none
// (a primitive: `Array.isArray` of a string is statically false) the arm is
// dead and the value keeps the carrier it already had.

// `IncomingMessage['headers']` in this repo's node shim is `{ [name: string]:
// string }`, so `value` is a plain `string` and the true arm never runs.
const firstHeaderValue = (value: string): string => {
  return Array.isArray(value) ? value[0] : value
}

//! expect: h=abc
console.log('h=' + firstHeaderValue('abc'))

// The router's shape: a readonly tuple beside a string-literal arm. Neither is
// assignable to `any[]` (a `readonly` tuple is not), so the same fallback
// fires and the tuple read -- which has an exact element type -- came back
// `any` as well.
//
// `k=:id` also pins the SECOND defect this shape hides, which only shows once
// the read emits at all: a closed tuple is laid out as a record, `record` is
// among the kinds `Array.isArray` answers `false` for from the kind alone, and
// the whole predicate folded to `false` at compile time -- so the tuple arm
// was unreachable in the emitted program and hono's router would have
// registered no parameterized route at all. See `isTupleShape`.
type RoutePattern = readonly [string, string, boolean] | '*'

const patternKey = (pattern: RoutePattern, fallback: string): string => {
  return Array.isArray(pattern) ? pattern[0] : fallback
}

//! expect: k=:id
console.log('k=' + patternKey([':id', 'id', true], 'p'))
//! expect: k=p
console.log('k=' + patternKey('*', 'p'))
