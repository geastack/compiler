'use strict'

const qs = require('./record-callable-field-rewrite-export')
if (qs.parse('abc') !== 3 || qs.stringify(4) !== '4') throw new Error('callable fields written through the exports box')

module.exports = { passed: true }
