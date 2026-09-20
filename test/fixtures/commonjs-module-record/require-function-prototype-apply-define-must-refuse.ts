export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'prototype-apply-define' })
}

Object.defineProperty(Function.prototype, 'apply', { value: poison, configurable: true })
safe.apply(undefined, [])
require('./node_modules/conditional-choice/require')
