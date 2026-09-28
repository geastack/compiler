// @ts-nocheck
//! dynamic-fallback
//! expect: a-b-c a_b-c x.y
// A search value held in a box is a RegExp or a string by its own live type.
const table = JSON.parse('{}')
table.global = /,/g
table.first = ','
table.dot = 1
function swap(input, search, replacement) { return input.replace(search, replacement) }
console.log(swap('a,b,c', table.global, '-'), swap('a,b,c', table.first, '_').replace(table.first, '-'), 'x1y'.replace(table.dot, '.'))
