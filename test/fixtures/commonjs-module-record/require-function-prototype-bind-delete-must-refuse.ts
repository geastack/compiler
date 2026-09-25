export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'function-prototype-bind-delete' })
}

function safe() {}

delete (Function.prototype as { bind?: unknown }).bind
safe.bind(undefined)()
require('./node_modules/conditional-choice/require')
