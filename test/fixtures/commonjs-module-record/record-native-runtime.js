'use strict'

const createRecord = require('./record-callable-export')
const createRecordAgain = require('./record-callable-export')
if (createRecord !== createRecordAgain) throw new Error('callable export identity')
const record = createRecord(41)
if (record.value !== 41) throw new Error('callable export behavior')

const RecordBox = require('./record-constructor-export')
const RecordBoxAgain = require('./record-constructor-export')
if (RecordBox !== RecordBoxAgain) throw new Error('constructor export identity')
const box = new RecordBox(42)
if (box.value !== 42) throw new Error('constructor export behavior')

module.exports = { passed: true }
