export {}

function safe() {}

delete (Function.prototype as { bind?: unknown }).bind
safe.bind(undefined)()
require('./node_modules/conditional-choice/require')
