// @ts-nocheck
//
// A cell that starts as whatever a cache holds and is assigned `[]` when the
// cache misses: three's `RenderObject` `getKeys` (`let protoKeys =
// _protoKeysCache.get( obj.constructor )`, then `protoKeys = []` under
// `=== undefined`, then `protoKeys.push( key )`). Three things kept the
// literal and the cell on different element carriers:
//   - the literal was not a census candidate, because its contextual type is
//     the `any` the cell's initializer gave it, and nobody wrote that `any`;
//   - the push was not evidence, because its receiver is `never[] | undefined`
//     rather than a plain array;
//   - the cell laid out its `never[]` arm as an array that holds nothing,
//     while the literal carried the census's `string`.
// The conversion between the two refused. The cell's array arm now takes the
// census element and keeps its absent arm.
const cache = new Map()
function keysOf(name, source) {
  let keys = cache.get(name)
  if (keys === undefined) {
    keys = []
    for (const key in source) {
      if (typeof source[key] === 'number') keys.push(key)
    }
    cache.set(name, keys)
  }
  let total = ''
  for (let i = 0; i < keys.length; i++) total += keys[i]
  return total + ' ' + keys.length
}
console.log(keysOf('p', { x: 1, y: 'no', z: 3 }))
console.log(keysOf('p', { w: 4 }))
console.log(keysOf('q', { w: 4 }))
//! expect: xz 2
//! expect: xz 2
//! expect: w 1
