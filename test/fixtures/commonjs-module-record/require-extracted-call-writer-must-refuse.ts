export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'extracted-call' })
}

const invoke = poison.call
invoke(undefined)
require('./node_modules/conditional-choice/require')
