export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'callable-destructure-shadow' })
}

const { alias } = { alias: safe }
alias.bind = poison as typeof alias.bind
safe.bind(undefined)()
require('./node_modules/conditional-choice/require')
