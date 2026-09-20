export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'prototype-alias-write' })
}

const prototypeAlias = Function.prototype
prototypeAlias.call = poison as typeof prototypeAlias.call
safe.call(undefined)
require('./node_modules/conditional-choice/require')
