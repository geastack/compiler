// @ts-nocheck
//! expect: info a 2
//! expect: warn b 1
// pino's `genLog`: the logger is either `LOG(o, ...n)` or, with a hook,
// `hookWrappedLog(...args)`, and both are called through one convention.
// Calling the second with `(o, ...n)` is calling it with the whole argument
// list, so its own rest Array is `o` followed by every element of `n`.
function genLog (level, hook) {
  if (!hook) return LOG
  return function hookWrappedLog (...args) {
    hook.call(this, args, LOG, level)
  }
  function LOG (o, ...n) {
    console.log(this.prefix + level, o, n.length)
  }
}
const plain = genLog('info')
const hooked = genLog('warn', function (args, method) {
  method.apply(this, args)
})
const logger = { prefix: '', plain, hooked }
logger.plain('a', 1, 2)
logger.hooked('b', 3)
