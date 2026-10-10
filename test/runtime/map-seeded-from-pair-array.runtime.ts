// `new Map(entries)` over an Array of `[K, V]` tuples -- a database client's sort
// converters (`new Map(sortEntries)` with `sortEntries: [string, number][]`).
// A later duplicate key overwrites an earlier one, in insertion position.
type Pair = [string, number]
const entries: Pair[] = [
  ['a', 1],
  ['b', -1],
  ['a', 3]
]
const map = new Map(entries)
console.log(map.size, map.get('a'), map.get('b'), [...map.keys()].join(','))
const widened = new Map<string, number | string>(entries)
console.log(widened.get('a'))

//! expect: 2 3 -1 a,b
//! expect: 3
