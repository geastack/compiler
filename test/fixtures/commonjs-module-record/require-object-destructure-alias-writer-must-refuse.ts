export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'object-destructure' })
}

let run = () => {}
;({ run } = { run: poison })
run()
require('./node_modules/conditional-choice/require')
