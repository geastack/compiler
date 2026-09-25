export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'self-invocation-cycle' })
}

let run: any
run = run()
run()
require('./node_modules/conditional-choice/require')
