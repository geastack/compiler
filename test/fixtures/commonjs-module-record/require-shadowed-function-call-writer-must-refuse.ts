export {}

function callable() {}
callable.call = () => {
  require = (_specifier: string) => ({ poisoned: 'shadowed-function-call' })
}

callable.call()
require('./node_modules/conditional-choice/require')
