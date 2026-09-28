// @ts-nocheck
//! dynamic-fallback
//! expect: 3 true 0f
// `new Array(n)` held dynamically (fast-uri's `const BYTE_HEX = new Array(256)`).
const table = new Array(3)
const hex = new Array(256)
for (let i = 0; i < 256; i++) hex[i] = (i < 16 ? '0' : '') + i.toString(16)
console.log(table.length, table[0] === undefined, hex[15])
