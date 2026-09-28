// @ts-nocheck
//! dynamic-fallback
//! expect: 10,20,1,2,Infinity
// pino's `[].concat(Object.keys(customLevels || {}).map(key => customLevels[key]), ...)`:
// the mapped array enters a boxed argument list.
const customLevels = JSON.parse('{"a":10,"b":20}')
const nums = { 1: 'x', 2: 'y' }
const values = [].concat(
  Object.keys(customLevels || {}).map((key) => customLevels[key]),
  Object.keys(nums).map((level) => +level),
  Infinity
)
console.log(values.join(','))
