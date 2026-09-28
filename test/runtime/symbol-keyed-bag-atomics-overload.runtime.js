// @ts-nocheck
//! dynamic-fallback
//! expect: 13
// thread-stream's shape: a symbol-keyed bag filled member by member, an
// Int32Array over its (possibly absent) SharedArrayBuffer member, and
// Atomics.load through an untyped receiver -- the census's Int32Array
// selects the number overload the checker could not.
const kImpl = Symbol('kImpl')
class Stream {
  constructor () {
    this[kImpl] = {}
    this[kImpl].stateBuf = new SharedArrayBuffer(8)
    this[kImpl].state = new Int32Array(this[kImpl].stateBuf)
    this[kImpl].data = new Uint8Array(16)
  }
}
function flush (stream) {
  Atomics.store(stream[kImpl].state, 1, 3)
  const writeIndex = Atomics.load(stream[kImpl].state, 1)
  const leftover = stream[kImpl].data.length - writeIndex
  return leftover
}
console.log(flush(new Stream()))
