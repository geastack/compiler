export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'extracted-bind' })
}

const bind = poison.bind
bind(undefined)()
require('./node_modules/conditional-choice/require')
