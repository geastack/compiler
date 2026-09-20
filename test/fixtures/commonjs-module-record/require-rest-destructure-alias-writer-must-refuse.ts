export {}

function poison() {
  require = (_specifier: string) => ({ poisoned: 'rest-destructure' })
}

let writers: Array<() => void> = []
;[...writers] = [poison]
writers[0]!()
require('./node_modules/conditional-choice/require')
