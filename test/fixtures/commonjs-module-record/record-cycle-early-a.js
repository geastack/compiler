'use strict'

require('./record-cycle-early-b')

/** @param {string} value */
function earlyA(value) {
  return value
}

module.exports = earlyA
