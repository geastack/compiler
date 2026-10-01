'use strict'

exports = module.exports = {}
const list = (exports.list = /** @type {string[]} */ ([]))
let count = 0
const add = (/** @type {string} */ value) => {
  list[count++] = value
}
add('a')
exports.names = { first: 'a' }
