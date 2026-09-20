export {}

function safe() {}
function poison() {
  require = (_specifier: string) => ({ poisoned: 'mutable-alias' })
}

let run = safe
run = poison
run()
require('./node_modules/conditional-choice/require')
