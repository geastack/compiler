export {}

function safe() {
  module.exports = { safe: true }
}
function safeFactory() {
  return { safe }
}
const callbacks: { safe?: () => void } = {}
callbacks.safe = safe
declare function consume(value: unknown): void

safe.call(undefined)
safe.apply(undefined, [])
consume(callbacks)
consume(safeFactory())
module.exports = require('./node_modules/conditional-choice/require')
