export {}

const poison = () => {
  require = (_specifier: string) => ({ poisoned: 'apply' })
}

poison.apply(undefined, [])
require('./node_modules/conditional-choice/require')
