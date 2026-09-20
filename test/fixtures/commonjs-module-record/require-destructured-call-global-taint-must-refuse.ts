export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'destructured-call-global-taint' })
}

const { call: invoke } = safe
Function.prototype.call = poison as typeof Function.prototype.call
invoke(undefined)
require('./node_modules/conditional-choice/require')
