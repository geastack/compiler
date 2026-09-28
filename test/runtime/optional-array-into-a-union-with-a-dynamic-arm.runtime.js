// @ts-nocheck
//! dynamic-fallback
//! expect: 127.0.0.1/8,::1/128 none 10.0.0.0/8
// @fastify/proxy-addr's `compile(val)`: the parameter's statement makes its
// cell a string or a box, and `val = IP_RANGES[val]` stores a possibly-absent
// string array into it, which only the boxed arm can hold -- absent as the
// `undefined` it is, never dereferenced.
const RANGES = { loopback: ['127.0.0.1/8', '::1/128'] }
/** @param {Object|String} val */
function expand (val) {
  if (typeof val === 'string') val = RANGES[val]
  return val === undefined ? 'none' : val.join(',')
}
console.log(expand('loopback'), expand('unknown'), expand(JSON.parse('["10.0.0.0/8"]')))
