'use strict'

/** @param {string} s */
function parse(s) {
  return s.length
}
/** @param {number} n */
function stringify(n) {
  return String(n)
}
const qs = { parse, stringify }
module.exports = qs
module.exports.parse = parse
module.exports.stringify = stringify
