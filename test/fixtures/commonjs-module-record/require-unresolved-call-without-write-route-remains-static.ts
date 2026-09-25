export {}

declare function consume(value: unknown): void
declare const plugins: { readonly run: () => void }[]

function load() {
  for (const plugin of plugins) plugin.run()
  consume(() => undefined)
  return require('./node_modules/conditional-choice/require')
}
module.exports = load()
