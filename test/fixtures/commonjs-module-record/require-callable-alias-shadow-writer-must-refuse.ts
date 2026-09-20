export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'callable-alias-shadow' })
}

const aliasOne = safe
const aliasTwo = aliasOne
aliasTwo.call = poison as typeof aliasTwo.call
safe.call(undefined)
require('./node_modules/conditional-choice/require')
