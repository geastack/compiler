export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'bound-call' })
}

const boundPoison = poison.bind(undefined)
boundPoison()
require('./node_modules/conditional-choice/require')
