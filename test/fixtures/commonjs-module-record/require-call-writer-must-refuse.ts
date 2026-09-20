export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'call' })
  module.exports = { poisoned: true }
}

poison.call(undefined)
require('./node_modules/conditional-choice/require')
