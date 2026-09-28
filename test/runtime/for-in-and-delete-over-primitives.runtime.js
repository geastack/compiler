// @ts-nocheck
'use strict'
//! expect: 0 0 0 true true TypeError
// fastify's generated config validator walks `for (const k in data10)` and
// runs `delete data10[k]` over a cell its coercions may leave `true`, `null`
// or a number. A primitive enumerates nothing -- ToObject's wrapper owns no
// enumerable key and neither does its prototype -- an absent one enumerates
// nothing either, and `delete` on a present primitive is `true` while on an
// absent one ToObject throws.
const flags = [true, false]
const count = (value) => {
  let seen = 0
  for (const key in value) seen += key.length
  return seen
}
let cell = flags[0] ? true : null
const number = flags.length * 3
const counts = [count(cell), count(number), count(flags[1] ? 1 : null)]
const deleted = [delete cell.anything, delete number[String(number)]]
let thrown = 'none'
cell = null
try {
  delete cell.anything
} catch (error) {
  thrown = error.name
}
console.log(counts.join(' '), deleted.join(' '), thrown)
