export {}

function safe() {}

const { bind: invoke } = safe
Reflect.deleteProperty(Function.prototype, 'bind')
invoke(undefined)()
require('./node_modules/conditional-choice/require')
