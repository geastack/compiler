export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'assign-accessor' })
}

Object.assign(Function.prototype, {
  get call() {
    return poison
  }
})
safe.call(undefined)
require('./node_modules/conditional-choice/require')
