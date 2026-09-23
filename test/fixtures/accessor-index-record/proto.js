'use strict'
const { levelSym, cacheSym } = require('./symbols')
const prototype = {
  get level () { return this[levelSym] },
  set level (value) { this[levelSym] = value },
  [cacheSym]: {},
  [levelSym]: 'info'
}
function make () { return Object.create(prototype) }
module.exports = make
console.log(make().level)
