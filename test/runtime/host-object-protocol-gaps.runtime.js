//! dynamic-fallback
//! expect: hi true 1 true
//! expect: 10 0 10
//! expect: E: m|E: m
//! expect: false false true false
// Host object protocol members fastify's dependency graph reaches:
// `Object.setPrototypeOf` over boxed objects, V8's stack-trace controls on a
// target that records no frames, `instanceof` against host constructors for
// primitive, boxed-array and plain-object operands, and `console.warn`.
'use strict'
const base = Object.create(null)
base.greet = 'hi'
const child = Object.create(null)
Object.setPrototypeOf(child, base)
const table = Object.create(null)
table.http = 1
Object.setPrototypeOf(table, null)
console.log(child.greet, Object.getPrototypeOf(table) === null, table.http, Object.getPrototypeOf(child) === base)
const limit = Error.stackTraceLimit
Error.stackTraceLimit = 0
const zero = Error.stackTraceLimit
const failure = Object.create(null)
failure.name = 'E'
failure.message = 'm'
Error.captureStackTrace(failure)
Error.stackTraceLimit = limit
console.log(limit, zero, Error.stackTraceLimit)
console.log(failure.stack + '|' + String(failure.stack).split('\n')[0])
const parsed = JSON.parse('[[1], "x"]')
const nothing = undefined
console.log(nothing instanceof Function, 'text' instanceof Object, parsed[0] instanceof Array, parsed[1] instanceof Array)
console.warn('warned')
