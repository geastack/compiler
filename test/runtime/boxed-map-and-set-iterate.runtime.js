// @ts-nocheck
//! dynamic-fallback
//! expect: true false true false true false
// A Map or Set a recursive comparison holds in a box iterates through the box
// (`for...of` over its entries or items), and its `constructor` is the global
// of that name -- the shape of dequal, which fastify's schema resolution uses.
function same (left, right) {
  let ctor, item, other
  if (left === right) return true
  if (left && right && (ctor = left.constructor) === right.constructor) {
    if (ctor === Array) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index++) if (!same(left[index], right[index])) return false
      return true
    }
    if (ctor === Set) {
      if (left.size !== right.size) return false
      for (item of left) if (!right.has(item)) return false
      return true
    }
    if (ctor === Map) {
      if (left.size !== right.size) return false
      for (item of left) {
        other = item[0]
        if (!right.has(other) || !same(item[1], right.get(other))) return false
      }
      return true
    }
  }
  return false
}
console.log(
  same(new Map([['k', [1, 2]]]), new Map([['k', [1, 2]]])),
  same(new Map([['k', 1]]), new Map([['k', 2]])),
  same(new Set([1, 2]), new Set([2, 1])),
  same(new Set([1]), new Set([3])),
  same([new Set(['a'])], [new Set(['a'])]),
  same([1], [2])
)
