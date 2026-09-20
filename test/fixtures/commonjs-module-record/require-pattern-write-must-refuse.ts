export {}

var { require } = { require: (_specifier: string) => ({ replaced: true }) }
require('./node_modules/conditional-choice/require')

for (var require of [(_specifier: string) => ({ loop: true })]) {
  require('./node_modules/conditional-choice/require')
}
