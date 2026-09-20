// @ts-nocheck
const table = { 0: 'zero', 1: 'one', 2: 'two', '01': 'noncanonical', [1e21]: 'large' }
/** @param {number|null|undefined} key */
function read(key) {
  return table[key] || 'missing'
}
console.log(read(1), read(2), read(-0), read(1e21))
console.log(read(17), read(NaN), read(Infinity), read(null), read(undefined))
table[1] = 'changed'
console.log(read(1), table['01'])
