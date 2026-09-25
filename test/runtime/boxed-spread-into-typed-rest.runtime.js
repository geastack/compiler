//! dynamic-fallback
//! expect: 2 9 Infinity
// @fastify/merge-json-schemas' `Math.min(...values)` over parsed JSON: a boxed
// spread drained through the iterator protocol into a `number` rest, each
// yielded box converted into the rest's element on the way in.
'use strict'
function minNumber (keyword, values, merged) {
  merged[keyword] = Math.min(...values)
}
function maxNumber (keyword, values, merged) {
  merged[keyword] = Math.max(...values)
}
const merged = {}
const values = JSON.parse('[4, 2, 9]')
minNumber('minimum', values, merged)
maxNumber('maximum', values, merged)
console.log(merged.minimum, merged.maximum, Math.min(...JSON.parse('[]')))
