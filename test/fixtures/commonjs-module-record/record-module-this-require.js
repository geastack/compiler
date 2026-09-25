'use strict'

const record = require('./record-module-this-export')
const answer = require('./record-module-this-callable-export')
if (record.merged.a !== 1 || record.merged.b !== 2) throw new Error('module this helper')
if (!record.initialIsExports) throw new Error('module this is the initial exports object')
if (!record.arrowSeesModule) throw new Error('a module-level arrow closes over module this')
if (answer() !== 42 || !answer.thisIsInitialExports) throw new Error('module this outlives replacing module.exports')

module.exports = { passed: true }
