export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'direct-container' })
}

const callbacks: { poison?: () => void } = {}
callbacks.poison = poison
callbacks.poison()
require('./node_modules/conditional-choice/require')
