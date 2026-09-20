// @ts-nocheck
// JavaScript property keys may extend the written numeric index signature.
/** @type {Record<number, string>} */
const table = { 1: 'one' }

/** @param {number|string|null|undefined|boolean} key @param {string} value */
function update(key, value) {
  console.log(key in table, table.hasOwnProperty(key))
  table[key] = value
  console.log(table[key], table.hasOwnProperty(key))
  console.log(delete table[key], key in table)
}

update(undefined, 'undefined-key')
update(null, 'null-key')
update('01', 'noncanonical-key')
update(true, 'boolean-key')
console.log(table[1])
