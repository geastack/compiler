'use strict'

const loaded = require('./record-lazy-loaded')
function never() {
  return require('./record-lazy-unrequired')
}
if (loaded.value !== 1) throw new Error('a required module runs when it is required')
if (typeof never !== 'function') throw new Error('never')

module.exports = { passed: true }
