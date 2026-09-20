export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'prototype-computed-write' })
}

const key: 'call' | 'other' = Math.random() > 0.5 ? 'call' : 'other'
;(Function.prototype as unknown as Record<string, unknown>)[key] = poison
safe.call(undefined)
require('./node_modules/conditional-choice/require')
