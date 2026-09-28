// @ts-nocheck
//! dynamic-fallback
//! expect: 2 true a 3
// ret's `writeSetTokens`/`reconstruct`: a `Map` the program built travels
// through a box (a property of a parsed object) and is read back where a
// `Map` is declared. The box's payload type is the Map's brand, and the Map
// read back is the same object: a write through it is seen by the original.
/** @type {Map<string, number>} */
const tokens = new Map()
tokens.set('a', 1)
tokens.set('b', 2)
const bag = JSON.parse('{}')
bag.tokens = tokens
/** @param {Map<string, number>} map */
function describe (map) {
  map.set('c', 3)
  return [map.size - 1, map.has('a'), [...map.keys()][0]].join(' ')
}
console.log(describe(bag.tokens), tokens.size)
