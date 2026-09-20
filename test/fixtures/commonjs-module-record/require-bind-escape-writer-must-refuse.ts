export {}

const poison = () => {
  require = (_specifier: string) => ({ poisoned: 'bound-escape' })
}
const boundPoison = poison.bind(undefined)
const callbacks = { boundPoison }
declare function consume(value: unknown): void

consume(callbacks)
require('./node_modules/conditional-choice/require')
