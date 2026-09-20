export {}

const ordinary = {
  call() {
    require = (_specifier: string) => ({ poisoned: 'ordinary-call' })
  }
}

ordinary.call()
require('./node_modules/conditional-choice/require')
