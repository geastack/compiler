'use strict'

const rebound = require('./record-exports-rebind-export')
if (rebound.list.length !== 1 || rebound.list[0] !== 'a') throw new Error('writes through the rebound exports')
if (rebound.names.first !== 'a') throw new Error('names')

module.exports = { passed: true }
