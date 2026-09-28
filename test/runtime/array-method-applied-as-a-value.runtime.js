// @ts-nocheck
//! dynamic-fallback
//! expect: a,x,y,c 4
// @fastify/proxy-addr's `trust.splice.apply(trust, [i, 1].concat(val))`: the
// method read as a value is Array.prototype's one function object.
const trust = ['a', 'b', 'c']
const val = ['x', 'y']
trust.splice.apply(trust, [1, 1].concat(val))
console.log(trust.join(','), trust.length)
