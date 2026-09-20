export {}

const poison = () => {
  require = (_specifier: string) => ({ poisoned: 'container' })
}
const callbacks = { poison }
declare function consume(value: unknown): void

consume(callbacks)
require('./node_modules/conditional-choice/require')
