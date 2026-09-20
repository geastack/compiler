export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'destructured-apply-global-taint' })
}

const { apply: invoke } = safe
Reflect.set(Function.prototype, 'apply', poison)
invoke(undefined, [])
require('./node_modules/conditional-choice/require')
