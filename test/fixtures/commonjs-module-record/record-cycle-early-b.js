'use strict'

require('./record-cycle-early-a')

/** @param {string} value */
function earlyB(value) {
  return value
}

module.exports = earlyB
