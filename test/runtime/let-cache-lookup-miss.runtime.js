// @ts-nocheck
//! expect: first x true
//! expect: again true
//! expect: other y false
// The cache idiom three's TSL swizzle getters run on every read:
// `let split = cache[key]; if (split === undefined) { split = new
// SplitNode(...); cache[key] = split }`. Only the filling write states a type,
// and joining it alone typed the cell as the filled value: the missed lookup
// unboxed `undefined` into it and aborted, and the guard folded to false.
class Split {
  constructor(key) {
    this.key = key
  }
}
/** @param {any} cache */
function lookup(cache, key) {
  let split = cache[key]
  if (split === undefined) {
    split = new Split(key)
    cache[key] = split
  }
  return split
}
const cache = JSON.parse('{}')
const first = lookup(cache, 'x')
console.log('first', first.key, first instanceof Split)
console.log('again', lookup(cache, 'x') === first)
const other = lookup(cache, 'y')
console.log('other', other.key, other === first)
