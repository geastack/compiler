export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'nested-destructure' })
}

let run = () => {}
;({
  outer: { run }
} = { outer: { run: poison } })
run()
require('./node_modules/conditional-choice/require')
