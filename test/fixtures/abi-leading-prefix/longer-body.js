'use strict'
/**
 * @callback Handler
 * @param {string} value
 * @returns {string}
 */

/** @type {Handler} */
function two (value, suffix) { return value + suffix }

console.log(two('x'))
