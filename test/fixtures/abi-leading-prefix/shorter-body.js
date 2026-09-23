'use strict'
/**
 * @callback Handler
 * @param {string} value
 * @param {string} suffix
 * @returns {string}
 */

/** @type {Handler} */
function one (value) { return value + '!' }

console.log(one('x', '?'))
