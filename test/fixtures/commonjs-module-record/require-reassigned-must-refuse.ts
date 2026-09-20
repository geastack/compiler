export {}

const load = require
require = (_specifier: string) => ({ replaced: true })

// The const alias snapshots Node's original loader before the write and remains
// statically dispatchable. Only the direct call must fail closed because the
// wrapper cell no longer denotes Node's loader.
load('./node_modules/conditional-choice/require')
require('./node_modules/conditional-choice/require')
