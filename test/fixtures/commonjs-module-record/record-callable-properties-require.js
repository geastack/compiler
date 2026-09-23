'use strict'

const create = require('./record-callable-properties-export')
if (create(7).value !== 7) throw new Error('callable export with properties')

module.exports = { passed: true }
