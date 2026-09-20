'use strict'

function first(value) {
  return value
}

function second(value) {
  return value
}

module.exports = first
module.exports ||= second
