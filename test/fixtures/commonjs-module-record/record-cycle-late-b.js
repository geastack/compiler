'use strict'

const reenteredA = require('./record-cycle-late-a')
if (reenteredA('cycle') !== 'cycle') throw new Error('late cycle export identity')

/** @param {string} value */
function lateB(value) {
  return value
}

module.exports = lateB
