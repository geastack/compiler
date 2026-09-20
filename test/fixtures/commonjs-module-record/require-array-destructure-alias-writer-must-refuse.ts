export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'array-destructure' })
}

let run = () => {}
;[run] = [poison]
run()
require('./node_modules/conditional-choice/require')
