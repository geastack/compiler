//! expect: GET / 1 true
//! expect: POST fastify 2
//! expect: {"url":"/x","prefixing":true}
// A source whose members the static spread cannot list -- a method member is
// indistinguishable from a prototype method in the shape -- copies at run
// time, into a literal laid out as a record. fastify's `route({ options })`
// writes `const opts = { ...options }` over a route options record.
'use strict'
const options = { method: 'GET', url: '/', handler () { return 1 } }
const copy = { ...options }
console.log(copy.method, copy.url, copy.handler(), copy.handler === options.handler)
const withLater = { ...options, method: 'POST', handler () { return 2 }, owner: 'fastify' }
console.log(withLater.method, withLater.owner, withLater.handler())
/** @param {{ url: string, prefixing?: boolean }} route */
function addNewRoute ({ url, prefixing = false }) {
  const config = { url, prefixing }
  return JSON.stringify({ ...config })
}
console.log(addNewRoute({ url: '/x', prefixing: true }))
