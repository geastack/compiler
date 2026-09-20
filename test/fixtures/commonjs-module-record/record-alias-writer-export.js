'use strict'

function first(value) {
  return value
}

function second(value) {
  return value
}

module.exports = first
const moduleAlias = module
moduleAlias.exports = second
