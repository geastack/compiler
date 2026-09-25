//! dynamic-fallback
//! expect: L 3 a|1|2
//! expect: L 1 b
//! expect: 1 2
//! expect: undefined 0
// One calling convention, two C++ frames: a function taking one rest array
// held where leading parameters come first (node's util.debuglog result typed
// by avvio's JSDoc callback), and a function with a leading box before its rest
// held where a single rest array is declared (pino's level methods).
'use strict'
/**
 * @callback Logger
 * @param {string} msg
 * @param {...unknown} rest
 * @returns {void}
 */
/**
 * @param {string} prefix
 * @returns {(...args: unknown[]) => void}
 */
function make(prefix) {
  return (...args) => console.log(prefix, args.length, args.join('|'))
}
/** @type {Logger} */
const log = make('L')
log('a', 1, 2)
log('b')
/** @type {(...args: any[]) => void} */
const spread = function (first, ...rest) {
  console.log(String(first), rest.length)
}
spread(1, 2, 3)
spread()
