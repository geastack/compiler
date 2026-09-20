export {}

function safe() {
  module.exports = { safe: true }
}
const boundSafe = safe.bind(undefined)
const callbacks = { boundSafe }
declare function consume(value: unknown): void

boundSafe()
consume(callbacks)
module.exports = require('./node_modules/conditional-choice/require')
