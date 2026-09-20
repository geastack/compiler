export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'prototype-call-write' })
}

Function.prototype.call = poison as typeof Function.prototype.call
safe.call(undefined)
require('./node_modules/conditional-choice/require')
