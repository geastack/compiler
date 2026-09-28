// @ts-nocheck
//! dynamic-fallback
//! expect: 1 true 1 x true false undefined
// thread-stream's `stream[kImpl] = { ... }` over an object that came out of
// `JSON.parse`: a parsed object is an ordinary object, and a symbol key it is
// given is an own property like any other -- read back, tested, listed by
// Object.getOwnPropertySymbols and deleted -- though the string-keyed table
// that carries the parsed members cannot hold one.
const kImpl = Symbol('kImpl')
const parsed = JSON.parse('{"x":1}')
parsed[kImpl] = { calls: 1 }
const symbols = Object.getOwnPropertySymbols(parsed)
const read = parsed[kImpl].calls
const present = kImpl in parsed
const removed = delete parsed[kImpl]
console.log(read, present, symbols.length, Object.keys(parsed).join(','), removed, kImpl in parsed, parsed[kImpl])
