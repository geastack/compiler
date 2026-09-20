export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'factory' })
}
function factory() {
  return { poison }
}
declare function consume(value: unknown): void

consume(factory())
require('./node_modules/conditional-choice/require')
