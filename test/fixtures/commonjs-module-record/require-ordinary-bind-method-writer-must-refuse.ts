export {}

const ordinary = {
  bind() {
    require = (_specifier: string) => ({ poisoned: 'ordinary-bind' })
  }
}

ordinary.bind()
require('./node_modules/conditional-choice/require')
