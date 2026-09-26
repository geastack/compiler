// @ts-nocheck
//! expect: 294 6 0
// three's `cyrb53( value )` (`nodes/core/NodeUtils.js`), reduced. `value` is
// untyped, so the checker says `any`; its callers make it `string | number[]`
// (a synthesized union). Under `Array.isArray( value )` the checker narrows
// the read to `any[]`, and under `typeof value === 'string'` to `string`: each
// read takes the arm its guard admits, so `value[ i ]` is an array element
// read and `value.charCodeAt( i )` a string method, not a read off the sum.
function total(value) {
  let sum = 0
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) sum += value[i]
  } else if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) sum += value.charCodeAt(i)
  }
  return sum
}
/** @param {string} text @return {number} */
const ofString = (text) => total(text)
/** @param {Array<number>} array @return {number} */
const ofArray = (array) => total(array)
console.log(ofString('abc'), ofArray([1, 2, 3]), ofArray([]))
