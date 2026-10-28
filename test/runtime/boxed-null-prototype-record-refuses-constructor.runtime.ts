// `Object.create(null)` fills a record carrier with a value-initialized
// struct, the same C++ type an object literal of that shape allocates. Its
// prototype is null, so `constructor` reads `undefined` in JavaScript; the
// struct alone cannot say which allocation it came from, so the read stops
// rather than answering %Object% for it.
//! expect: before
//! expect-abort
const options: { a?: number } = Object.create(null)
const held: any = options
console.log('before')
console.log(held.constructor)
export {}
