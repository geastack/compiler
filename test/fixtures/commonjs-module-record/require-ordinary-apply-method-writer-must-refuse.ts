export {}

const ordinary = {
  apply() {
    require = (_specifier: string) => ({ poisoned: 'ordinary-apply' })
  }
}

ordinary.apply()
require('./node_modules/conditional-choice/require')
