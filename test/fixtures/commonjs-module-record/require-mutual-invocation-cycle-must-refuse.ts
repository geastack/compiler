export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'mutual-invocation-cycle' })
}

let left: any
let right: any
left = right()
right = left()
left()
require('./node_modules/conditional-choice/require')
