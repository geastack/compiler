// @ts-nocheck
//! expect: 5059922895146125 4235446385759781 2789436338366766 3338908027751811
// three's `cyrb53( value, seed = 0 )` (`nodes/core/NodeUtils.js`): the
// untyped `value` is `string | number[]` from its callers, and the read under
// `Array.isArray( value )` is `any[]` to the checker. The default-only rule
// for synthesized unions ("a read typed as its declaration is the whole
// cell") must not take that read for un-narrowed just because its declaration
// is `any`, which every type is assignable to both ways: `value[ i ]` keeps
// its array arm, not a computed read off the sum. (The else arm is guarded
// here because an unguarded `value.charCodeAt` off the whole union is a
// separate, older refusal in a standalone program.)
function cyrb53(value, seed = 0) {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed
  if (Array.isArray(value)) {
    for (let i = 0, val; i < value.length; i++) {
      val = value[i]
      h1 = Math.imul(h1 ^ val, 2654435761)
      h2 = Math.imul(h2 ^ val, 1597334677)
    }
  } else if (typeof value === 'string') {
    for (let i = 0, ch; i < value.length; i++) {
      ch = value.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}
/** @param {string} str @return {number} */
const hashString = (str) => cyrb53(str)
/** @param {Array<number>} array @return {number} */
const hashArray = (array) => cyrb53(array)
/** @param {...number} params @return {number} */
const hash = (...params) => cyrb53(params)
console.log(hashString('abc'), hashArray([1, 2, 3]), hash(4, 5), hashString(''))
