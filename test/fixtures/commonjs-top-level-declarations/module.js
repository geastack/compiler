'use strict'
function noop () {}
const overridden = globalThis.hasOwnProperty('__override')
noop()
module.exports = { noop, overridden }
