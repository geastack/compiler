// @ts-nocheck
//! expect: true false true false
// @fastify/proxy-addr's `Object.hasOwn(IP_RANGES, val)`: a computed key
// against a record's own fields.
const IP_RANGES = { linklocal: ['169.254.0.0/16'], loopback: ['127.0.0.1/8'] }
const has = (val) => Object.hasOwn(IP_RANGES, val)
console.log(has('loopback'), has('toString'), Object.hasOwn(IP_RANGES, JSON.parse('"linklocal"')), Object.hasOwn(IP_RANGES, JSON.parse('"x"')))
