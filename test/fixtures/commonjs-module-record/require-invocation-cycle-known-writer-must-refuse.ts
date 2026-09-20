export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'cycle-known-writer' })
}

let run: any
run = run()
run = poison
run()
require('./node_modules/conditional-choice/require')
