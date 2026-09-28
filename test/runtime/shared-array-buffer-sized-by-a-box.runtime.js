// @ts-nocheck
//! dynamic-fallback
//! expect: 16 4194304
// thread-stream's `new SharedArrayBuffer(opts.bufferSize || 4 * 1024 * 1024)`
// over options the program holds dynamically.
const make = (opts) => new SharedArrayBuffer(opts.bufferSize || 4 * 1024 * 1024)
console.log(make(JSON.parse('{"bufferSize":16}')).byteLength, make(JSON.parse('{}')).byteLength)
