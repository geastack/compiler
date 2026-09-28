// @ts-nocheck
//! dynamic-fallback
//! expect: 4 a,1|a,2|b,1|b,2
// @fastify/merge-json-schemas' `cartesianProduct`: `let result = [[]]` is a
// cell later assigned an array of anything, so the fresh `[[]]` is laid out
// as that cell's array.
function cartesianProduct (arrays) {
  let result = [[]]
  for (const array of arrays) {
    const temp = []
    for (const x of result) {
      for (const y of array) temp.push([...x, y])
    }
    result = temp
  }
  return result
}
const product = cartesianProduct([['a', 'b'], ['1', '2']])
const joined = []
for (const pair of product) joined.push(pair.join(','))
console.log(product.length, joined.join('|'))
