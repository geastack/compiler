export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'define-properties-accessor' })
}

Object.defineProperties(Function.prototype, {
  apply: {
    configurable: true,
    get() {
      return poison
    }
  }
})
safe.apply(undefined, [])
require('./node_modules/conditional-choice/require')
