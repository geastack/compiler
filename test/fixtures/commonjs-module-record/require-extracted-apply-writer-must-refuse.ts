export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'extracted-apply' })
}

const invoke = poison.apply
invoke(undefined, [])
require('./node_modules/conditional-choice/require')
