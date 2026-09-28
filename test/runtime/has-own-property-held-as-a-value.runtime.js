// @ts-nocheck
//! dynamic-fallback
//! expect: a,b true false
//! expect: true true false
//! expect: {"p":3}
// `var has = Object.prototype.hasOwnProperty; has.call(o, k)` (dequal) and
// `Object.hasOwnProperty.call(o, k)` (rfdc): both test `o`, the this-argument.
var has = Object.prototype.hasOwnProperty
function keys (o) { const out = []; for (const k in o) if (has.call(o, k)) out.push(k); return out }
console.log(keys(JSON.parse('{"a":1,"b":2}')).join(','), has.call({ x: 1 }, 'x'), has.call({ x: 1 }, 'y'))
const o = JSON.parse('{"p":3}')
console.log(Object.hasOwnProperty.call(o, 'p'), Object.prototype.hasOwnProperty.call(o, 'p'), Object.hasOwnProperty.call(o, 'q'))
function copy (source) { const r = {}; for (const k in source) { if (Object.hasOwnProperty.call(source, k) === false) continue; r[k] = source[k] } return r }
console.log(JSON.stringify(copy(o)))
