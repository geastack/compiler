export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'destructured-bind-global-taint' })
}

function safe() {}

const { bind: invoke } = safe
Reflect.deleteProperty(Function.prototype, 'bind')
invoke(undefined)()
require('./node_modules/conditional-choice/require')
