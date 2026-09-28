//! expect: 3 2 c undefined
// `new Map([[k, v], ...])` (ECMA-262 AddEntriesFromIterable): each entry's
// key and value, in order, a later entry for a key replacing an earlier one.
const scores = new Map<string, number>([
  ['a', 1],
  ['b', 2],
  ['c', 3],
  ['b', 2]
])
const keys = [...scores.keys()]
console.log(scores.size, scores.get('b'), keys[keys.length - 1], scores.get('z'))
