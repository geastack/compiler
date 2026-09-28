// @ts-nocheck
//! dynamic-fallback
//! expect: ctx x undefined 1
// fastify's `reply.request[kRouteContext] = ...` over a request held as a
// string-keyed table: symbol-keyed properties live beside the table.
const kRouteContext = Symbol('fastify.context')
const kSignal = Symbol('signal')
/** @type {{ request: { [key: string]: string } }} */
const reply = { request: {} }
const key = JSON.parse('"name"')
reply.request[key] = 'x'
reply.request[kRouteContext] = 'ctx'
console.log(reply.request[kRouteContext], reply.request[key], reply.request[kSignal], Object.keys(reply.request).length)
