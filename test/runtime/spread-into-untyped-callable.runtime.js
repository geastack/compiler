// @ts-nocheck
//! expect: THREE.first 1 two
//! expect: sink log|THREE.second|3|four|true
//! expect: sink warn|THREE.third|9
// three's `utils.js` `log`/`warn`: `_setConsoleFunction('log', message,
// ...params)` spreads into a `Function`-typed value, which states no frame,
// and `console.log(message, ...params)` mixes a fixed argument with a spread
// into a host member rendered as text. Both are the flat argument list the
// language builds, spread in place.

/** @type {Function|null} */
let _setConsoleFunction = null

/** @param {Function} fn */
function setConsoleFunction(fn) {
  _setConsoleFunction = fn
}

/** @param {...any} params */
function log(...params) {
  const message = 'THREE.' + params.shift()
  if (_setConsoleFunction) {
    _setConsoleFunction('log', message, ...params)
  } else {
    console.log(message, ...params)
  }
}

/** @param {...any} params */
function warn(...params) {
  const message = 'THREE.' + params.shift()
  if (_setConsoleFunction) _setConsoleFunction('warn', message, ...params)
}

log('first', 1, 'two')
setConsoleFunction((type, message, ...rest) => {
  console.log('sink ' + [type, message, ...rest].join('|'))
})
log('second', 3, 'four', true)
warn('third', 9)

