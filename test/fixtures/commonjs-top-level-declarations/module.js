'use strict'
function noop () {}
Object.assign(globalThis, JSON.parse('{}'))
noop()
module.exports = { noop }
