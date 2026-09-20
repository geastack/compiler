export {}

const poison = () => {
  require = (_specifier: string) => ({ poisoned: 'mutated-container' })
}
const callbacks: { poison?: () => void } = {}
callbacks.poison = poison
declare function consume(value: unknown): void

consume(callbacks)
require('./node_modules/conditional-choice/require')
