'use strict'

/** @param {string} value */
function lateA(value) {
  return value
}

module.exports = lateA
require('./record-cycle-late-b')
