'use strict'

const lib = require('./record-module-this-umd-export')
if (lib.parse(21).double() !== 42) throw new Error('umd export')
if (!lib.rootWasEmpty) throw new Error('module this is the initial exports object')

module.exports = { passed: true }
