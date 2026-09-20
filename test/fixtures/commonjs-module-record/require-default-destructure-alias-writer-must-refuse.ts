export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'default-destructure' })
}

let run = () => {}
;({ run = poison } = {})
run()
require('./node_modules/conditional-choice/require')
