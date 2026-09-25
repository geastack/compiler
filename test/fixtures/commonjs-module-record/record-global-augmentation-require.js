'use strict'

const logger = require('./record-global-augmentation-export')
if (typeof logger !== 'object') throw new Error('a getter-installed export')
const RecordBox = require('./record-constructor-export')
const box = new RecordBox(42)
if (box.value !== 42) throw new Error('constructor export behavior')

module.exports = { passed: true }
