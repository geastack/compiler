/// <reference lib="es2024.sharedmemory" />
//! expect: false not-equal false timed-out true
//! expect: woken 1
//! expect: pending ok
// `Atomics.waitAsync` as lib.es2024.sharedmemory types it: a union of the
// outcome it did not wait for and a pending promise, discriminated by
// `async`. The runtime's outcome builds whichever arm is live, and `notify`
// settles the pending one.
const state = new Int32Array(new SharedArrayBuffer(16))
const notEqual = Atomics.waitAsync(state, 0, 1)
const immediate = Atomics.waitAsync(state, 0, 0, 0)
const pending = Atomics.waitAsync(state, 1, 0)
console.log(notEqual.async, notEqual.value, immediate.async, immediate.value, pending.async)
if (pending.async) pending.value.then((outcome) => console.log('pending', outcome))
console.log('woken', Atomics.notify(state, 1))
